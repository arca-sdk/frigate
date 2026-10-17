import json
import os
import stat
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from unittest.mock import patch

from frigate.config import FrigateConfig
from frigate.config.holder import ConfigHolder
from frigate.remote_access.cloudflared import ConnectorState
from frigate.remote_access.manager import (
    CHECK_INTERVAL,
    RECOVERY_INTERVAL,
    RemoteAccessError,
    RemoteAccessManager,
    configured_relay_url,
)
from frigate.remote_access.origin import LocalOrigin, origin_from_config
from frigate.remote_access.relay import RelayClient, RelayError
from frigate.remote_access.state import ConnectLink, RemoteAccessState, StateStore
from frigate.remote_access.tailscale import ServeAttempt
from frigate.test.remote_access_fakes import FakeConnector, FakeRelay, FakeTailscale

RELAY = "https://relay.example.com"


def make_config(**overrides: Any) -> FrigateConfig:
    config: dict[str, Any] = {
        "mqtt": {"enabled": False},
        "cameras": {
            "front_door": {
                "ffmpeg": {
                    "inputs": [
                        {"path": "rtsp://10.0.0.1:554/video", "roles": ["detect"]}
                    ]
                },
                "detect": {"height": 1080, "width": 1920, "fps": 5},
            }
        },
    }
    config.update(overrides)
    return FrigateConfig(**config)


class TestOrigin(unittest.TestCase):
    def test_defaults_to_the_authenticated_tls_port_on_loopback(self):
        origin = origin_from_config(make_config())
        self.assertEqual(origin, LocalOrigin("https", "127.0.0.1", 8971))
        self.assertEqual(origin.tailscale_target, "https+insecure://127.0.0.1:8971")

    def test_uses_plain_http_when_tls_is_off(self):
        origin = origin_from_config(make_config(tls={"enabled": False}))
        self.assertEqual(origin.url, "http://127.0.0.1:8971")
        self.assertEqual(origin.tailscale_target, "http://127.0.0.1:8971")

    def test_follows_a_custom_external_port_never_the_internal_one(self):
        config = make_config(
            networking={"listen": {"internal": 5000, "external": 9443}}
        )
        self.assertEqual(origin_from_config(config).port, 9443)

    def test_uses_the_address_nginx_is_bound_to(self):
        bound = make_config(networking={"listen": {"external": "192.168.1.5:8971"}})
        self.assertEqual(origin_from_config(bound).host, "192.168.1.5")

        ipv6 = make_config(networking={"listen": {"external": "[::1]:8971"}})
        self.assertEqual(origin_from_config(ipv6).url, "https://[::1]:8971")

    def test_keeps_loopback_for_wildcard_and_named_addresses(self):
        for listen in ("0.0.0.0:8971", "[::]:8971", "localhost:8971"):
            config = make_config(networking={"listen": {"external": listen}})
            self.assertEqual(origin_from_config(config).host, "127.0.0.1", listen)


class TestStateStore(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.mkdtemp()
        self.store = StateStore(os.path.join(self.directory, "remote_access"))

    def link(self) -> ConnectLink:
        return ConnectLink(
            relay_url=RELAY,
            instance_id="abc",
            instance_secret="abc.secret",
            tunnel_token="token",
            hostname="abc.tunnels.example.net",
            url="https://abc.tunnels.example.net/",
            name="Garage",
            account_label="alice@example.com",
            linked_at=1.0,
        )

    def test_round_trips_and_keeps_the_file_private(self):
        self.store.save(RemoteAccessState(connect=self.link(), tailscale_enabled=True))
        loaded = self.store.load()
        self.assertEqual(loaded.connect, self.link())
        self.assertTrue(loaded.tailscale_enabled)
        self.assertEqual(stat.S_IMODE(os.stat(self.store.path).st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(os.stat(self.store.directory).st_mode), 0o700)
        self.assertEqual(os.listdir(self.store.directory), ["state.json"])

    def test_missing_or_unreadable_state_is_empty(self):
        self.assertEqual(self.store.load(), RemoteAccessState())
        self.store.ensure_directory()
        with open(self.store.path, "w") as file:
            file.write("{not json")
        self.assertEqual(self.store.load(), RemoteAccessState())
        with open(self.store.path, "w") as file:
            json.dump({"connect": {"unexpected": True}}, file)
        self.assertEqual(self.store.load(), RemoteAccessState())


class _Handler(BaseHTTPRequestHandler):
    responses: list[tuple[int, Any]] = []
    received: list[dict[str, Any]] = []

    def _respond(self) -> None:
        length = int(self.headers.get("content-length") or 0)
        body = self.rfile.read(length) if length else b""
        type(self).received.append(
            {
                "method": self.command,
                "path": self.path,
                "authorization": self.headers.get("authorization"),
                "body": json.loads(body) if body else None,
            }
        )
        status, payload = type(self).responses.pop(0)
        raw = (
            b""
            if payload is None
            else (
                payload if isinstance(payload, bytes) else json.dumps(payload).encode()
            )
        )
        self.send_response(status)
        self.send_header("content-length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    do_GET = do_POST = do_DELETE = _respond

    def log_message(self, format: str, *args: Any) -> None:
        pass


class TestRelayClient(unittest.TestCase):
    def setUp(self):
        _Handler.responses = []
        _Handler.received = []
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.client = RelayClient(f"http://127.0.0.1:{self.server.server_port}/")

    def test_creates_a_link_request_for_the_origin(self):
        _Handler.responses.append(
            (
                201,
                {
                    "device_code": "dc",
                    "user_code": "BCDF-GHJK",
                    "verification_uri": "https://r/link",
                    "verification_uri_complete": "https://r/link?code=BCDF-GHJK",
                    "expires_in": 600,
                    "interval": 5,
                },
            )
        )
        request = self.client.create_link_request(
            "Garage", LocalOrigin("https", "127.0.0.1", 8971)
        )
        self.assertEqual(request.user_code, "BCDF-GHJK")
        self.assertEqual(request.interval, 5)
        self.assertEqual(
            _Handler.received[0]["body"],
            {
                "name": "Garage",
                "origin": {"scheme": "https", "host": "127.0.0.1", "port": 8971},
            },
        )

    def test_maps_relay_errors(self):
        _Handler.responses.append(
            (400, {"error": "authorization_pending", "message": "Waiting"})
        )
        with self.assertRaises(RelayError) as caught:
            self.client.poll_link_request("dc")
        self.assertEqual(caught.exception.code, "authorization_pending")
        self.assertFalse(caught.exception.retryable)

        _Handler.responses.append(
            (401, {"error": "invalid_instance_credentials", "message": "Gone"})
        )
        with self.assertRaises(RelayError) as caught:
            self.client.get_instance("abc.secret")
        self.assertTrue(caught.exception.revoked)
        self.assertEqual(_Handler.received[1]["authorization"], "Bearer abc.secret")

    def test_treats_unexpected_bodies_and_outages_as_retryable(self):
        _Handler.responses.append((502, b"<html>bad gateway</html>"))
        with self.assertRaises(RelayError) as caught:
            self.client.get_instance("abc.secret")
        self.assertEqual(caught.exception.code, "bad_response")
        self.assertTrue(caught.exception.retryable)

        unreachable = RelayClient("http://127.0.0.1:9")
        with self.assertRaises(RelayError) as caught:
            unreachable.get_instance("abc.secret")
        self.assertEqual(caught.exception.code, "unreachable")
        self.assertTrue(caught.exception.retryable)

    def test_syncs_and_reads_the_replacement_token(self):
        _Handler.responses.append(
            (
                200,
                {
                    "instance_id": "abc",
                    "name": "Garage",
                    "hostname": "abc.t.net",
                    "url": "https://abc.t.net/",
                    "account_label": None,
                    "tunnel_token": "new",
                    "tunnel_replaced": True,
                },
            )
        )
        result = self.client.sync_instance(
            "abc.secret",
            name="Garage",
            origin=LocalOrigin("http", "127.0.0.1", 8971),
            include_token=True,
        )
        self.assertEqual(result.tunnel_token, "new")
        self.assertTrue(result.tunnel_replaced)
        self.assertIsNone(result.account_label)
        self.assertTrue(_Handler.received[0]["body"]["include_token"])

    def test_unlink_accepts_no_content(self):
        _Handler.responses.append((204, None))
        self.client.unlink_instance("abc.secret")
        self.assertEqual(_Handler.received[0]["method"], "DELETE")


class Clock:
    def __init__(self) -> None:
        self.now = 1_800_000_000.0

    def __call__(self) -> float:
        return self.now


class ManagerTestCase(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.mkdtemp()
        self.relay = FakeRelay()
        self.clock = Clock()
        self.connector = FakeConnector()
        self.tailscale = FakeTailscale()
        notices = patch("frigate.remote_access.manager.raise_notice")
        self.raise_notice = notices.start()
        self.addCleanup(notices.stop)
        resolves = patch("frigate.remote_access.manager.resolve_notice")
        resolves.start()
        self.addCleanup(resolves.stop)

    def manager(self, config: FrigateConfig | None = None, **kwargs: Any):
        options: dict[str, Any] = {
            "relay_url": RELAY,
            "cloudflared_binary": "cloudflared",
            "tailscale_binary": "tailscale",
            "tailscaled_binary": "tailscaled",
            "state_dir": os.path.join(self.directory, "state"),
            "runtime_dir": os.path.join(self.directory, "run"),
            "relay_client": self.relay.client,
            "clock": self.clock,
            "connector": self.connector,
            "tailscale_node": self.tailscale,
        }
        options.update(kwargs)
        manager = RemoteAccessManager(
            config or make_config(), threading.Event(), **options
        )
        manager.start_services()
        return manager

    def advance(self, manager: RemoteAccessManager, seconds: float) -> None:
        self.clock.now += seconds
        manager.run_once()

    def link(self, manager: RemoteAccessManager) -> dict[str, Any]:
        status = manager.start_link("Garage")
        self.relay.approve(status["connect"]["link"]["user_code"])
        self.advance(manager, 5)
        return manager.status()


class TestConnectLinking(ManagerTestCase):
    def test_links_after_approval_and_starts_the_tunnel(self):
        manager = self.manager()
        status = manager.start_link("Garage")["connect"]
        self.assertEqual(status["state"], "linking")
        self.assertEqual(
            status["link"]["verification_url_complete"],
            f"{RELAY}/link?code={status['link']['user_code']}",
        )
        self.assertEqual(
            self.relay.requests["device-1"].origin,
            LocalOrigin("https", "127.0.0.1", 8971),
        )

        self.advance(manager, 5)
        self.assertEqual(manager.status()["connect"]["state"], "linking")

        self.relay.approve(status["link"]["user_code"])
        self.advance(manager, 5)
        connect = manager.status()["connect"]
        self.assertEqual(connect["state"], "linked")
        self.assertEqual(connect["url"], "https://inst2.tunnels.example.net/")
        self.assertEqual(connect["account_label"], "alice@example.com")
        self.assertEqual(connect["connector"]["state"], "connected")
        self.assertEqual(self.connector.runs, ["token-2"])

    def test_keeps_the_link_across_restarts(self):
        self.link(self.manager())
        restarted = self.manager(connector=FakeConnector())
        self.assertEqual(restarted.status()["connect"]["state"], "linked")
        self.assertEqual(restarted._connector.runs, ["token-2"])

    def test_waits_between_polls(self):
        manager = self.manager()
        manager.start_link("Garage")
        self.advance(manager, 1)
        self.advance(manager, 1)
        self.assertEqual(
            [call for call, _ in self.relay.calls], ["create_link_request"]
        )

    def test_reports_a_declined_request(self):
        manager = self.manager()
        status = manager.start_link("Garage")
        self.relay.deny(status["connect"]["link"]["user_code"])
        self.advance(manager, 5)
        connect = manager.status()["connect"]
        self.assertEqual(connect["state"], "unlinked")
        self.assertEqual(connect["error"]["code"], "declined")
        self.assertEqual(self.connector.runs, [])

    def test_gives_up_when_the_code_expires(self):
        manager = self.manager()
        manager.start_link("Garage")
        self.advance(manager, 601)
        connect = manager.status()["connect"]
        self.assertEqual(connect["state"], "unlinked")
        self.assertEqual(connect["error"]["code"], "expired")

    def test_keeps_polling_through_relay_outages(self):
        manager = self.manager()
        status = manager.start_link("Garage")
        self.relay.approve(status["connect"]["link"]["user_code"])
        self.relay.fail_next(
            "poll_link_request",
            RelayError("provisioning_failed", "Not yet", 502),
        )
        self.advance(manager, 5)
        self.assertEqual(manager.status()["connect"]["state"], "linking")
        self.advance(manager, 5)
        self.assertEqual(manager.status()["connect"]["state"], "linked")

    def test_slows_down_when_asked(self):
        manager = self.manager()
        manager.start_link("Garage")
        self.relay.fail_next("poll_link_request", RelayError("slow_down", "", 400))
        self.advance(manager, 5)
        self.advance(manager, 5)
        polls = [call for call, _ in self.relay.calls if call == "poll_link_request"]
        self.assertEqual(len(polls), 1)
        self.advance(manager, 5)
        self.assertEqual(manager._pending.interval, 10)

    def test_undoes_a_link_approved_after_cancelling(self):
        manager = self.manager()
        status = manager.start_link("Garage")
        self.relay.approve(status["connect"]["link"]["user_code"])
        # the admin cancels while the poll that collects the link is in flight
        original = self.relay.client

        def cancel_during_poll(base_url: str):
            client = original(base_url)
            poll = client.poll_link_request

            def poll_then_cancel(device_code: str):
                result = poll(device_code)
                manager.cancel_link()
                return result

            client.poll_link_request = poll_then_cancel
            return client

        manager._relay_client = cancel_during_poll
        self.advance(manager, 5)
        self.assertEqual(manager.status()["connect"]["state"], "unlinked")
        self.assertEqual(self.relay.instances, {})
        self.assertEqual(self.connector.runs, [])

    def test_names_default_and_are_cleaned(self):
        manager = self.manager()
        manager.start_link("  \x00Driveway\n ")
        self.assertEqual(self.relay.requests["device-1"].name, "Driveway")
        manager.cancel_link()
        manager.start_link(None)
        self.assertEqual(self.relay.requests["device-2"].name, "Frigate")

    def test_reports_an_unreachable_relay_when_starting(self):
        manager = self.manager()
        self.relay.fail_next(
            "create_link_request", RelayError("unreachable", "Could not reach")
        )
        with self.assertRaises(RemoteAccessError) as caught:
            manager.start_link("Garage")
        self.assertEqual(caught.exception.code, "relay_unavailable")
        self.assertEqual(caught.exception.status_code, 502)

    def test_refuses_a_second_link(self):
        manager = self.manager()
        self.link(manager)
        with self.assertRaises(RemoteAccessError) as caught:
            manager.start_link("Garage")
        self.assertEqual(caught.exception.code, "already_linked")


class TestConnectRequirements(ManagerTestCase):
    def test_requires_authentication(self):
        manager = self.manager(make_config(auth={"enabled": False}))
        self.assertEqual(manager.status()["connect"]["blocked_reason"], "auth_disabled")
        with self.assertRaises(RemoteAccessError) as caught:
            manager.start_link("Garage")
        self.assertEqual(caught.exception.code, "auth_disabled")
        self.assertEqual(self.relay.calls, [])

    def test_keeps_an_existing_link_off_while_authentication_is_disabled(self):
        self.link(self.manager())
        connector = FakeConnector()
        manager = self.manager(
            make_config(auth={"enabled": False}), connector=connector
        )
        self.assertEqual(connector.runs, [])
        self.assertEqual(manager.status()["connect"]["state"], "linked")

    def test_stops_the_tunnel_while_a_saved_config_turns_authentication_off(self):
        # a save that applies without a restart swaps the whole config, and
        # /auth reads auth.enabled from it on every request
        holder = ConfigHolder(make_config())
        manager = self.manager(holder.config, config_holder=holder)
        self.link(manager)
        self.assertEqual(self.connector.state, ConnectorState.connected)

        holder.set(make_config(auth={"enabled": False}))
        self.advance(manager, 1)
        self.assertEqual(self.connector.state, ConnectorState.stopped)
        status = manager.status()
        self.assertEqual(status["connect"]["blocked_reason"], "auth_disabled")
        self.assertFalse(status["security"]["auth_enabled"])

        holder.set(make_config())
        self.advance(manager, 1)
        self.assertEqual(self.connector.state, ConnectorState.connected)
        self.assertEqual(self.connector.runs, ["token-2", "token-2"])

    def test_is_unavailable_without_a_relay_or_cloudflared(self):
        manager = self.manager(relay_url=None)
        self.assertEqual(
            manager.status()["connect"]["unavailable_reason"], "not_configured"
        )
        with self.assertRaises(RemoteAccessError):
            manager.start_link("Garage")

        manager = self.manager(connector=FakeConnector(available=False))
        self.assertEqual(
            manager.status()["connect"]["unavailable_reason"], "connector_missing"
        )

    def test_reports_the_security_settings(self):
        manager = self.manager(
            make_config(auth={"failed_login_rate_limit": "1/second"})
        )
        self.assertEqual(
            manager.status()["security"],
            {"auth_enabled": True, "login_rate_limit_enabled": True},
        )

    def test_relay_url_comes_from_the_environment(self):
        with patch.dict(
            os.environ, {"FRIGATE_REMOTE_ACCESS_RELAY_URL": " https://r.example/ "}
        ):
            self.assertEqual(configured_relay_url(), "https://r.example")
        with patch.dict(os.environ, {"FRIGATE_REMOTE_ACCESS_RELAY_URL": ""}):
            self.assertIsNone(configured_relay_url())


class TestConnectMaintenance(ManagerTestCase):
    def restarted(self, config: FrigateConfig | None = None) -> RemoteAccessManager:
        self.link(self.manager())
        self.relay.calls.clear()
        self.connector = FakeConnector()
        return self.manager(config, connector=self.connector)

    def test_syncs_the_origin_at_startup(self):
        manager = self.restarted(make_config(tls={"enabled": False}))
        self.advance(manager, 1)
        self.assertEqual([call for call, _ in self.relay.calls], ["sync_instance"])
        self.assertEqual(
            self.relay.instance().origin, LocalOrigin("http", "127.0.0.1", 8971)
        )
        self.advance(manager, 1)
        self.assertEqual(len(self.relay.calls), 1)

    def test_restarts_the_connector_with_a_replacement_token(self):
        manager = self.restarted()
        token = self.relay.replace_tunnel(self.relay.instance().instance_id)
        self.advance(manager, 1)
        self.assertEqual(self.connector.runs, ["token-2", token])
        reloaded = StateStore(os.path.join(self.directory, "state")).load()
        self.assertEqual(reloaded.connect.tunnel_token, token)

    def test_retries_a_failed_sync_with_backoff(self):
        manager = self.restarted()
        self.connector.state = ConnectorState.disconnected
        self.relay.fail_next("sync_instance", RelayError("unreachable", "Offline"))
        self.advance(manager, 1)
        self.assertEqual(manager.status()["connect"]["relay_error"], "Offline")
        self.advance(manager, 4)
        self.assertEqual(len(self.relay.calls), 1)
        self.advance(manager, 1)
        self.assertEqual(len(self.relay.calls), 2)
        self.assertIsNone(manager.status()["connect"]["relay_error"])

    def test_marks_the_link_revoked_when_the_relay_drops_it(self):
        manager = self.restarted()
        self.relay.remove_instance(self.relay.instance().instance_id)
        self.advance(manager, 1)
        connect = manager.status()["connect"]
        self.assertEqual(connect["state"], "revoked")
        self.assertEqual(connect["connector"]["state"], "stopped")
        self.raise_notice.assert_called_once_with(
            "remote_access_revoked", params={"hostname": "inst2.tunnels.example.net"}
        )
        # stays off after a restart
        connector = FakeConnector()
        self.manager(connector=connector)
        self.assertEqual(connector.runs, [])

    def test_checks_the_link_periodically(self):
        manager = self.manager()
        self.link(manager)
        self.relay.remove_instance(self.relay.instance().instance_id)
        self.advance(manager, CHECK_INTERVAL - 10)
        self.assertEqual(manager.status()["connect"]["state"], "linked")
        self.advance(manager, 10)
        self.assertEqual(manager.status()["connect"]["state"], "revoked")

    def test_asks_for_a_new_token_when_the_connector_is_rejected(self):
        manager = self.restarted()
        self.advance(manager, 1)
        self.relay.calls.clear()

        manager.request_recovery()
        self.advance(manager, 1)
        self.assertEqual([call for call, _ in self.relay.calls], ["sync_instance"])

        manager.request_recovery()
        self.advance(manager, 1)
        self.assertEqual(len(self.relay.calls), 1)

        self.clock.now += RECOVERY_INTERVAL
        manager.request_recovery()
        self.advance(manager, 1)
        self.assertEqual(len(self.relay.calls), 2)

    def test_unlinks_from_the_relay(self):
        manager = self.manager()
        self.link(manager)
        connect = manager.unlink()["connect"]
        self.assertEqual(connect["state"], "unlinked")
        self.assertIsNone(connect["error"])
        self.assertEqual(self.relay.instances, {})
        self.assertEqual(self.connector.state, ConnectorState.stopped)
        self.assertIsNone(
            StateStore(os.path.join(self.directory, "state")).load().connect
        )

    def test_unlinks_locally_when_the_relay_is_unreachable(self):
        manager = self.manager()
        self.link(manager)
        self.relay.fail_next("unlink_instance", RelayError("unreachable", "Offline"))
        connect = manager.unlink()["connect"]
        self.assertEqual(connect["state"], "unlinked")
        self.assertEqual(connect["error"]["code"], "unlink_incomplete")

    def test_ignores_a_sync_that_finishes_after_unlinking(self):
        manager = self.restarted()
        original = self.relay.client

        def unlink_during_sync(base_url: str):
            client = original(base_url)
            sync = client.sync_instance

            def sync_then_unlink(*args: Any, **kwargs: Any):
                result = sync(*args, **kwargs)
                manager.unlink()
                return result

            client.sync_instance = sync_then_unlink
            return client

        manager._relay_client = unlink_during_sync
        self.advance(manager, 1)
        self.assertEqual(manager.status()["connect"]["state"], "unlinked")
        self.assertIsNone(self.connector.token)


class TestTailscale(ManagerTestCase):
    def test_signs_in_and_serves_frigate(self):
        manager = self.manager()
        tailscale = manager.tailscale_enable()["tailscale"]
        self.assertTrue(self.tailscale.started)
        self.assertEqual(tailscale["state"], "needs_login")
        self.assertEqual(tailscale["auth_url"], "https://login.tailscale.com/a/abc123")

        self.tailscale.complete_login()
        self.advance(manager, 5)
        self.assertEqual(
            self.tailscale.serve_starts, ["https+insecure://127.0.0.1:8971"]
        )
        self.assertEqual(manager.status()["tailscale"]["serve"], "enabling")

        self.tailscale.finish_serve("https+insecure://127.0.0.1:8971")
        self.clock.now += 5
        manager._forget_tailscale_status()
        tailscale = manager.status()["tailscale"]
        self.assertEqual(tailscale["serve"], "on")
        self.assertEqual(tailscale["url"], "https://frigate.tail1234.ts.net/")
        self.assertEqual(tailscale["tailnet"], "example.com")

    def test_does_not_request_login_again_while_a_url_is_waiting(self):
        manager = self.manager()
        manager.tailscale_enable()
        for _ in range(3):
            self.advance(manager, 5)
        self.assertEqual(self.tailscale.logins, 1)

    def test_surfaces_the_https_enable_link(self):
        manager = self.manager()
        manager.tailscale_enable()
        self.tailscale.complete_login()
        self.advance(manager, 5)
        self.tailscale.attempt = ServeAttempt(
            running=True,
            succeeded=False,
            enable_url="https://login.tailscale.com/f/serve?node=n1",
            error=None,
        )
        manager._forget_tailscale_status()
        tailscale = manager.status()["tailscale"]
        self.assertEqual(tailscale["serve"], "needs_https")
        self.assertEqual(
            tailscale["enable_https_url"], "https://login.tailscale.com/f/serve?node=n1"
        )

    def test_starts_again_after_a_restart(self):
        self.manager().tailscale_enable()
        self.tailscale.started = False
        self.manager()
        self.assertTrue(self.tailscale.started)

    def test_turning_off_keeps_the_sign_in(self):
        manager = self.manager()
        manager.tailscale_enable()
        self.tailscale.complete_login()
        self.tailscale.finish_serve("https+insecure://127.0.0.1:8971")
        tailscale = manager.tailscale_disable()["tailscale"]
        self.assertEqual(tailscale["state"], "off")
        self.assertFalse(self.tailscale.started)
        self.assertIsNone(self.tailscale.target)
        self.assertFalse(self.tailscale.logged_out)
        self.manager()
        self.assertFalse(self.tailscale.started)

    def test_sign_out(self):
        manager = self.manager()
        manager.tailscale_enable()
        tailscale = manager.tailscale_logout()["tailscale"]
        self.assertTrue(self.tailscale.logged_out)
        self.assertEqual(tailscale["state"], "off")

    def test_is_unavailable_without_the_binaries(self):
        manager = self.manager(tailscale_node=FakeTailscale(available=False))
        self.assertFalse(manager.status()["tailscale"]["available"])
        with self.assertRaises(RemoteAccessError) as caught:
            manager.tailscale_enable()
        self.assertEqual(caught.exception.code, "tailscale_missing")


if __name__ == "__main__":
    unittest.main()
