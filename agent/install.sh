#!/bin/sh
set -eu
fail() { printf '%s\n' "$*" >&2; exit 1; }
find_url() {
  while [ "$#" -gt 0 ]; do
    if [ "$1" = --url ] && [ "$#" -ge 2 ]; then printf '%s' "$2"; return; fi
    shift
  done
}
main() {
  if [ "$(id -u)" != 0 ]; then
    command -v sudo >/dev/null 2>&1 || fail 'Run this installer as root, or install sudo'
    elevation_url=$(find_url "$@")
    case "$elevation_url" in https://*) ;; *) fail 'Specify --url with the HTTPS custom domain of your panel';; esac
    self_script=$(mktemp)
    trap 'rm -f "$self_script"' EXIT
    curl -fsS --proto '=https' --max-time 30 "$elevation_url/agent/install.sh" -o "$self_script"
    if sudo sh "$self_script" "$@"; then return; else exit 1; fi
  fi
  [ "$(uname -s)" = Linux ] || fail 'Linux is required'
  command -v systemctl >/dev/null 2>&1 || fail 'systemd is required'
  [ -d /run/systemd/system ] || fail 'systemd must be running'
  panel_url='' server_id='' enrollment_code='' action=install
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --url|--server|--enroll) [ "$#" -ge 2 ] || fail "Missing value for $1"
        case "$1" in --url) panel_url=$2;; --server) server_id=$2;; --enroll) enrollment_code=$2;; esac
        shift 2;;
      --update) action=update; shift;;
      --uninstall) action=uninstall; shift;;
      *) fail "Unknown argument: $1";;
    esac
  done
  if [ "$action" = uninstall ]; then
    systemctl disable --now status-agent.service 2>/dev/null || true
    rm -f /etc/systemd/system/status-agent.service
    rm -rf /opt/status-agent /etc/status-agent
    systemctl daemon-reload
    printf 'Agent uninstalled\n'
    return
  fi
  if ! command -v python3 >/dev/null 2>&1 || ! command -v curl >/dev/null 2>&1; then
    if command -v apt-get >/dev/null 2>&1; then
      apt-get update -qq
      DEBIAN_FRONTEND=noninteractive apt-get install -y -qq python3 curl ca-certificates
    elif command -v dnf >/dev/null 2>&1; then dnf install -y python3 curl ca-certificates
    elif command -v yum >/dev/null 2>&1; then yum install -y python3 curl ca-certificates
    else fail 'Install Python 3, curl and CA certificates, then retry'; fi
  fi
  umask 077
  [ -n "$panel_url" ] || fail 'Specify --url with the HTTPS custom domain of your panel'
  if [ "$action" = update ]; then
    [ -f /etc/status-agent/config.json ] || fail 'No installed agent was found'
  else
    [ -n "$server_id" ] && [ -n "$enrollment_code" ] || fail 'Use the installation command from your panel'
  fi
  panel_url=$(python3 - "$panel_url" <<'PY'
import sys, urllib.parse
u=urllib.parse.urlsplit(sys.argv[1])
if u.scheme != 'https' or not u.hostname or u.username or u.password or u.query or u.fragment or u.path not in ('','/') or u.hostname.endswith('.workers.dev'):
    raise SystemExit('Use the HTTPS custom domain of your panel')
print(u.scheme+'://'+u.netloc)
PY
  )
  if [ -f /etc/status-agent/config.json ]; then
    action=$(python3 - "$panel_url" "$server_id" "$action" "$enrollment_code" <<'PY'
import hashlib, json, pathlib, sys
c=json.load(open('/etc/status-agent/config.json'))
if c.get('endpoint') != sys.argv[1]+'/api/ingest' or (sys.argv[3] == 'install' and c.get('serverId') != sys.argv[2]):
    raise SystemExit('A different agent is installed; uninstall it before switching panels or servers')
action=sys.argv[3]
pending=pathlib.Path('/etc/status-agent/enrollment.json')
if action == 'install' and pending.exists():
    p=json.loads(pending.read_text())
    if all(p.get(k) == c.get(k) for k in ('serverId','endpoint','token')) and p.get('enrollmentHash') == hashlib.sha256(sys.argv[4].encode()).hexdigest():
        action='update'
print(action)
PY
    )
  fi
  scratch=$(mktemp -d)
  trap 'rm -rf "$scratch"' EXIT
  trap 'exit 1' HUP INT TERM
  curl -fsS --proto '=https' --max-time 30 --retry 2 "$panel_url/agent/manifest.json" -o "$scratch/manifest.json"
  agent_version=$(python3 - "$scratch/manifest.json" <<'PY'
import json,re,sys
m=json.load(open(sys.argv[1]))
if not re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+-[0-9a-f]{12}',m.get('version','')): raise SystemExit('Invalid agent manifest')
print(m['version'])
PY
  )
  for asset in status_agent.py status-agent.service bootstrap.py; do
    curl -fsS --proto '=https' --max-time 30 --retry 2 "$panel_url/agent/$agent_version/$asset" -o "$scratch/$asset"
  done
  python3 - "$scratch" <<'PY'
import hashlib,json,pathlib,sys
p=pathlib.Path(sys.argv[1]);m=json.loads((p/'manifest.json').read_text())
for name in ('status_agent.py','status-agent.service','bootstrap.py'):
    if hashlib.sha256((p/name).read_bytes()).hexdigest()!=m['files'].get(name): raise SystemExit('Agent integrity check failed')
PY
  fi_python=$(command -v python3)
  sed "s|ExecStart=/usr/bin/python3 |ExecStart=$fi_python |" "$scratch/status-agent.service" > "$scratch/runtime.service"
  if ! id status-agent >/dev/null 2>&1; then
    nologin=$(command -v nologin || printf '/bin/false')
    useradd --system --user-group --no-create-home --home-dir /nonexistent --shell "$nologin" status-agent
  fi
  install -d -m 750 -o root -g status-agent /etc/status-agent
  if [ "$action" = install ]; then
    python3 "$scratch/bootstrap.py" --url "$panel_url" --server "$server_id" --enroll "$enrollment_code" --pending /etc/status-agent/enrollment.json --output "$scratch/config.json"
  else
    cp /etc/status-agent/config.json "$scratch/config.json"
  fi
  python3 "$scratch/status_agent.py" --config "$scratch/config.json" --once
  previous_program=0
  if [ -f /opt/status-agent/status_agent.py ] && [ -f /etc/systemd/system/status-agent.service ]; then
    previous_program=1
    cp /opt/status-agent/status_agent.py "$scratch/previous.py"
    cp /etc/systemd/system/status-agent.service "$scratch/previous.service"
  fi
  install -d -m 755 /opt/status-agent
  install -m 640 -o root -g status-agent "$scratch/config.json" /etc/status-agent/config.json
  install -m 644 "$scratch/status_agent.py" /opt/status-agent/status_agent.py
  install -m 644 "$scratch/runtime.service" /etc/systemd/system/status-agent.service
  systemctl daemon-reload
  if ! systemctl enable status-agent.service || ! systemctl restart status-agent.service || ! systemctl is-active --quiet status-agent.service; then
    if [ "$previous_program" = 1 ]; then
      install -m 644 "$scratch/previous.py" /opt/status-agent/status_agent.py
      install -m 644 "$scratch/previous.service" /etc/systemd/system/status-agent.service
      systemctl daemon-reload
      systemctl restart status-agent.service || true
    fi
    fail 'Service startup failed; check journalctl -u status-agent. Retry the same command to finish installation'
  fi
  printf '%s\n' "$agent_version" > /opt/status-agent/version
  printf 'Agent installed and first report accepted (%s)\n' "$agent_version"
}
main "$@"
