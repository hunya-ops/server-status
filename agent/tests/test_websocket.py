import base64
import hashlib
import importlib.util
import io
import json
import pathlib
import struct
import unittest
from unittest.mock import MagicMock, patch

spec = importlib.util.spec_from_file_location("status_agent_ws", pathlib.Path(__file__).parents[1] / "status_agent.py")
agent = importlib.util.module_from_spec(spec)
spec.loader.exec_module(agent)


def frame(data, opcode=1):
    payload = json.dumps(data).encode() if isinstance(data, dict) else data
    return bytes([0x80 | opcode, len(payload)]) + payload


class WebSocketTests(unittest.TestCase):
    def tearDown(self):
        agent.STOP.clear()

    def test_handshake_authenticates_in_headers_once_and_samples_use_masked_frames(self):
        key = base64.b64encode(b"a" * 16).decode()
        accept = base64.b64encode(hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()).decode()
        response = ("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + accept + "\r\n\r\n").encode()
        sock = MagicMock()
        sock.makefile.return_value = io.BytesIO(response + frame({"type":"ready","interval":5}) + frame(b"ping", 9) + frame({"type":"ack","accepted":True}))
        config = {"endpoint":"http://localhost/api/ingest","serverId":"alpha","token":"t"*64}
        with patch.object(agent.socket, "create_connection", return_value=sock), patch.object(agent.os,"urandom",side_effect=lambda n:b"a"*n):
            ws = agent.WebSocket(config)
            result = ws.send({"serverId":"alpha","collectedAt":1000})
        self.assertTrue(result["accepted"])
        handshake = sock.sendall.call_args_list[0].args[0]
        self.assertTrue(handshake.startswith(b"GET /api/agent/connect HTTP/1.1\r\n"))
        self.assertNotIn(b"?", handshake)
        self.assertIn(b"Authorization: Bearer " + b"t"*64,handshake)
        sample = sock.sendall.call_args_list[1].args[0]
        self.assertTrue(sample[1] & 0x80)
        self.assertNotIn(b"t"*64, sample)
        ws.close()
        sock.close.assert_called_once()

    def test_invalid_token_closes_transport_without_forwarding_redirects(self):
        for status in [401,403,302]:
            sock=MagicMock();sock.makefile.return_value=io.BytesIO(f"HTTP/1.1 {status} Rejected\r\n\r\n".encode())
            with patch.object(agent.socket,"create_connection",return_value=sock):
                with self.assertRaises(agent.Unauthorized if status in (401,403) else ValueError):
                    agent.WebSocket({"endpoint":"http://localhost/api/ingest","serverId":"alpha","token":"t"*64})
            sock.close.assert_called_once()

    def test_disconnect_and_worker_restart_reconnect_then_resume(self):
        connection=MagicMock();connection.interval=5
        def sent(_):
            agent.STOP.set()
            return {"type":"ack","interval":5}
        connection.send.side_effect=sent
        connect=MagicMock(side_effect=[OSError("restart"),connection])
        with patch.object(agent,"collect",return_value={"serverId":"alpha"}), patch.object(agent.STOP,"wait",return_value=False) as wait:
            agent.run({"serverId":"alpha","interval":5},connect=connect)
        self.assertEqual(connect.call_count,2)
        self.assertGreater(wait.call_args_list[0].args[0],0)
        connection.close.assert_called_once()

    def test_rejected_credentials_use_bounded_backoff(self):
        def pause(delay):
            self.assertGreaterEqual(delay,30)
            self.assertLessEqual(delay,60)
            agent.STOP.set()
        with patch.object(agent.STOP,"wait",side_effect=pause):
            agent.run({"serverId":"alpha","interval":5},connect=MagicMock(side_effect=agent.Unauthorized()))

    def test_oversized_payload_is_never_sent(self):
        ws=agent.WebSocket.__new__(agent.WebSocket);ws.sock=MagicMock()
        with self.assertRaises(ValueError):
            ws.frame(b"a"*32769)
        ws.sock.sendall.assert_not_called()

    def test_exponential_backoff_has_jitter_and_cap(self):
        with patch.object(agent.random,"uniform",return_value=1):
            self.assertEqual([agent.reconnect_delay(n) for n in (0,1,2,20)],[1,2,4,60])
        with patch.object(agent.random,"uniform",return_value=0.5):
            self.assertEqual(agent.reconnect_delay(20),30)
