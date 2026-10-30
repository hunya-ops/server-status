#!/usr/bin/env python3
"""Enroll an agent without putting its permanent credential in shell arguments."""
import argparse
import hashlib
import json
import os
import pathlib
import re
import secrets
import urllib.error
import urllib.parse
import urllib.request


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, newurl):
        return None


def origin(value, allow_local_http=False):
    url = urllib.parse.urlsplit(value)
    local = allow_local_http and url.scheme == "http" and url.hostname in ("127.0.0.1", "localhost")
    if (url.scheme != "https" and not local) or not url.hostname or url.username or url.password or url.query or url.fragment or url.path not in ("", "/"):
        raise ValueError("Panel URL must be an HTTPS origin")
    return f"{url.scheme}://{url.netloc}"


def write_config(path, value):
    path = pathlib.Path(path)
    temporary = path.with_name(path.name + ".tmp")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    os.fchmod(descriptor, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf8") as handle:
        json.dump(value, handle)
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)


def enroll(panel_url, server_id, code, pending_path, output_path, allow_local_http=False):
    panel_url = origin(panel_url, allow_local_http)
    if not re.fullmatch(r"[a-z0-9-]{1,64}", server_id) or not re.fullmatch(r"[A-Za-z0-9_-]{32,128}", code):
        raise ValueError("Invalid server ID or enrollment code")
    code_hash = hashlib.sha256(code.encode()).hexdigest()
    pending = None
    try:
        pending = json.loads(pathlib.Path(pending_path).read_text())
    except FileNotFoundError:
        pass
    if not isinstance(pending, dict) or pending.get("serverId") != server_id or pending.get("endpoint") != panel_url + "/api/ingest" or pending.get("enrollmentHash") != code_hash:
        pending = {"serverId": server_id, "endpoint": panel_url + "/api/ingest", "token": secrets.token_urlsafe(32), "enrollmentHash": code_hash}
        write_config(pending_path, pending)
    if not re.fullmatch(r"[A-Za-z0-9_-]{32,128}", pending.get("token", "")):
        raise ValueError("Invalid pending credential")
    # Use the collector's identity; Cloudflare can reject urllib's default agent.
    request = urllib.request.Request(panel_url + "/api/enroll", data=json.dumps({"serverId": server_id, "token": pending["token"]}).encode(), headers={"Content-Type": "application/json", "Authorization": "Bearer " + code, "User-Agent": "status-agent/1.0"}, method="POST")
    try:
        with urllib.request.build_opener(NoRedirect()).open(request, timeout=20) as response:
            result = json.loads(response.read(4096))
    except urllib.error.HTTPError as error:
        if error.code == 401:
            raise ValueError("Enrollment code expired or already used; generate a new command in the panel") from None
        raise ValueError(f"Enrollment failed (HTTP {error.code})") from None
    interval = result.get("interval")
    if not result.get("ok") or result.get("serverId") != server_id or not isinstance(interval, int) or not 30 <= interval <= 3600:
        raise ValueError("Invalid enrollment response")
    config = {key: pending[key] for key in ("serverId", "endpoint", "token")}
    config["interval"] = interval
    write_config(output_path, config)
    return config


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", required=True)
    parser.add_argument("--server", required=True)
    parser.add_argument("--enroll", required=True)
    parser.add_argument("--pending", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--allow-local-http", action="store_true")
    args = parser.parse_args()
    try:
        enroll(args.url, args.server, args.enroll, args.pending, args.output, args.allow_local_http)
    except (ValueError, OSError, urllib.error.URLError) as error:
        raise SystemExit(str(error) if isinstance(error, ValueError) else "Cannot reach the panel; check HTTPS connectivity") from None


if __name__ == "__main__":
    main()
