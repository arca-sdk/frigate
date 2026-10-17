"""The cloudflared and Tailscale wrappers, against stand-in executables."""

import json
import os
import stat
import sys
import tempfile
import textwrap
import threading
import time
import unittest
from collections.abc import Callable
from unittest.mock import patch

from frigate.remote_access.cloudflared import (
    CloudflaredConnector,
    ConnectorState,
    summarize_error,
)
from frigate.remote_access.tailscale import (
    TailscaleNode,
    parse_serve_target,
    parse_status,
)

FAKE_CLOUDFLARED = """
import json, os, signal, sys, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

token = os.environ.get("TUNNEL_TOKEN", "")
with open(os.path.join(os.environ["HOME"], "runs.jsonl"), "a") as log:
    log.write(json.dumps({"argv": sys.argv[1:], "token": token, "pid": os.getpid()}) + "\\n")
mode = token.split("-")[0]
if mode == "exit":
    print("2026-10-17T02:17:34Z ERR Cannot reach the edge connIndex=0 event=0", flush=True)
    sys.exit(1)

ready = {"connections": 0}

class Ready(BaseHTTPRequestHandler):
    def do_GET(self):
        n = ready["connections"]
        body = json.dumps({"status": 200 if n else 503, "readyConnections": n}).encode()
        self.send_response(200 if n else 503)
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass

server = ThreadingHTTPServer(("127.0.0.1", 0), Ready)
threading.Thread(target=server.serve_forever, daemon=True).start()
signal.signal(signal.SIGTERM, lambda *args: os._exit(0))
print(f"2026-10-17T02:17:34Z INF Starting metrics server on 127.0.0.1:{server.server_port}/metrics", flush=True)
if mode == "connect":
    ready["connections"] = 4
    print("2026-10-17T02:17:35Z INF Registered tunnel connection connIndex=0 location=gru01 protocol=quic", flush=True)
elif mode == "reject":
    for _ in range(3):
        print('2026-10-17T02:17:35Z ERR Register tunnel error from server side error="Failed to get tunnel" connIndex=0 event=0 ip=2606:4700:a8::3', flush=True)
while True:
    time.sleep(1)
"""

FAKE_TAILSCALED = """
import os, signal, sys, time

state = os.environ["FAKE_TAILSCALE_STATE"]
open(state + ".daemon", "w").write(str(os.getpid()))

def stop(*args):
    os.unlink(state + ".daemon")
    os._exit(0)

signal.signal(signal.SIGTERM, stop)
with open(state + ".daemon_args", "w") as file:
    file.write(" ".join(sys.argv[1:]))
while True:
    time.sleep(1)
"""

FAKE_TAILSCALE = """
import json, os, sys, time

path = os.environ["FAKE_TAILSCALE_STATE"]

def load():
    try:
        with open(path) as file:
            return json.load(file)
    except FileNotFoundError:
        return {"backend": "NeedsLogin", "auth_url": "", "https": False, "target": None}

def save(state):
    with open(path, "w") as file:
        json.dump(state, file)

args = [a for a in sys.argv[1:] if not a.startswith("--socket=")]
if not os.path.exists(path + ".daemon"):
    print("failed to connect to local tailscaled", file=sys.stderr)
    sys.exit(1)

state = load()
if args[:2] == ["status", "--json"]:
    print(json.dumps({
        "BackendState": state["backend"],
        "AuthURL": state["auth_url"],
        "Self": {"DNSName": "frigate.tail1234.ts.net." if state["backend"] == "Running" else ""},
        "CurrentTailnet": {"Name": "example.com"} if state["backend"] == "Running" else None,
    }))
    sys.exit(0 if state["backend"] == "Running" else 1)
if args[0] == "up":
    state["auth_url"] = "https://login.tailscale.com/a/abc123"
    save(state)
    print(json.dumps({"AuthURL": state["auth_url"], "BackendState": "NeedsLogin"}))
    sys.exit(1)
if args[:3] == ["serve", "status", "--json"]:
    if state["target"]:
        print(json.dumps({"TCP": {"443": {"HTTPS": True}}, "Web": {"frigate.tail1234.ts.net:443": {"Handlers": {"/": {"Proxy": state["target"]}}}}}))
    else:
        print("{}")
    sys.exit(0)
if args[0] == "serve" and args[-1] == "off":
    state["target"] = None
    save(state)
    sys.exit(0)
if args[0] == "serve":
    if not state["https"]:
        print("Serve is not enabled on your tailnet.", flush=True)
        print("To enable, visit:", flush=True)
        print("", flush=True)
        print("         https://login.tailscale.com/f/serve?node=n123", flush=True)
        while not load()["https"]:
            time.sleep(0.05)
    state = load()
    state["target"] = args[-1]
    save(state)
    print("Available within your tailnet:", flush=True)
    sys.exit(0)
if args[0] == "logout":
    state.update(backend="NeedsLogin", auth_url="")
    save(state)
    sys.exit(0)
sys.exit(2)
"""


def write_executable(directory: str, name: str, source: str) -> str:
    path = os.path.join(directory, name)
    with open(path, "w") as file:
        file.write(f"#!{sys.executable}\n" + textwrap.dedent(source))
    os.chmod(path, os.stat(path).st_mode | stat.S_IEXEC)
    return path


def wait_for(condition: Callable[[], bool], timeout: float = 10.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if condition():
            return
        time.sleep(0.05)
    raise AssertionError("condition not met in time")


def process_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    return True


class TestCloudflaredConnector(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.mkdtemp()
        self.runtime = os.path.join(self.directory, "run")
        self.binary = write_executable(self.directory, "cloudflared", FAKE_CLOUDFLARED)
        self.rejections = threading.Event()

    def connector(self, binary: str | None = None) -> CloudflaredConnector:
        connector = CloudflaredConnector(
            binary or self.binary,
            self.runtime,
            on_rejected=self.rejections.set,
            ready_poll_interval=0.1,
            restart_delays=(0.1, 0.2),
        )
        self.addCleanup(connector.stop)
        return connector

    def runs(self) -> list[dict]:
        try:
            with open(os.path.join(self.runtime, "runs.jsonl")) as file:
                return [json.loads(line) for line in file]
        except FileNotFoundError:
            return []

    def test_connects_and_keeps_the_token_off_the_command_line(self):
        connector = self.connector()
        connector.run("connect-1")
        wait_for(lambda: connector.status().connections == 4)
        self.assertEqual(connector.status().state, ConnectorState.connected)

        (run,) = self.runs()
        self.assertEqual(run["token"], "connect-1")
        self.assertNotIn("connect-1", " ".join(run["argv"]))
        self.assertEqual(run["argv"][0], "tunnel")
        self.assertIn("--no-autoupdate", run["argv"])

    def test_stops_the_process(self):
        connector = self.connector()
        connector.run("connect-1")
        wait_for(lambda: len(self.runs()) == 1)
        pid = self.runs()[0]["pid"]
        connector.stop()
        self.assertEqual(connector.status().state, ConnectorState.stopped)
        wait_for(lambda: not process_alive(pid))

    def test_restarts_with_a_new_token_only(self):
        connector = self.connector()
        connector.run("connect-1")
        wait_for(lambda: connector.status().state == ConnectorState.connected)
        connector.run("connect-1")
        connector.run("connect-2")
        wait_for(lambda: len(self.runs()) == 2)
        self.assertEqual(
            [run["token"] for run in self.runs()], ["connect-1", "connect-2"]
        )
        wait_for(lambda: not process_alive(self.runs()[0]["pid"]))

    def test_reports_rejection_and_the_edge_error(self):
        connector = self.connector()
        connector.run("reject-1")
        self.assertTrue(self.rejections.wait(10))
        wait_for(lambda: connector.status().error == "Failed to get tunnel")
        self.assertNotEqual(connector.status().state, ConnectorState.connected)

    def test_restarts_a_process_that_exits(self):
        connector = self.connector()
        connector.run("exit-1")
        wait_for(lambda: len(self.runs()) >= 3)
        status = connector.status()
        self.assertEqual(status.state, ConnectorState.failed)
        self.assertEqual(status.error, "Cannot reach the edge")

    def test_fails_without_the_binary(self):
        connector = CloudflaredConnector(None, self.runtime, on_rejected=lambda: None)
        self.assertFalse(connector.available)
        connector.run("connect-1")
        self.assertEqual(connector.status().state, ConnectorState.failed)

    def test_summarizes_error_lines(self):
        self.assertEqual(
            summarize_error(
                'Register tunnel error from server side error="Unauthorized: Invalid tunnel secret" connIndex=0'
            ),
            "Unauthorized: Invalid tunnel secret",
        )
        self.assertEqual(
            summarize_error("Failed to dial a quic connection connIndex=1 event=0"),
            "Failed to dial a quic connection",
        )


class TestTailscaleParsing(unittest.TestCase):
    def test_parses_a_signed_out_node(self):
        status = parse_status(
            json.dumps(
                {
                    "BackendState": "NeedsLogin",
                    "AuthURL": "https://login.tailscale.com/a/5ae6c3101c6b4",
                    "Self": {"DNSName": "", "HostName": "fedora"},
                    "CurrentTailnet": None,
                }
            )
        )
        self.assertEqual(status.backend_state, "NeedsLogin")
        self.assertEqual(status.auth_url, "https://login.tailscale.com/a/5ae6c3101c6b4")
        self.assertIsNone(status.dns_name)
        self.assertIsNone(status.tailnet)

    def test_parses_a_running_node(self):
        status = parse_status(
            json.dumps(
                {
                    "BackendState": "Running",
                    "AuthURL": "",
                    "Self": {"DNSName": "frigate.tail1234.ts.net."},
                    "CurrentTailnet": {"Name": "example.com"},
                }
            )
        )
        self.assertEqual(status.dns_name, "frigate.tail1234.ts.net")
        self.assertIsNone(status.auth_url)
        self.assertEqual(status.tailnet, "example.com")

    def test_rejects_output_that_is_not_status(self):
        self.assertIsNone(parse_status(""))
        self.assertIsNone(parse_status("[]"))

    def test_finds_the_serve_target_for_the_https_port(self):
        config = {
            "TCP": {"443": {"HTTPS": True}},
            "Web": {
                "frigate.tail1234.ts.net:443": {
                    "Handlers": {"/": {"Proxy": "https+insecure://127.0.0.1:8971"}}
                }
            },
        }
        self.assertEqual(
            parse_serve_target(json.dumps(config)), "https+insecure://127.0.0.1:8971"
        )
        self.assertIsNone(parse_serve_target(json.dumps(config), port=8443))
        self.assertIsNone(parse_serve_target("{}"))


class TestTailscaleNode(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.mkdtemp()
        self.state = os.path.join(self.directory, "fake-state.json")
        environment = patch.dict(os.environ, {"FAKE_TAILSCALE_STATE": self.state})
        environment.start()
        self.addCleanup(environment.stop)
        self.node = TailscaleNode(
            write_executable(self.directory, "tailscaled", FAKE_TAILSCALED),
            write_executable(self.directory, "tailscale", FAKE_TAILSCALE),
            state_dir=os.path.join(self.directory, "identity"),
            runtime_dir=os.path.join(self.directory, "run"),
        )
        self.addCleanup(self.node.stop)

    def update(self, **changes) -> None:
        state = {
            "backend": "NeedsLogin",
            "auth_url": "",
            "https": False,
            "target": None,
        }
        if os.path.exists(self.state):
            with open(self.state) as file:
                state = json.load(file)
        state.update(changes)
        with open(self.state, "w") as file:
            json.dump(state, file)

    def test_runs_the_daemon_in_userspace_with_its_own_state(self):
        self.assertIsNone(self.node.status())
        self.node.start()
        wait_for(lambda: self.node.status() is not None)
        with open(self.state + ".daemon_args") as file:
            arguments = file.read().split()
        self.assertIn("--tun=userspace-networking", arguments)
        self.assertIn(f"--statedir={self.node.state_dir}", arguments)
        self.assertIn(f"--socket={self.node.socket_path}", arguments)

        self.node.stop()
        self.assertFalse(self.node.is_started())
        wait_for(lambda: not os.path.exists(self.state + ".daemon"))

    def test_signs_in_and_serves_once_https_is_enabled(self):
        self.node.start()
        wait_for(lambda: self.node.status() is not None)
        self.node.login()
        self.assertEqual(
            self.node.status().auth_url, "https://login.tailscale.com/a/abc123"
        )

        self.update(backend="Running", auth_url="")
        self.node.start_serve("https+insecure://127.0.0.1:8971")

        def enable_url() -> str | None:
            attempt = self.node.serve_attempt()
            return attempt.enable_url if attempt else None

        wait_for(lambda: enable_url() is not None)
        self.assertEqual(enable_url(), "https://login.tailscale.com/f/serve?node=n123")
        self.assertIsNone(self.node.serve_target())

        self.update(https=True)
        wait_for(lambda: self.node.serve_attempt().succeeded)
        self.assertEqual(self.node.serve_target(), "https+insecure://127.0.0.1:8971")

        self.node.disable_serve()
        self.assertIsNone(self.node.serve_target())

    def test_signs_out(self):
        self.node.start()
        wait_for(lambda: self.node.status() is not None)
        self.update(backend="Running")
        self.assertTrue(self.node.logout())
        self.assertEqual(self.node.status().backend_state, "NeedsLogin")

        self.node.stop()
        wait_for(lambda: not os.path.exists(self.state + ".daemon"))
        self.assertFalse(self.node.logout())

    def test_is_unavailable_without_both_binaries(self):
        node = TailscaleNode(None, "tailscale", self.directory, self.directory)
        self.assertFalse(node.available)
        node.start()
        self.assertFalse(node.is_started())


if __name__ == "__main__":
    unittest.main()
