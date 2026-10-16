"""Tests for per stream recording health tracking in the camera watchdog."""

import os
import unittest
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from unittest.mock import MagicMock, call, patch

from frigate.config import FrigateConfig
from frigate.const import STREAM_TYPE_MAIN, STREAM_TYPE_SUB
from frigate.log import LogPipe
from frigate.video.ffmpeg import CameraWatchdog


def build_watchdog(
    sub_enabled: bool = True,
    output_args: dict | None = None,
    ffmpeg_error: SimpleNamespace | None = None,
) -> CameraWatchdog:
    config = FrigateConfig(
        **{
            "mqtt": {"host": "mqtt"},
            "cameras": {
                "front_door": {
                    "ffmpeg": {
                        "output_args": output_args or {},
                        "inputs": [
                            {
                                "path": "rtsp://10.0.0.1:554/video",
                                "roles": ["record"],
                            },
                            {
                                "path": "rtsp://10.0.0.1:554/video2",
                                "roles": ["detect", "record_sub"],
                            },
                        ],
                    },
                    "record": {
                        "enabled": True,
                        "sub": {"enabled": sub_enabled},
                    },
                }
            },
        }
    )
    camera_config = config.cameras["front_door"]

    with (
        patch("frigate.video.ffmpeg.LogPipe"),
        patch("frigate.video.ffmpeg.InterProcessRequestor"),
        patch("frigate.video.ffmpeg.RecordingsDataSubscriber"),
        patch("frigate.video.ffmpeg.CameraConfigUpdateSubscriber"),
    ):
        watchdog = CameraWatchdog(
            camera_config,
            1,
            MagicMock(),
            MagicMock(),
            MagicMock(),
            MagicMock(),
            MagicMock(),
            MagicMock(),
            MagicMock(),
            MagicMock(),
            ffmpeg_error=ffmpeg_error,
        )

    return watchdog


class TestCameraWatchdogStreamHealth(unittest.TestCase):
    def _build_watchdog(
        self, sub_enabled: bool = True, output_args: dict | None = None
    ) -> CameraWatchdog:
        return build_watchdog(sub_enabled, output_args)

    def test_stale_sub_does_not_mark_main_stale(self):
        watchdog = self._build_watchdog()
        now = datetime.now().astimezone(UTC)
        stale = (now - timedelta(hours=1)).timestamp()

        watchdog.latest_cache_segment_time[STREAM_TYPE_MAIN] = now.timestamp()
        watchdog.latest_valid_segment_time[STREAM_TYPE_MAIN] = now.timestamp()
        watchdog.latest_cache_segment_time[STREAM_TYPE_SUB] = stale
        watchdog.latest_valid_segment_time[STREAM_TYPE_SUB] = stale

        assert watchdog._stream_staleness(STREAM_TYPE_MAIN, now) is None
        assert watchdog._stream_staleness(STREAM_TYPE_SUB, now) is not None

    def test_stale_main_does_not_mark_sub_stale(self):
        watchdog = self._build_watchdog()
        now = datetime.now().astimezone(UTC)
        stale = (now - timedelta(hours=1)).timestamp()

        watchdog.latest_cache_segment_time[STREAM_TYPE_MAIN] = stale
        watchdog.latest_valid_segment_time[STREAM_TYPE_MAIN] = stale
        watchdog.latest_cache_segment_time[STREAM_TYPE_SUB] = now.timestamp()
        watchdog.latest_valid_segment_time[STREAM_TYPE_SUB] = now.timestamp()

        assert watchdog._stream_staleness(STREAM_TYPE_MAIN, now) is not None
        assert watchdog._stream_staleness(STREAM_TYPE_SUB, now) is None

    def test_grace_period_suppresses_staleness(self):
        watchdog = self._build_watchdog()
        now = datetime.now().astimezone(UTC)
        watchdog.record_enable_time = now - timedelta(seconds=10)
        watchdog.latest_cache_segment_time[STREAM_TYPE_SUB] = (
            now - timedelta(hours=1)
        ).timestamp()

        assert watchdog._stream_staleness(STREAM_TYPE_SUB, now) is None

    def test_status_goes_to_the_matching_role_topic(self):
        watchdog = self._build_watchdog()

        watchdog.record_status[STREAM_TYPE_MAIN].send("online", 100.0)
        watchdog.record_status[STREAM_TYPE_SUB].send("offline", 100.0)

        watchdog.requestor.send_data.assert_any_call(
            "front_door/status/record", "online"
        )
        watchdog.requestor.send_data.assert_any_call(
            "front_door/status/record_sub", "offline"
        )

    def test_status_is_cached_per_stream(self):
        watchdog = self._build_watchdog()

        watchdog.record_status[STREAM_TYPE_MAIN].send("online", 100.0)
        watchdog.record_status[STREAM_TYPE_SUB].send("online", 100.0)
        watchdog.record_status[STREAM_TYPE_MAIN].send("online", 100.0)

        assert watchdog.requestor.send_data.call_count == 2

    def test_recorded_streams_follows_config(self):
        watchdog = self._build_watchdog()
        assert watchdog._recorded_streams(["record"]) == [STREAM_TYPE_MAIN]
        assert watchdog._recorded_streams(["detect", "record_sub"]) == [STREAM_TYPE_SUB]
        assert watchdog._recorded_streams(["detect"]) == []

        disabled = self._build_watchdog(sub_enabled=False)
        assert disabled._recorded_streams(["detect", "record_sub"]) == []

    def test_restart_grace_suppresses_repeat_staleness(self):
        watchdog = self._build_watchdog()
        now = datetime.now().astimezone(UTC)
        stale = (now - timedelta(hours=1)).timestamp()

        watchdog.latest_cache_segment_time[STREAM_TYPE_MAIN] = stale
        watchdog.latest_valid_segment_time[STREAM_TYPE_MAIN] = stale
        assert watchdog._stream_staleness(STREAM_TYPE_MAIN, now) is not None

        watchdog._grant_restart_grace([STREAM_TYPE_MAIN], now)

        assert watchdog._stream_staleness(STREAM_TYPE_MAIN, now) is None
        assert (
            watchdog._stream_staleness(STREAM_TYPE_MAIN, now + timedelta(seconds=89))
            is None
        )
        assert (
            watchdog._stream_staleness(STREAM_TYPE_MAIN, now + timedelta(seconds=91))
            is not None
        )

    def test_restart_grace_is_per_stream(self):
        watchdog = self._build_watchdog()
        now = datetime.now().astimezone(UTC)
        stale = (now - timedelta(hours=1)).timestamp()

        for stream_type in (STREAM_TYPE_MAIN, STREAM_TYPE_SUB):
            watchdog.latest_cache_segment_time[stream_type] = stale
            watchdog.latest_valid_segment_time[stream_type] = stale

        watchdog._grant_restart_grace([STREAM_TYPE_MAIN], now)

        assert watchdog._stream_staleness(STREAM_TYPE_MAIN, now) is None
        assert watchdog._stream_staleness(STREAM_TYPE_SUB, now) is not None

    def test_detect_reset_grants_the_shared_sub_stream_grace(self):
        watchdog = self._build_watchdog()
        watchdog.detect_process_records_sub = True
        watchdog.ffmpeg_detect_process = MagicMock()
        watchdog.capture_thread = MagicMock()
        watchdog.capture_thread.is_alive.return_value = False
        watchdog.start_ffmpeg_detect = MagicMock()

        now = datetime.now().astimezone(UTC)
        stale = (now - timedelta(hours=1)).timestamp()
        watchdog.latest_cache_segment_time[STREAM_TYPE_SUB] = stale
        watchdog.latest_valid_segment_time[STREAM_TYPE_SUB] = stale
        assert watchdog._stream_staleness(STREAM_TYPE_SUB, now) is not None

        watchdog.reset_capture_thread(terminate=False)

        # the sub check runs later in the same tick against a stale can_restart,
        # so without this grace it would kill the just-restarted process again
        assert (
            watchdog._stream_staleness(STREAM_TYPE_SUB, datetime.now().astimezone(UTC))
            is None
        )

    def test_detect_reset_leaves_sub_alone_when_not_shared(self):
        watchdog = self._build_watchdog()
        watchdog.detect_process_records_sub = False
        watchdog.ffmpeg_detect_process = MagicMock()
        watchdog.capture_thread = MagicMock()
        watchdog.capture_thread.is_alive.return_value = False
        watchdog.start_ffmpeg_detect = MagicMock()

        now = datetime.now().astimezone(UTC)
        stale = (now - timedelta(hours=1)).timestamp()
        watchdog.latest_cache_segment_time[STREAM_TYPE_SUB] = stale
        watchdog.latest_valid_segment_time[STREAM_TYPE_SUB] = stale

        watchdog.reset_capture_thread(terminate=False)

        assert (
            watchdog._stream_staleness(STREAM_TYPE_SUB, datetime.now().astimezone(UTC))
            is not None
        )

    def test_stale_threshold_follows_each_stream_segment_time(self):
        watchdog = self._build_watchdog(
            output_args={
                "record": "-f segment -segment_time 10 -c copy",
                "record_sub": "-f segment -segment_time 60 -c copy",
            }
        )

        assert watchdog.record_stale_threshold[STREAM_TYPE_MAIN] == 120
        assert watchdog.record_stale_threshold[STREAM_TYPE_SUB] == 150


FFMPEG_EXIT_LINES = [
    "Option hwaccel (use HW accelerated decoding) cannot be applied to output "
    "url vaapi -- you are trying to apply an input option to an output file or "
    "vice versa. Move this option before the file it belongs to.",
    "Error parsing options for output file vaapi.",
    "Error opening output files: Invalid argument",
]


class TestCameraWatchdogFfmpegError(unittest.TestCase):
    def _build_watchdog(self) -> tuple[CameraWatchdog, SimpleNamespace]:
        ffmpeg_error = SimpleNamespace(value="")
        watchdog = build_watchdog(ffmpeg_error=ffmpeg_error)
        watchdog.logpipe.tail.return_value = list(FFMPEG_EXIT_LINES)
        watchdog.ffmpeg_detect_process = MagicMock()
        watchdog.capture_thread = MagicMock()
        watchdog.start_ffmpeg_detect = MagicMock()
        return watchdog, ffmpeg_error

    def _run_one_tick(self, watchdog: CameraWatchdog) -> None:
        watchdog.start_all_ffmpeg = MagicMock()
        watchdog.stop_event = MagicMock()
        watchdog.stop_event.wait.side_effect = [False, True]
        watchdog.segment_subscriber.check_for_update.return_value = (None, None)
        watchdog.detection_frame = None

        with patch("frigate.video.ffmpeg.time.sleep"):
            watchdog._watch()

    def test_crash_publishes_the_last_ffmpeg_lines(self):
        watchdog, ffmpeg_error = self._build_watchdog()
        watchdog.capture_thread.is_alive.return_value = False

        self._run_one_tick(watchdog)

        # published right away, the restart only happens after retry_interval
        watchdog.start_ffmpeg_detect.assert_not_called()
        assert ffmpeg_error.value == "\n".join(FFMPEG_EXIT_LINES)

    def test_restart_publishes_before_the_log_pipe_is_emptied(self):
        watchdog, ffmpeg_error = self._build_watchdog()
        watchdog.capture_thread.is_alive.return_value = False

        watchdog.reset_capture_thread(terminate=False)

        assert ffmpeg_error.value == "\n".join(FFMPEG_EXIT_LINES)
        tail_then_dump = [
            name
            for name, _, _ in watchdog.logpipe.mock_calls
            if name in ("tail", "dump")
        ]
        assert tail_then_dump == ["tail", "dump"]

    def test_restart_without_output_keeps_the_last_error(self):
        watchdog, ffmpeg_error = self._build_watchdog()
        watchdog.capture_thread.is_alive.return_value = False
        ffmpeg_error.value = "Connection refused"
        watchdog.logpipe.tail.return_value = []

        watchdog.reset_capture_thread(terminate=False)

        assert ffmpeg_error.value == "Connection refused"

    def test_received_frames_clear_the_error(self):
        watchdog, ffmpeg_error = self._build_watchdog()
        ffmpeg_error.value = "Connection refused"
        watchdog.capture_thread.is_alive.return_value = True
        watchdog.capture_thread.current_frame.value = datetime.now().timestamp()
        watchdog.camera_fps.value = 5

        self._run_one_tick(watchdog)

        assert ffmpeg_error.value == ""

    def test_error_stays_until_a_frame_is_received(self):
        watchdog, ffmpeg_error = self._build_watchdog()
        ffmpeg_error.value = "Connection refused"
        # a restarted ffmpeg that has not produced a frame or exited yet
        watchdog.capture_thread.is_alive.return_value = True
        watchdog.capture_thread.current_frame.value = datetime.now().timestamp()
        watchdog.camera_fps.value = 0

        self._run_one_tick(watchdog)

        assert ffmpeg_error.value == "Connection refused"

    def test_healthy_ticks_do_not_write_the_shared_value(self):
        watchdog, _ = self._build_watchdog()
        writes: list[str] = []

        class CountingValue:
            # the real value lives in the manager process, every access is IPC
            @property
            def value(self) -> str:
                raise AssertionError("the shared value should not be read")

            @value.setter
            def value(self, new: str) -> None:
                writes.append(new)

        watchdog.ffmpeg_error = CountingValue()
        watchdog.capture_thread.is_alive.return_value = True
        watchdog.capture_thread.current_frame.value = datetime.now().timestamp()
        watchdog.camera_fps.value = 5

        for _ in range(3):
            self._run_one_tick(watchdog)

        # one write clears a value a crashed camera host may have left behind
        assert writes == [""]

    def test_stopping_ffmpeg_clears_the_error(self):
        watchdog, ffmpeg_error = self._build_watchdog()
        ffmpeg_error.value = "Connection refused"
        watchdog.capture_thread.is_alive.return_value = False

        with patch("frigate.video.ffmpeg.stop_ffmpeg"):
            watchdog.stop_all_ffmpeg()

        assert ffmpeg_error.value == ""

    def test_watchdog_without_error_metric(self):
        watchdog = build_watchdog()
        watchdog.ffmpeg_detect_process = MagicMock()
        watchdog.capture_thread = MagicMock()
        watchdog.capture_thread.is_alive.return_value = False
        watchdog.start_ffmpeg_detect = MagicMock()

        watchdog.reset_capture_thread(terminate=False)

        watchdog.start_ffmpeg_detect.assert_called_once()


class TestLogPipeTail(unittest.TestCase):
    def test_tail_returns_the_last_lines_without_consuming_them(self):
        logpipe = LogPipe("ffmpeg.test.detect")
        os.write(
            logpipe.fileno(),
            b"rtsp://admin:p@ss@10.0.0.1:554/video: 401 Unauthorized\n\nfirst\nsecond\n",
        )
        logpipe.close()
        logpipe.join(5)

        assert logpipe.tail(2) == ["first", "second"]
        assert logpipe.tail(5) == [
            "rtsp://*:*@10.0.0.1:554/video: 401 Unauthorized",
            "first",
            "second",
        ]

        with patch.object(logpipe.logger, "log") as log:
            logpipe.dump()

        # the lines are still there for dump()
        assert log.call_args_list[-1] == call(logpipe.level, "second")
