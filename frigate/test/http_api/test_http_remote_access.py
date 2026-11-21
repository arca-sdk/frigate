"""Tests for the remote access API."""

import os
import tempfile
import threading
from unittest.mock import patch

from fastapi.testclient import TestClient

from frigate.config import FrigateConfig
from frigate.models import Event
from frigate.remote_access import RemoteAccessManager
from frigate.test.http_api.base_http_test import AuthTestClient, BaseTestHttp
from frigate.test.remote_access_fakes import FakeConnector, FakeRelay, FakeTailscale

RELAY = "https://relay.example.com"


class TestHttpRemoteAccess(BaseTestHttp):
    def setUp(self):
        super().setUp([Event])
        notices = patch("frigate.remote_access.manager.raise_notice")
        notices.start()
        self.addCleanup(notices.stop)
        resolves = patch("frigate.remote_access.manager.resolve_notice")
        resolves.start()
        self.addCleanup(resolves.stop)

        self.relay = FakeRelay()
        self.tailscale = FakeTailscale()
        directory = tempfile.mkdtemp()
        self.manager = RemoteAccessManager(
            FrigateConfig(**self.minimal_config),
            threading.Event(),
            relay_url=RELAY,
            cloudflared_binary="cloudflared",
            tailscale_binary="tailscale",
            tailscaled_binary="tailscaled",
            state_dir=os.path.join(directory, "state"),
            runtime_dir=os.path.join(directory, "run"),
            relay_client=self.relay.client,
            connector=FakeConnector(),
            tailscale_node=self.tailscale,
        )
        self.manager.start_services()
        self.app = self.create_app(remote_access_manager=self.manager)

    def client(self) -> TestClient:
        return AuthTestClient(self.app)

    def test_reports_both_routes(self):
        with self.client() as client:
            response = client.get("/remote_access")

        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["connect"]["state"], "unlinked")
        self.assertTrue(body["connect"]["available"])
        self.assertEqual(body["connect"]["dashboard_url"], f"{RELAY}/")
        self.assertEqual(body["tailscale"]["state"], "off")
        self.assertEqual(
            body["origin"], {"scheme": "https", "host": "127.0.0.1", "port": 8971}
        )

    def test_links_unlinks_and_cancels(self):
        with self.client() as client:
            started = client.post(
                "/remote_access/connect/link", json={"name": "Garage"}
            )
            self.assertEqual(started.status_code, 200)
            link = started.json()["connect"]["link"]
            self.assertEqual(
                link["verification_url_complete"],
                f"{RELAY}/link?code={link['user_code']}",
            )

            cancelled = client.delete("/remote_access/connect/link")
            self.assertEqual(cancelled.json()["connect"]["state"], "unlinked")

            started = client.post("/remote_access/connect/link", json={})
            self.relay.approve(started.json()["connect"]["link"]["user_code"])
            self.manager._pending.next_poll = 0
            self.manager.run_once()

            linked = client.get("/remote_access").json()["connect"]
            self.assertEqual(linked["state"], "linked")
            self.assertEqual(linked["name"], "Frigate")

            again = client.post("/remote_access/connect/link", json={"name": "Garage"})
            self.assertEqual(again.status_code, 409)
            self.assertEqual(again.json()["code"], "already_linked")

            unlinked = client.delete("/remote_access/connect")
            self.assertEqual(unlinked.json()["connect"]["state"], "unlinked")
            self.assertEqual(client.delete("/remote_access/connect").status_code, 409)

    def test_reports_an_unreachable_relay(self):
        from frigate.remote_access.relay import RelayError

        self.relay.fail_next(
            "create_link_request", RelayError("unreachable", "Offline")
        )
        with self.client() as client:
            response = client.post(
                "/remote_access/connect/link", json={"name": "Garage"}
            )

        self.assertEqual(response.status_code, 502)
        self.assertEqual(response.json()["code"], "relay_unavailable")

    def test_rejects_an_overlong_name(self):
        with self.client() as client:
            response = client.post(
                "/remote_access/connect/link", json={"name": "x" * 300}
            )

        self.assertEqual(response.status_code, 422)

    def test_turns_tailscale_on_and_off(self):
        with self.client() as client:
            enabled = client.post("/remote_access/tailscale/enable").json()["tailscale"]
            self.assertEqual(enabled["state"], "needs_login")
            self.assertTrue(
                enabled["auth_url"].startswith("https://login.tailscale.com/")
            )

            disabled = client.post("/remote_access/tailscale/disable").json()[
                "tailscale"
            ]
            self.assertEqual(disabled["state"], "off")

            client.post("/remote_access/tailscale/enable")
            signed_out = client.post("/remote_access/tailscale/logout").json()[
                "tailscale"
            ]
            self.assertEqual(signed_out["state"], "off")
            self.assertTrue(self.tailscale.logged_out)

    def test_requires_admin(self):
        viewer = {"remote-user": "viewer", "remote-role": "viewer"}
        with TestClient(self.app) as client:
            responses = [
                client.get("/remote_access", headers=viewer),
                client.post("/remote_access/connect/link", headers=viewer, json={}),
                client.delete("/remote_access/connect/link", headers=viewer),
                client.delete("/remote_access/connect", headers=viewer),
                client.post("/remote_access/tailscale/enable", headers=viewer),
                client.post("/remote_access/tailscale/disable", headers=viewer),
                client.post("/remote_access/tailscale/logout", headers=viewer),
            ]

        self.assertEqual([r.status_code for r in responses], [403] * 7)
        self.assertEqual(self.relay.calls, [])

    def test_answers_when_remote_access_is_not_running(self):
        app = self.create_app()
        with AuthTestClient(app) as client:
            response = client.get("/remote_access")

        self.assertEqual(response.status_code, 503)
