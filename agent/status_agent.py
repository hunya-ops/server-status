#!/usr/bin/env python3
"""Linux metrics collector. Python 3 standard library only."""

import base64
import hashlib
import random
import ssl
import struct
import argparse
import json
import logging
import os
import platform
import re
import signal
import socket
import stat
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

STOP = threading.Event()
REAL_FILESYSTEMS = {"ext2", "ext3", "ext4", "xfs", "btrfs", "zfs", "f2fs", "bcachefs", "jfs", "reiserfs", "ntfs", "ntfs3", "vfat", "exfat"}


def read_cpu(path="/proc/stat"):
    with open(path, encoding="utf-8") as handle:
        fields = handle.readline().split()
    values = [int(value) for value in fields[1:9]]
    if fields[0] != "cpu" or len(values) < 5:
        raise ValueError("Invalid CPU counters")
    return sum(values), values[3] + values[4]


def cpu_usage(before, after):
    total = after[0] - before[0]
    idle = after[1] - before[1]
    if total <= 0:
        return 0.0
    return round(max(0.0, min(100.0, (total - idle) / total * 100)), 2)


def memory_metrics(path="/proc/meminfo"):
    with open(path, encoding="utf-8") as handle:
        values = {key.rstrip(":"): int(value) * 1024 for key, value, *_ in (line.split() for line in handle)}
    total = values["MemTotal"]
    available = values.get("MemAvailable")
    if available is None:
        available = values.get("MemFree", 0) + values.get("Buffers", 0) + values.get("Cached", 0) + values.get("SReclaimable", 0) - values.get("Shmem", 0)
    available = max(0, min(total, available))
    used = total - available
    return {"totalBytes": total, "availableBytes": available, "usedBytes": used, "usagePercent": round(used / total * 100, 2)}


def unescape_mount(value):
    return re.sub(r"\\([0-7]{3})", lambda match: chr(int(match.group(1), 8)), value)


def mounted_disks(path="/proc/self/mountinfo"):
    mounts = {}
    with open(path, encoding="utf-8") as handle:
        for line in handle:
            before, after = line.rstrip().split(" - ", 1)
            fields, filesystem_fields = before.split(), after.split()
            device_id, mount = fields[2], unescape_mount(fields[4])
            filesystem, source = filesystem_fields[0], unescape_mount(filesystem_fields[1])
            if mount != "/" and filesystem not in REAL_FILESYSTEMS:
                continue
            if mount.startswith(("/var/lib/docker/", "/var/lib/containers/", "/snap/")):
                continue
            candidate = (mount, source, filesystem)
            if device_id not in mounts or len(mount) < len(mounts[device_id][0]):
                mounts[device_id] = candidate
    result = []
    for mount, device, filesystem in sorted(mounts.values()):
        try:
            value = os.statvfs(mount)
            total = value.f_blocks * value.f_frsize
            used = (value.f_blocks - value.f_bfree) * value.f_frsize
            available = value.f_bavail * value.f_frsize
            if total <= 0:
                continue
            usable = used + available
            result.append({"mount": mount, "device": device, "filesystem": filesystem, "totalBytes": total, "usedBytes": used, "availableBytes": available, "usagePercent": round(used / usable * 100, 2) if usable else 0.0})
        except OSError:
            logging.warning("Cannot read filesystem %s", mount)
    if not result:
        raise ValueError("No filesystem metrics available")
    return result


def os_name(path="/etc/os-release"):
    try:
        with open(path, encoding="utf-8") as handle:
            values = dict(line.rstrip().split("=", 1) for line in handle if "=" in line)
        return values.get("PRETTY_NAME", "Linux").strip('"')
    except OSError:
        return "Linux"


def collect(server_id, sample_seconds=1.0):
    before = read_cpu()
    STOP.wait(sample_seconds)
    after = read_cpu()
    load = os.getloadavg()
    with open("/proc/uptime", encoding="utf-8") as handle:
        uptime = float(handle.read().split()[0])
    return {
        "version": 1, "serverId": server_id, "collectedAt": int(time.time()),
        "hostname": socket.gethostname(), "os": os_name(), "kernel": platform.release(), "architecture": platform.machine(),
        "cpu": {"usagePercent": cpu_usage(before, after), "cores": os.cpu_count() or 1, "load1": round(load[0], 2), "load5": round(load[1], 2), "load15": round(load[2], 2)},
        "memory": memory_metrics(), "disks": mounted_disks(), "uptimeSeconds": int(uptime),
    }


def load_config(path, allow_http=False):
    metadata = os.stat(path)
    mode = metadata.st_mode
    # New installs use root:status-agent 640: the service can read but cannot
    # change a URL that a root-run updater might later trust. Legacy 600 remains valid.
    trusted_group_read = metadata.st_uid == 0 and metadata.st_gid == os.getegid()
    if mode & (stat.S_IWGRP | stat.S_IXGRP | stat.S_IRWXO) or (mode & stat.S_IRGRP and not trusted_group_read):
        raise ValueError("Config requires mode 600, or root-owned 640 for the service group")
    with open(path, encoding="utf-8") as handle:
        config = json.load(handle)
    if not re.fullmatch(r"[a-z0-9-]{1,64}", config.get("serverId", "")):
        raise ValueError("Invalid serverId")
    if not re.fullmatch(r"[A-Za-z0-9_-]{32,128}", config.get("token", "")):
        raise ValueError("Invalid agent token")
    url = urllib.parse.urlparse(config.get("endpoint", ""))
    if url.scheme != "https" and not (allow_http and url.scheme == "http" and url.hostname in ("127.0.0.1", "localhost")):
        raise ValueError("Endpoint must use HTTPS")
    if not url.hostname or url.username or url.password or url.query or url.fragment or url.path != "/api/ingest":
        raise ValueError("Invalid endpoint")
    config["interval"] = max(2, min(10, int(config.get("interval", 5))))
    return config


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, newurl):
        return None


def send(config, report):
    payload = json.dumps(report, separators=(",", ":"), allow_nan=False).encode("utf-8")
    request = urllib.request.Request(config["endpoint"], data=payload, headers={"Content-Type": "application/json", "Authorization": "Bearer " + config["token"], "User-Agent": "status-agent/1.0"}, method="POST")
    # Avoid forwarding credentials to an unexpected redirect target.
    opener = urllib.request.build_opener(NoRedirect())
    with opener.open(request, timeout=15) as response:
        result = json.loads(response.read(4096))
    if not result.get("ok"):
        raise ValueError("Report was not accepted")
    return result


class Unauthorized(ValueError):
    pass


class WebSocket:
    """Small RFC 6455 client for the collector's bounded JSON protocol."""
    def __init__(self, config):
        self.sock = None
        self.reader = None
        url = urllib.parse.urlsplit(config["endpoint"])
        try:
            self.sock = socket.create_connection((url.hostname, url.port or (443 if url.scheme == "https" else 80)), timeout=10)
            if url.scheme == "https":
                self.sock = ssl.create_default_context().wrap_socket(self.sock, server_hostname=url.hostname)
            self.reader = self.sock.makefile("rb")
            key = base64.b64encode(os.urandom(16)).decode()
            request = (f"GET /api/agent/connect HTTP/1.1\r\nHost: {url.netloc}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: {key}\r\nAuthorization: Bearer {config['token']}\r\nX-Server-Id: {config['serverId']}\r\nUser-Agent: status-agent/2.0\r\n\r\n")
            self.sock.sendall(request.encode("ascii"))
            status = self.reader.readline(4097)
            if len(status) > 4096:
                raise ValueError("Oversized handshake")
            fields = status.split()
            if len(fields) < 2:
                raise ValueError("Invalid handshake")
            if fields[1] in (b"401", b"403"):
                raise Unauthorized("Agent credential rejected; re-enroll this server")
            if fields[1] != b"101":
                raise ValueError("WebSocket upgrade failed")
            headers = {}
            size = 0
            while True:
                line = self.reader.readline(4097)
                size += len(line)
                if size > 16384 or not line:
                    raise ValueError("Invalid handshake headers")
                if line == b"\r\n":
                    break
                name, value = line.decode("ascii").split(":", 1)
                headers[name.lower()] = value.strip()
            expected = base64.b64encode(hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()).decode()
            if headers.get("sec-websocket-accept") != expected or headers.get("upgrade", "").lower() != "websocket" or "upgrade" not in headers.get("connection", "").lower():
                raise ValueError("Invalid WebSocket accept")
            ready = self.receive()
            if ready.get("type") != "ready":
                raise ValueError("Missing ready message")
            self.interval = max(2, min(10, int(ready.get("interval", 5))))
        except Exception:
            self.close()
            raise

    def exact(self, size):
        data = b""
        while len(data) < size:
            chunk = self.reader.read(size - len(data))
            if not chunk:
                raise OSError("WebSocket disconnected")
            data += chunk
        return data

    def frame(self, payload, opcode=1):
        if len(payload) > 32768:
            raise ValueError("Payload too large")
        mask = os.urandom(4)
        length = len(payload)
        header = bytes([0x80 | opcode, 0x80 | length]) if length < 126 else bytes([0x80 | opcode, 0x80 | 126]) + struct.pack("!H", length)
        self.sock.sendall(header + mask + bytes(value ^ mask[index % 4] for index, value in enumerate(payload)))

    def receive(self):
        while True:
            first, second = self.exact(2)
            opcode, length = first & 15, second & 127
            if not first & 0x80 or first & 0x70 or second & 0x80:
                raise ValueError("Unsupported WebSocket frame")
            if length == 126:
                length = struct.unpack("!H", self.exact(2))[0]
            elif length == 127:
                length = struct.unpack("!Q", self.exact(8))[0]
            if length > 32768 or (opcode >= 8 and length > 125):
                raise ValueError("Oversized server frame")
            payload = self.exact(length)
            if opcode == 8:
                code = struct.unpack("!H", payload[:2])[0] if len(payload) >= 2 else 1000
                if code == 4401:
                    raise Unauthorized("Agent credential revoked")
                raise OSError("Server closed WebSocket")
            if opcode == 9:
                self.frame(payload, 10)
                continue
            if opcode == 10:
                continue
            if opcode != 1:
                raise ValueError("Unexpected server frame")
            result = json.loads(payload)
            if not isinstance(result, dict):
                raise ValueError("Invalid server message")
            return result

    def send(self, report):
        payload = json.dumps(report, separators=(",", ":"), allow_nan=False).encode()
        self.frame(payload)
        result = self.receive()
        if result.get("type") != "ack":
            raise ValueError("Missing acknowledgement")
        return result

    def close(self):
        if self.reader is not None:
            self.reader.close()
        if self.sock is not None:
            self.sock.close()


def reconnect_delay(failures):
    return random.uniform(0.5, 1.0) * min(60, 2 ** min(failures, 6))


def run(config, once=False, connect=WebSocket):
    failures = 0
    while not STOP.is_set():
        connection = None
        try:
            connection = connect(config)
            config["interval"] = connection.interval
            while not STOP.is_set():
                started = time.monotonic()
                report = collect(config["serverId"])
                if STOP.is_set():
                    return
                result = connection.send(report)
                # Reset only after an acknowledged sample, not a TCP handshake.
                failures = 0
                interval = result.get("interval", config["interval"])
                if isinstance(interval, int) and 2 <= interval <= 10:
                    config["interval"] = interval
                if once:
                    return
                STOP.wait(max(0, config["interval"] - (time.monotonic() - started)))
        except Unauthorized:
            logging.error("Agent credential rejected; update enrollment in the panel")
            if once:
                raise SystemExit(1)
            failures = max(failures, 6)
        except (OSError, ValueError):
            logging.warning("Connection interrupted; reconnecting")
            if once:
                raise SystemExit(1)
        finally:
            if connection is not None:
                connection.close()
        STOP.wait(reconnect_delay(failures))
        failures += 1


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", default="/etc/status-agent/config.json")
    parser.add_argument("--once", action="store_true")
    parser.add_argument("--collect-only", metavar="SERVER_ID")
    parser.add_argument("--allow-local-http", action="store_true", help="Only for localhost integration tests")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    if platform.system() != "Linux":
        raise SystemExit("This collector requires Linux")
    if args.collect_only:
        print(json.dumps(collect(args.collect_only), ensure_ascii=False, allow_nan=False))
        return
    try:
        config = load_config(args.config, args.allow_local_http)
    except (OSError, ValueError) as error:
        raise SystemExit(str(error))
    for event in (signal.SIGTERM, signal.SIGINT):
        signal.signal(event, lambda *_: STOP.set())
    run(config, args.once)


if __name__ == "__main__":
    main()
