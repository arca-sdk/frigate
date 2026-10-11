"""Tests for running cameras as threads of a camera host process."""

import multiprocessing as mp
import os
import subprocess
import threading
import unittest
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from frigate.camera import host as host_module
from frigate.camera.host import CameraHost, HostedCamera
from frigate.camera.maintainer import get_cameras_per_process


class FakeWatchdog(threading.Thread):
    """Stands in for CameraWatchdog: runs until the camera's stop event."""

    def __init__(self, config, shm_frame_count, frame_queue, *metrics, **kwargs):
        super().__init__()
        # the camera's stop event follows the six metric values
        self.stop_event = metrics[6]

    def run(self) -> None:
        self.stop_event.wait()

    def stop_all_ffmpeg(self) -> None:
        self.ffmpeg_stopped = True


def hosted_camera(name: str) -> HostedCamera:
    metrics = SimpleNamespace(
        camera_fps=None,
        skipped_fps=None,
        ffmpeg_pid=None,
        stalls_last_hour=None,
        reconnects_last_hour=None,
        detection_frame=None,
        capture_process_pid=SimpleNamespace(value=0),
        process_pid=SimpleNamespace(value=0),
    )
    return HostedCamera(
        config=SimpleNamespace(name=name),
        model_config=MagicMock(),
        labelmap={},
        detection_queue=MagicMock(),
        camera_metrics=metrics,
        ptz_metrics=MagicMock(),
        region_grid=[],
        shm_frame_count=2,
        stop_event=mp.Event(),
        done_event=mp.Event(),
    )


class TestCameraHost(unittest.TestCase):
    def run_host(
        self, cameras: list[HostedCamera], track_camera, watchdog=FakeWatchdog
    ) -> threading.Thread:
        camera_host = CameraHost("test", cameras, MagicMock(), mp.Event())
        patches = [
            patch.object(CameraHost, "pre_run_setup"),
            patch.object(host_module, "CameraWatchdog", watchdog),
            patch.object(host_module, "track_camera", track_camera),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)

        runner = threading.Thread(target=camera_host.run)
        runner.start()
        self.addCleanup(lambda: [c.stop_event.set() for c in cameras])
        return runner

    def test_cameras_stop_individually(self):
        def track_camera(config, *args):
            # args[7] is the camera's stop event
            args[7].wait()

        cameras = [hosted_camera("a"), hosted_camera("b")]
        runner = self.run_host(cameras, track_camera)

        cameras[0].stop_event.set()
        self.assertTrue(cameras[0].done_event.wait(5))
        self.assertFalse(cameras[1].done_event.is_set())
        self.assertTrue(runner.is_alive())

        # the host exits once its last camera stops
        cameras[1].stop_event.set()
        self.assertTrue(cameras[1].done_event.wait(5))
        runner.join(5)
        self.assertFalse(runner.is_alive())

    def test_tracking_error_does_not_stop_other_cameras(self):
        def track_camera(config, *args):
            if config.name == "broken":
                raise RuntimeError("boom")
            args[7].wait()

        cameras = [hosted_camera("broken"), hosted_camera("fine")]
        runner = self.run_host(cameras, track_camera)

        # the broken camera is stopped as a whole and reported done, so the
        # maintainer can restart it, while the other camera keeps running
        self.assertTrue(cameras[0].done_event.wait(5))
        self.assertTrue(cameras[0].stop_event.is_set())
        self.assertTrue(runner.is_alive())
        self.assertFalse(cameras[1].done_event.is_set())

        cameras[1].stop_event.set()
        runner.join(5)
        self.assertFalse(runner.is_alive())

    def test_capture_failure_stops_tracking_and_ffmpeg(self):
        tracking_stopped = threading.Event()

        def track_camera(config, *args):
            args[7].wait()
            tracking_stopped.set()

        camera = hosted_camera("a")
        watchdogs: list[FakeWatchdog] = []

        class CrashingWatchdog(FakeWatchdog):
            def __init__(self, *args, **kwargs):
                super().__init__(*args, **kwargs)
                watchdogs.append(self)

            def run(self) -> None:
                raise RuntimeError("ffmpeg config is broken")

        self.run_host([camera], track_camera, watchdog=CrashingWatchdog)
        self.assertTrue(camera.done_event.wait(5))

        self.assertTrue(tracking_stopped.is_set())
        # ffmpeg runs in its own session, so the host stops what the crashed
        # watchdog left behind
        self.assertTrue(watchdogs[0].ffmpeg_stopped)

    def test_tracking_thread_reports_its_id(self):
        reported = threading.Event()
        ids: list[int] = []

        def track_camera(config, model, labels, queue, out, metrics, *args):
            ids.append(threading.get_native_id())
            reported.set()
            args[2].wait()

        camera = hosted_camera("a")
        self.run_host([camera], track_camera)
        self.assertTrue(reported.wait(5))
        self.assertEqual(camera.camera_metrics.process_pid.value, ids[0])


class TestCamerasPerProcess(unittest.TestCase):
    def test_parsing(self):
        for value, expected in (("", 8), ("0", 0), ("4", 4), ("-2", 0), ("x", 8)):
            env = {"FRIGATE_CAMERAS_PER_PROCESS": value} if value else {}
            with patch.dict(os.environ, env, clear=False):
                if not value:
                    os.environ.pop("FRIGATE_CAMERAS_PER_PROCESS", None)
                self.assertEqual(get_cameras_per_process(), expected, value)


class FakeHost:
    """Stands in for a CameraHost process."""

    created: list["FakeHost"] = []

    def __init__(self, name, cameras, detected_frames_queue, stop_event, log_config):
        self.name = f"frigate.cameras:{name}"
        self.cameras = cameras
        self.alive = False
        # no real process, so there are no children to record or stop
        self.pid = None
        self.exitcode = None
        self.joined = False
        FakeHost.created.append(self)

    def start(self) -> None:
        self.alive = True

    def is_alive(self) -> bool:
        return self.alive

    def join(self, timeout=None) -> None:
        self.joined = True
        self.alive = False

    def terminate(self) -> None:
        self.alive = False


class TestMaintainerCameraHosts(unittest.TestCase):
    def setUp(self):
        from frigate.camera import maintainer as maintainer_module

        FakeHost.created = []
        patcher = patch.object(maintainer_module, "CameraHost", FakeHost)
        patcher.start()
        self.addCleanup(patcher.stop)

        model = SimpleNamespace(
            scene="default", merged_labelmap={}, width=320, height=320
        )
        cameras = {
            name: SimpleNamespace(
                name=name,
                enabled_in_config=name != "off",
                frame_shape_yuv=(6, 4),
            )
            for name in ("a", "b", "c", "off")
        }
        m = maintainer_module.CameraMaintainer.__new__(
            maintainer_module.CameraMaintainer
        )
        m.config = SimpleNamespace(
            cameras=cameras,
            model_for_camera=lambda name: model,
            logger=None,
        )
        m.detection_queues = {"default": MagicMock()}
        m.detected_frames_queue = MagicMock()
        m.stop_event = mp.Event()
        m.camera_metrics = {name: MagicMock() for name in cameras}
        m.ptz_metrics = {name: MagicMock() for name in cameras}
        m.region_grids = {name: [] for name in cameras}
        m.frame_manager = MagicMock()
        m.shm_count = 3
        m.camera_processes = {}
        m.capture_processes = {}
        m.camera_stop_events = {}
        m.cameras_per_process = 2
        m.camera_hosts = {}
        m.hosted_cameras = {}
        m.camera_done_events = {}
        m.host_restart_times = {}
        m.host_count = 0
        m.host_children = {}
        m.config_holder = None
        self.maintainer = m

    def start(self, names):
        self.maintainer._CameraMaintainer__start_cameras(
            [(n, self.maintainer.config.cameras[n]) for n in names]
        )

    def stop(self, names):
        for name in names:
            # the hosted camera finished stopping right away
            self.maintainer.camera_done_events[name].set()
        self.maintainer._CameraMaintainer__stop_hosted_cameras(names)

    def test_groups_enabled_cameras_into_hosts(self):
        self.start(["a", "b", "c", "off"])

        self.assertEqual(
            [[c.config.name for c in h.cameras] for h in FakeHost.created],
            [["a", "b"], ["c"]],
        )
        self.assertNotIn("off", self.maintainer.camera_hosts)
        # each camera gets its frame slots
        self.assertEqual(self.maintainer.frame_manager.create.call_count, 9)

    def test_host_is_joined_once_its_last_camera_stops(self):
        self.start(["a", "b"])
        host = FakeHost.created[0]

        self.stop(["a"])
        self.assertTrue(self.maintainer.camera_stop_events["a"].is_set())
        self.assertFalse(host.joined)
        self.assertNotIn("a", self.maintainer.camera_hosts)

        self.stop(["b"])
        self.assertTrue(host.joined)
        self.assertEqual(self.maintainer.camera_hosts, {})

    def test_dead_host_is_restarted_with_backoff(self):
        self.start(["a", "b"])
        FakeHost.created[0].alive = False
        FakeHost.created[0].exitcode = -11

        self.maintainer._CameraMaintainer__restart_failed_cameras()
        self.assertEqual(len(FakeHost.created), 2)
        restarted = FakeHost.created[1]
        self.assertEqual([c.config.name for c in restarted.cameras], ["a", "b"])
        self.assertIs(self.maintainer.camera_hosts["a"], restarted)

        # a host that keeps dying is not restarted in a tight loop
        restarted.alive = False
        self.maintainer._CameraMaintainer__restart_failed_cameras()
        self.assertEqual(len(FakeHost.created), 2)

    def test_failed_camera_restarts_alone_with_the_current_config(self):
        self.start(["a", "b"])
        old_host = FakeHost.created[0]
        new_config = SimpleNamespace(name="a", enabled_in_config=True)
        model = self.maintainer.config.model_for_camera("a")
        self.maintainer.config_holder = SimpleNamespace(
            config=SimpleNamespace(
                cameras={"a": new_config}, model_for_camera=lambda name: model
            )
        )

        # the host reported camera a done although nobody stopped it
        self.maintainer.camera_done_events["a"].set()
        self.maintainer._CameraMaintainer__restart_failed_cameras()

        restarted = FakeHost.created[1]
        self.assertEqual([c.config for c in restarted.cameras], [new_config])
        self.assertIs(self.maintainer.camera_hosts["a"], restarted)
        self.assertIs(self.maintainer.camera_hosts["b"], old_host)
        self.assertFalse(self.maintainer.camera_stop_events["a"].is_set())

    def test_dead_host_children_are_stopped(self):
        import psutil

        child = subprocess.Popen(["sleep", "60"], start_new_session=True)
        self.addCleanup(child.kill)
        self.start(["a"])
        host = FakeHost.created[0]
        self.maintainer.host_children[host] = {
            (child.pid, psutil.Process(child.pid).create_time())
        }
        host.alive = False

        self.maintainer._CameraMaintainer__restart_failed_cameras()

        self.assertIsNotNone(child.wait(timeout=10))
        self.assertNotIn(host, self.maintainer.host_children)


if __name__ == "__main__":
    unittest.main()
