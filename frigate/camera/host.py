"""Run the capture and tracking of several cameras as threads of one process.

By default every camera runs two processes (capture and tracking). A camera
host runs the same code for a group of cameras as threads of a single process:
fewer processes and less memory, and each camera's frames are handed from its
capture thread to its tracking thread through an in-process queue instead of
the multiprocessing manager.
"""

import logging
import queue
import threading
from dataclasses import dataclass
from multiprocessing import Queue
from multiprocessing.synchronize import Event as MpEvent
from typing import Any

import cv2

from frigate.camera import CameraMetrics, PTZMetrics
from frigate.config import CameraConfig, LoggerConfig
from frigate.const import PROCESS_PRIORITY_HIGH
from frigate.detectors.detector_config import ModelConfig
from frigate.util.process import FrigateProcess
from frigate.util.services import set_file_limit
from frigate.video.detect import track_camera
from frigate.video.ffmpeg import CameraWatchdog

logger = logging.getLogger(__name__)


@dataclass
class HostedCamera:
    """Everything a camera's capture and tracking threads need."""

    config: CameraConfig
    model_config: ModelConfig
    labelmap: dict[int, str]
    detection_queue: Queue
    camera_metrics: CameraMetrics
    ptz_metrics: PTZMetrics
    region_grid: list[list[dict[str, Any]]]
    shm_frame_count: int
    # set by the camera maintainer to stop this camera
    stop_event: MpEvent
    # set by the host once both of the camera's threads have exited
    done_event: MpEvent


class CameraHost(FrigateProcess):
    def __init__(
        self,
        name: str,
        cameras: list[HostedCamera],
        detected_frames_queue: Queue,
        stop_event: MpEvent,
        log_config: LoggerConfig | None = None,
    ) -> None:
        super().__init__(
            stop_event,
            PROCESS_PRIORITY_HIGH,
            name=f"frigate.cameras:{name}",
            daemon=True,
        )
        self.cameras = cameras
        self.detected_frames_queue = detected_frames_queue
        self.log_config = log_config

    def run(self) -> None:
        self.pre_run_setup(self.log_config)

        # every camera keeps a file descriptor open per shared memory frame
        # slot, which adds up past the default soft limit of 1024 with a few
        # cameras in one process
        set_file_limit()

        # all OpenCV work here is on small images, see CameraTracker.run
        cv2.setNumThreads(1)

        running = [(camera, *self._start_camera(camera)) for camera in self.cameras]

        # report each camera as done once both its threads are gone, so the
        # maintainer can stop cameras individually; exit when none are left
        while running:
            for entry in list(running):
                camera, watchdog, tracker = entry
                for thread in (watchdog, tracker):
                    thread.join(timeout=0.5 / len(running))
                alive = [t for t in (watchdog, tracker) if t.is_alive()]

                if len(alive) == 1 and not camera.stop_event.is_set():
                    # one thread stopped on its own: stop the other as well so
                    # the camera is reported done and the maintainer restarts it
                    logger.error(
                        "%s: the %s thread stopped unexpectedly, stopping the camera",
                        camera.config.name,
                        "tracking" if alive[0] is watchdog else "capture",
                    )
                    camera.stop_event.set()

                if not alive:
                    self._stop_ffmpeg(camera, watchdog)
                    camera.done_event.set()
                    running.remove(entry)

        logger.info("All hosted cameras stopped, exiting")

    @staticmethod
    def _stop_ffmpeg(camera: HostedCamera, watchdog: CameraWatchdog) -> None:
        """Stop ffmpeg processes a crashed watchdog left behind.

        ffmpeg runs in its own session, so nothing else stops it; after a
        clean exit the watchdog already did and this does nothing.
        """
        try:
            watchdog.stop_all_ffmpeg()
        except Exception:
            logger.exception("Failed to stop ffmpeg for %s", camera.config.name)

    def _start_camera(
        self, camera: HostedCamera
    ) -> tuple[CameraWatchdog, threading.Thread]:
        name = camera.config.name
        metrics = camera.camera_metrics
        # capture and tracking of the same camera share frames in-process
        frame_queue: queue.Queue = queue.Queue(maxsize=2)

        watchdog = CameraWatchdog(
            camera.config,
            camera.shm_frame_count,
            frame_queue,
            metrics.camera_fps,
            metrics.skipped_fps,
            metrics.ffmpeg_pid,
            metrics.stalls_last_hour,
            metrics.reconnects_last_hour,
            metrics.detection_frame,
            camera.stop_event,
            capture_thread_id=metrics.capture_process_pid,
        )

        def track() -> None:
            # per thread CPU is reported against the camera's process id
            metrics.process_pid.value = threading.get_native_id()
            try:
                track_camera(
                    camera.config,
                    camera.model_config,
                    camera.labelmap,
                    camera.detection_queue,
                    self.detected_frames_queue,
                    metrics,
                    camera.ptz_metrics,
                    camera.region_grid,
                    camera.stop_event,
                    frame_queue,
                )
            except Exception:
                # keep the other cameras of this host running
                logger.exception("Tracking for %s stopped with an error", name)

        tracker = threading.Thread(target=track, name=f"process:{name}", daemon=True)
        watchdog.daemon = True
        watchdog.start()
        tracker.start()
        logger.info("Started capture and tracking threads for %s", name)
        return watchdog, tracker
