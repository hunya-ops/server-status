"""Run the real shell installer in an isolated filesystem with system calls stubbed.

The HTTP downloads, checksums, Python enrollment and file operations are real;
service management and the metric-upload probe are simulated (no host changes).
"""
import hashlib
import http.server
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest

ROOT = pathlib.Path(__file__).parents[2]


class InstallerTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = pathlib.Path(self.temporary.name)
        self.fake_bin = self.root/'bin'
        self.fake_bin.mkdir()
        self.env = {**os.environ, 'PATH':str(self.fake_bin)+os.pathsep+os.environ['PATH'], 'INSTALLER_TEST_ROOT':str(self.root)}
        self.asset_program = b'import os, pathlib\npathlib.Path(os.environ["INSTALLER_TEST_ROOT"],"report-probed").write_text("ok")\n'
        self.assets = {
            'status_agent.py':self.asset_program,
            'bootstrap.py':(ROOT/'agent/bootstrap.py').read_bytes(),
            'status-agent.service':(ROOT/'agent/status-agent.service').read_bytes(),
        }
        self.tamper = False
        self.registrations = []
        owner = self
        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass
            def do_GET(self):
                if self.path == '/agent/manifest.json':
                    content=json.dumps({'version':'0.2.0-0123456789ab','files':{k:hashlib.sha256(v).hexdigest() for k,v in owner.assets.items()}}).encode()
                else:
                    name=self.path.rsplit('/',1)[-1]
                    if name not in owner.assets:
                        self.send_error(404);return
                    content=owner.assets[name]
                    if owner.tamper and name=='status_agent.py':content+=b'# altered\n'
                self.send_response(200);self.end_headers();self.wfile.write(content)
            def do_POST(self):
                if self.path!='/api/enroll':self.send_error(404);return
                # Reproduce Cloudflare's rejection of urllib's default identity.
                if self.headers.get('User-Agent', '').startswith('Python-urllib/'):
                    self.send_error(403);return
                body=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                owner.registrations.append(body)
                self.send_response(200);self.end_headers();self.wfile.write(json.dumps({'ok':True,'serverId':body['serverId'],'interval':60}).encode())
        server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Handler)
        self.addCleanup(server.server_close)
        thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        self.addCleanup(server.shutdown)
        self.origin=f'http://127.0.0.1:{server.server_port}'
        self.stub('id','#!/bin/sh\nif [ "$1" = -u ]; then printf 0; fi\n')
        self.stub('uname','#!/bin/sh\nprintf Linux\n')
        self.stub('systemctl', f'''#!{sys.executable}
import os,pathlib,sys
p=pathlib.Path(os.environ['INSTALLER_TEST_ROOT'])
with (p/'service-log').open('a') as f:f.write(' '.join(sys.argv[1:])+'\\n')
if sys.argv[1]=='restart' and (p/'fail-restart').exists():
 (p/'fail-restart').unlink();sys.exit(1)
''')
        self.stub('install',f'''#!{sys.executable}
import os,pathlib,shutil,sys
args=sys.argv[1:];mode=None;directories=False;paths=[]
while args:
 a=args.pop(0)
 if a=='-d':directories=True
 elif a=='-m':mode=int(args.pop(0),8)
 elif a in ('-o','-g'):args.pop(0)
 else:paths.append(a)
if directories:
 for path in paths:
  pathlib.Path(path).mkdir(parents=True,exist_ok=True)
  if mode is not None:os.chmod(path,mode)
else:
 shutil.copyfile(paths[0],paths[1])
 if mode is not None:os.chmod(paths[1],mode)
''')
        (self.fake_bin/'python3').symlink_to(sys.executable)
        (self.root/'run/systemd/system').mkdir(parents=True)
        (self.root/'etc/systemd/system').mkdir(parents=True)
        script=(ROOT/'agent/install.sh').read_text()
        for path in ('/etc/status-agent','/opt/status-agent','/etc/systemd/system','/run/systemd/system'):
            script=script.replace(path,str(self.root/path.lstrip('/')))
        # Test-only loopback transport; production script requires HTTPS everywhere.
        script=script.replace("u.scheme != 'https'", "u.scheme not in ('https','http')")
        script=script.replace("--proto '=https'", "--proto '=http,https'")
        script=script.replace('--pending '+str(self.root/'etc/status-agent/enrollment.json'), '--allow-local-http --pending '+str(self.root/'etc/status-agent/enrollment.json'))
        self.script=self.root/'install.sh';self.script.write_text(script)
        self.config=self.root/'etc/status-agent/config.json'
        self.program=self.root/'opt/status-agent/status_agent.py'

    def stub(self,name,content):
        path=self.fake_bin/name;path.write_text(content);path.chmod(0o755)

    def run_installer(self,*args):
        return subprocess.run(['sh',str(self.script),'--url',self.origin,*args],env=self.env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,timeout=20)

    def install(self):
        return self.run_installer('--server','example-server','--enroll','a'*64)

    def test_install_update_and_uninstall(self):
        installed=self.install()
        self.assertEqual(installed.returncode,0,installed.stderr)
        token=json.loads(self.config.read_text())['token']
        self.assertEqual(self.config.stat().st_mode & 0o777,0o640)
        self.assertTrue((self.root/'report-probed').exists())
        self.assertIn('first report accepted',installed.stdout)
        self.assertNotIn(token,installed.stdout+installed.stderr)
        updated=self.run_installer('--update')
        self.assertEqual(updated.returncode,0,updated.stderr)
        self.assertEqual(json.loads(self.config.read_text())['token'],token)
        self.assertEqual(len(self.registrations),1)
        removed=self.run_installer('--uninstall')
        self.assertEqual(removed.returncode,0,removed.stderr)
        self.assertFalse(self.config.exists())
        self.assertFalse(self.program.exists())

    def test_checksum_failure_does_not_replace_existing_program(self):
        self.assertEqual(self.install().returncode,0)
        old_program=self.program.read_bytes();old_config=self.config.read_bytes()
        self.tamper=True
        result=self.run_installer('--update')
        self.assertNotEqual(result.returncode,0)
        self.assertIn('integrity check failed',result.stderr)
        self.assertEqual(self.program.read_bytes(),old_program)
        self.assertEqual(self.config.read_bytes(),old_config)

    def test_repeating_completed_install_reuses_the_installed_credential(self):
        self.assertEqual(self.install().returncode,0)
        token=json.loads(self.config.read_text())['token']
        pending=self.root/'etc/status-agent/enrollment.json'
        self.assertEqual(pending.stat().st_mode & 0o777,0o600)
        repeated=self.install()
        self.assertEqual(repeated.returncode,0,repeated.stderr)
        self.assertEqual(json.loads(self.config.read_text())['token'],token)
        self.assertEqual(len(self.registrations),1)
        self.assertNotIn(token,repeated.stdout+repeated.stderr)
        # A newly issued command still registers a fresh credential.
        fresh=self.run_installer('--server','example-server','--enroll','b'*64)
        self.assertEqual(fresh.returncode,0,fresh.stderr)
        self.assertNotEqual(json.loads(self.config.read_text())['token'],token)
        self.assertEqual(len(self.registrations),2)

    def test_service_failure_restores_the_previous_program(self):
        self.assertEqual(self.install().returncode,0)
        old_program=self.program.read_bytes()
        self.assets['status_agent.py']+=b'# new release\n'
        (self.root/'fail-restart').touch()
        result=self.run_installer('--update')
        self.assertNotEqual(result.returncode,0)
        self.assertEqual(self.program.read_bytes(),old_program)
        self.assertIn('Service startup failed',result.stderr)

    def test_refuses_to_overwrite_a_different_server(self):
        self.assertEqual(self.install().returncode,0)
        old_config=self.config.read_bytes()
        result=self.run_installer('--server','another-server','--enroll','a'*64)
        self.assertNotEqual(result.returncode,0)
        self.assertEqual(self.config.read_bytes(),old_config)
