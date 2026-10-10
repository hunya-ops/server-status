#!/usr/bin/env python3
"""Linux metrics collector. Python 3 standard library only."""

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
    config["interval"] = max(30, min(3600, int(config.get("interval", 60))))
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
    while not STOP.is_set():
        started = time.monotonic()
        try:
            report = collect(config["serverId"])
            if STOP.is_set():
                break
            result = send(config, report)
            interval = result.get("interval")
            if isinstance(interval, int) and 30 <= interval <= 3600:
                config["interval"] = interval
            logging.info("Metrics uploaded for %s", config["serverId"])
        except urllib.error.HTTPError as error:
            logging.error("Upload returned HTTP %s", error.code)
            if args.once:
                raise SystemExit(1)
        except (OSError, ValueError, urllib.error.URLError):
            logging.error("Collection or upload failed; retrying next interval")
            if args.once:
                raise SystemExit(1)
        if args.once:
            break
        STOP.wait(max(0, config["interval"] - (time.monotonic() - started)))


if __name__ == "__main__":
    main()
