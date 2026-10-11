"""Create and maintain camera processes / management."""

import logging
import multiprocessing as mp
import os
import threading
import time
from multiprocessing import Queue
from multiprocessing.managers import DictProxy, SyncManager
from multiprocessing.synchronize import Event as MpEvent

import psutil

from frigate.camera import CameraMetrics, PTZMetrics
from frigate.camera.host import CameraHost, HostedCamera
from frigate.config import FrigateConfig
from frigate.config.camera import CameraConfig
from frigate.config.camera.updater import (
    CameraConfigUpdateEnum,
    CameraConfigUpdateSubscriber,
)
from frigate.config.holder import ConfigHolder
from frigate.const import REPLAY_CAMERA_PREFIX
from frigate.models import Regions
from frigate.object_detection.util import detection_frame_size
from frigate.util.builtin import empty_and_close_queue
from frigate.util.image import SharedMemoryFrameManager, UntrackedSharedMemory
from frigate.util.object import get_camera_regions_grid
from frigate.util.services import calculate_shm_requirements
from frigate.video import CameraCapture, CameraTracker

logger = logging.getLogger(__name__)

# a camera whose host died is restarted at most this often
HOST_RESTART_INTERVAL = 30

# limits how many cameras one crash can take down, while still sharing the
# memory of the Python runtime and libraries between cameras
DEFAULT_CAMERAS_PER_PROCESS = 8


def get_cameras_per_process() -> int:
    """Cameras per camera host process (FRIGATE_CAMERAS_PER_PROCESS).

    0 runs every camera as two processes, capture and tracking. N > 0 runs up
    to N cameras as threads of each camera host process.
    """
    value = os.environ.get("FRIGATE_CAMERAS_PER_PROCESS", "")
    if not value.strip():
        return DEFAULT_CAMERAS_PER_PROCESS

    try:
        return max(0, int(value))
    except ValueError:
        logger.warning(
            "Invalid FRIGATE_CAMERAS_PER_PROCESS %r, using %s cameras per process",
            value,
            DEFAULT_CAMERAS_PER_PROCESS,
        )
        return DEFAULT_CAMERAS_PER_PROCESS


class CameraMaintainer(threading.Thread):
    def __init__(
        self,
        config: FrigateConfig,
        detection_queues: dict[str, Queue],
        detected_frames_queue: Queue,
        camera_metrics: DictProxy,
        ptz_metrics: dict[str, PTZMetrics],
        stop_event: MpEvent,
        metrics_manager: SyncManager,
        config_holder: ConfigHolder | None = None,
    ):
        super().__init__(name="camera_processor")
        self.config = config
        self.detection_queues = detection_queues
        self.detected_frames_queue = detected_frames_queue
        self.stop_event = stop_event
        self.camera_metrics = camera_metrics
        self.ptz_metrics = ptz_metrics
        self.frame_manager = SharedMemoryFrameManager()
        self.region_grids: dict[str, list[list[dict[str, int]]]] = {}
        self.update_subscriber = CameraConfigUpdateSubscriber(
            self.config,
            {},
            [
                CameraConfigUpdateEnum.add,
                CameraConfigUpdateEnum.remove,
                CameraConfigUpdateEnum.refresh,
            ],
        )
        self.shm_count = self.__calculate_shm_frame_count()
        self.camera_processes: dict[str, mp.Process] = {}
        self.capture_processes: dict[str, mp.Process] = {}
        self.camera_stop_events: dict[str, MpEvent] = {}
        self.metrics_manager = metrics_manager

        # camera host mode, see frigate.camera.host
        self.cameras_per_process = get_cameras_per_process()
        self.camera_hosts: dict[str, CameraHost] = {}
        self.hosted_cameras: dict[str, HostedCamera] = {}
        self.camera_done_events: dict[str, MpEvent] = {}
        self.host_restart_times: dict[str, float] = {}
        self.host_count = 0
        # (pid, create time) of each host's children, to stop the ffmpeg
        # processes a crashed host leaves behind (they run in their own session)
        self.host_children: dict[CameraHost, set[tuple[int, float]]] = {}
        # the config as of the latest save, for rebuilding restarted cameras
        self.config_holder = config_holder

    def __ensure_camera_stop_event(self, camera: str) -> MpEvent:
        camera_stop_event = self.camera_stop_events.get(camera)

        if camera_stop_event is None:
            camera_stop_event = mp.Event()
            self.camera_stop_events[camera] = camera_stop_event
        else:
            camera_stop_event.clear()

        return camera_stop_event

    def __init_historical_regions(self) -> None:
        # delete region grids for removed or renamed cameras
        cameras = list(self.config.cameras.keys())
        Regions.delete().where(~(Regions.camera << cameras)).execute()

        # create or update region grids for each camera
        for camera in self.config.cameras.values():
            assert camera.name is not None
            model = self.config.model_for_camera(camera.name)
            self.region_grids[camera.name] = get_camera_regions_grid(
                camera.name,
                camera.detect,
                max(model.width, model.height),
            )

    def __calculate_shm_frame_count(self) -> int:
        shm_stats = calculate_shm_requirements(self.config)

        if not shm_stats:
            # /dev/shm not available
            return 0

        logger.debug(
            f"Calculated total camera size {shm_stats['available']} / "
            f"{shm_stats['camera_frame_size']} :: {shm_stats['shm_frame_count']} "
            f"frames for each camera in SHM"
        )

        if shm_stats["shm_frame_count"] < 20:
            logger.warning(
                f"The current SHM size of {shm_stats['total']}MB is too small, "
                f"recommend increasing it to at least {shm_stats['min_shm']}MB."
            )

        return int(shm_stats["shm_frame_count"])

    def __prepare_runtime_camera(self, name: str, config: CameraConfig) -> None:
        """Create the state a camera added at runtime needs before starting."""
        model = self.config.model_for_camera(name)
        self.camera_metrics[name] = CameraMetrics(self.metrics_manager)
        self.ptz_metrics[name] = PTZMetrics()
        self.region_grids[name] = get_camera_regions_grid(
            name,
            config.detect,
            max(model.width, model.height),
        )

        try:
            UntrackedSharedMemory(name=f"out-{name}", create=True, size=20 * 6 * 4)
            UntrackedSharedMemory(
                name=name,
                create=True,
                size=detection_frame_size(model),
            )
        except FileExistsError:
            pass

    def __create_frame_slots(self, config: CameraConfig, count: int) -> None:
        frame_size = config.frame_shape_yuv[0] * config.frame_shape_yuv[1]
        for i in range(count):
            self.frame_manager.create(f"{config.name}_frame{i}", frame_size)

    def __start_camera_processor(
        self, name: str, config: CameraConfig, runtime: bool = False
    ) -> None:
        if not config.enabled_in_config:
            logger.info(f"Camera processor not started for disabled camera {name}")
            return

        camera_stop_event = self.__ensure_camera_stop_event(name)
        model = self.config.model_for_camera(name)

        if runtime:
            self.__prepare_runtime_camera(name, config)

        camera_process = CameraTracker(
            config,
            model,
            model.merged_labelmap,
            self.detection_queues[model.scene],
            self.detected_frames_queue,
            self.camera_metrics[name],
            self.ptz_metrics[name],
            self.region_grids[name],
            camera_stop_event,
            self.config.logger,
        )
        self.camera_processes[name] = camera_process
        camera_process.start()
        self.camera_metrics[name].process_pid.value = camera_process.pid
        logger.info(f"Camera processor started for {name}: {camera_process.pid}")

    def __start_camera_capture(
        self, name: str, config: CameraConfig, runtime: bool = False
    ) -> None:
        if not config.enabled_in_config:
            logger.info(f"Capture process not started for disabled camera {name}")
            return

        camera_stop_event = self.__ensure_camera_stop_event(name)

        # pre-create shms
        count = 10 if runtime else self.shm_count
        self.__create_frame_slots(config, count)

        capture_process = CameraCapture(
            config,
            count,
            self.camera_metrics[name],
            camera_stop_event,
            self.config.logger,
        )
        capture_process.daemon = True
        self.capture_processes[name] = capture_process
        capture_process.start()
        self.camera_metrics[name].capture_process_pid.value = capture_process.pid
        logger.info(f"Capture process started for {name}: {capture_process.pid}")

    def __stop_camera_capture_process(self, camera: str) -> None:
        capture_process = self.capture_processes.get(camera)
        if capture_process is not None:
            logger.info(f"Waiting for capture process for {camera} to stop")
            camera_stop_event = self.camera_stop_events.get(camera)

            if camera_stop_event is not None:
                camera_stop_event.set()

            capture_process.join(timeout=10)
            if capture_process.is_alive():
                logger.warning(
                    f"Capture process for {camera} didn't exit, forcing termination"
                )
                capture_process.terminate()
                capture_process.join()

    def __start_cameras(
        self, cameras: list[tuple[str, CameraConfig]], runtime: bool = False
    ) -> None:
        """Start cameras as processes, or as threads of camera hosts."""
        if self.cameras_per_process == 0:
            for name, config in cameras:
                self.__start_camera_processor(name, config, runtime=runtime)
                self.__start_camera_capture(name, config, runtime=runtime)
            return

        enabled = []
        for name, config in cameras:
            if not config.enabled_in_config:
                logger.info("Camera processor not started for disabled camera %s", name)
                continue
            enabled.append((name, config))

        for i in range(0, len(enabled), self.cameras_per_process):
            hosted = []
            for name, config in enabled[i : i + self.cameras_per_process]:
                if runtime:
                    self.__prepare_runtime_camera(name, config)
                count = 10 if runtime else self.shm_count
                self.__create_frame_slots(config, count)
                model = self.config.model_for_camera(name)
                hosted.append(
                    HostedCamera(
                        config=config,
                        model_config=model,
                        labelmap=model.merged_labelmap,
                        detection_queue=self.detection_queues[model.scene],
                        camera_metrics=self.camera_metrics[name],
                        ptz_metrics=self.ptz_metrics[name],
                        region_grid=self.region_grids[name],
                        shm_frame_count=count,
                        stop_event=self.__ensure_camera_stop_event(name),
                        done_event=mp.Event(),
                    )
                )
            self.__start_camera_host(hosted)

    def __start_camera_host(self, hosted: list[HostedCamera]) -> None:
        self.host_count += 1
        host = CameraHost(
            str(self.host_count),
            hosted,
            self.detected_frames_queue,
            self.stop_event,
            self.config.logger,
        )
        host.start()

        names = []
        for camera in hosted:
            name = camera.config.name
            assert name is not None
            names.append(name)
            self.camera_hosts[name] = host
            self.hosted_cameras[name] = camera
            self.camera_done_events[name] = camera.done_event
        logger.info("Camera host started for %s: %s", ", ".join(names), host.pid)

    def __record_host_children(self) -> None:
        for host in set(self.camera_hosts.values()):
            if host.pid is None or not host.is_alive():
                continue

            try:
                children = psutil.Process(host.pid).children(recursive=True)
                self.host_children[host] = {(c.pid, c.create_time()) for c in children}
            except psutil.Error:
                continue

    def __stop_orphaned_children(self, host: CameraHost) -> None:
        """Stop the processes a dead host started, like its ffmpeg."""
        orphans = []
        for pid, create_time in self.host_children.pop(host, set()):
            try:
                process = psutil.Process(pid)
                # the pid may have been reused by an unrelated process
                if process.create_time() == create_time:
                    process.terminate()
                    orphans.append(process)
            except psutil.Error:
                continue

        _, alive = psutil.wait_procs(orphans, timeout=5)
        for process in alive:
            try:
                process.kill()
            except psutil.Error:
                pass

    def __current_camera(self, name: str, previous: HostedCamera) -> HostedCamera:
        """The camera's restart spec, built from the latest saved config."""
        config = self.config_holder.config if self.config_holder else None
        camera_config = config.cameras.get(name) if config else None
        if config is None or camera_config is None:
            return previous

        model = config.model_for_camera(name)
        if model.scene not in self.detection_queues:
            return HostedCamera(**{**previous.__dict__, "config": camera_config})

        return HostedCamera(
            **{
                **previous.__dict__,
                "config": camera_config,
                "model_config": model,
                "labelmap": model.merged_labelmap,
                "detection_queue": self.detection_queues[model.scene],
            }
        )

    def __restart_failed_cameras(self) -> None:
        """Restart cameras whose host died or whose threads stopped on their own."""
        now = time.monotonic()
        failed: dict[CameraHost, list[str]] = {}
        for name, host in self.camera_hosts.items():
            if not host.is_alive() or self.camera_done_events[name].is_set():
                failed.setdefault(host, []).append(name)

        for host, cameras in failed.items():
            if any(
                now - self.host_restart_times.get(name, 0) < HOST_RESTART_INTERVAL
                for name in cameras
            ):
                continue

            if host.is_alive():
                logger.error(
                    "Restarting %s, which stopped unexpectedly", ", ".join(cameras)
                )
            else:
                logger.error(
                    "Camera host for %s exited unexpectedly (exit code %s), restarting it",
                    ", ".join(cameras),
                    host.exitcode,
                )
                self.__stop_orphaned_children(host)

            restarted = []
            for name in cameras:
                self.host_restart_times[name] = now
                camera = self.__current_camera(name, self.hosted_cameras[name])
                restarted.append(
                    HostedCamera(
                        **{
                            **camera.__dict__,
                            "stop_event": self.__ensure_camera_stop_event(name),
                            "done_event": mp.Event(),
                        }
                    )
                )
            self.__start_camera_host(restarted)

            # a host whose cameras all failed exits on its own
            if host not in self.camera_hosts.values():
                host.join(timeout=10)
                self.host_children.pop(host, None)

    def __stop_hosted_cameras(self, cameras: list[str]) -> None:
        """Stop hosted cameras, then any host left without cameras."""
        hosts = {self.camera_hosts[c] for c in cameras if c in self.camera_hosts}
        for camera in cameras:
            if camera in self.camera_hosts:
                logger.info("Waiting for %s to stop", camera)
                self.camera_stop_events[camera].set()

        deadline = time.monotonic() + 20
        for camera in cameras:
            done_event = self.camera_done_events.pop(camera, None)
            if self.camera_hosts.pop(camera, None) is None or done_event is None:
                continue
            self.hosted_cameras.pop(camera, None)
            if not done_event.wait(timeout=max(0.0, deadline - time.monotonic())):
                logger.warning("%s didn't stop within 20 seconds", camera)

        for host in hosts:
            if host in self.camera_hosts.values():
                continue
            host.join(timeout=10)
            if host.is_alive():
                logger.warning(
                    "Camera host %s didn't exit, forcing termination", host.name
                )
                host.terminate()
                host.join()
            self.host_children.pop(host, None)

    def __unlink_camera_frame_slots(self, camera: str) -> None:
        """Drop the camera's per-frame YUV SHM segments from this
        process's frame_manager and unlink them at the OS level.

        Safe to call after the camera's capture/processor subprocesses
        have been joined — they no longer hold mappings, so unlink frees
        the segments immediately. Other long-lived processes that opened
        these slots will continue using their existing mappings until
        they call frame_manager.get with a shape that no longer fits
        (the get path drops and reopens stale refs).
        """
        prefix = f"{camera}_frame"
        names = [n for n in list(self.frame_manager.shm_store) if n.startswith(prefix)]
        for name in names:
            try:
                self.frame_manager.delete(name)
            except Exception as exc:
                logger.debug("Could not unlink SHM %s: %s", name, exc)

    def __stop_camera_process(self, camera: str) -> None:
        camera_process = self.camera_processes.get(camera)
        if camera_process is not None:
            logger.info(f"Waiting for process for {camera} to stop")
            camera_stop_event = self.camera_stop_events.get(camera)

            if camera_stop_event is not None:
                camera_stop_event.set()

            camera_process.join(timeout=10)
            if camera_process.is_alive():
                logger.warning(f"Process for {camera} didn't exit, forcing termination")
                camera_process.terminate()
                camera_process.join()
            logger.info(f"Closing frame queue for {camera}")
            empty_and_close_queue(self.camera_metrics[camera].frame_queue)

    def run(self) -> None:
        self.__init_historical_regions()

        # start camera processes
        self.__start_cameras(list(self.config.cameras.items()))

        while not self.stop_event.wait(1):
            if self.camera_hosts:
                self.__record_host_children()
                self.__restart_failed_cameras()

            updates = self.update_subscriber.check_for_updates()

            for update_type, updated_cameras in updates.items():
                if update_type == CameraConfigUpdateEnum.add.name:
                    for camera in updated_cameras:
                        if (
                            camera in self.camera_processes
                            or camera in self.capture_processes
                            or camera in self.camera_hosts
                        ):
                            continue

                        self.__start_cameras(
                            [(camera, self.update_subscriber.camera_configs[camera])],
                            runtime=True,
                        )
                elif update_type == CameraConfigUpdateEnum.remove.name:
                    for camera in updated_cameras:
                        self.__stop_hosted_cameras([camera])
                        self.__stop_camera_capture_process(camera)
                        self.__stop_camera_process(camera)
                        self.__unlink_camera_frame_slots(camera)
                        self.capture_processes.pop(camera, None)
                        self.camera_processes.pop(camera, None)
                        self.camera_stop_events.pop(camera, None)
                        self.region_grids.pop(camera, None)
                        self.camera_metrics.pop(camera, None)
                        self.ptz_metrics.pop(camera, None)
                elif update_type == CameraConfigUpdateEnum.refresh.name:
                    # Recycle replay cameras so detect width/height/fps
                    # propagate through ffmpeg args, SHM sizing, and the
                    # region grid. Regular cameras detect change still
                    # requires a full restart.
                    for camera in updated_cameras:
                        if not camera.startswith(REPLAY_CAMERA_PREFIX):
                            continue

                        new_config = self.update_subscriber.camera_configs.get(camera)
                        if new_config is None:
                            # remove arrived in the same batch
                            continue

                        if (
                            camera not in self.camera_processes
                            and camera not in self.capture_processes
                            and camera not in self.camera_hosts
                        ):
                            continue

                        # rebuild ffmpeg cmds on the shared config so the
                        # new subprocesses spawn with current args
                        new_config.recreate_ffmpeg_cmds()

                        self.__stop_hosted_cameras([camera])
                        self.__stop_camera_capture_process(camera)
                        self.__stop_camera_process(camera)
                        self.__unlink_camera_frame_slots(camera)
                        self.capture_processes.pop(camera, None)
                        self.camera_processes.pop(camera, None)

                        self.__start_cameras([(camera, new_config)], runtime=True)

        # ensure the hosted cameras are done
        self.__stop_hosted_cameras(list(self.camera_hosts.keys()))

        # ensure the capture processes are done
        for camera in self.capture_processes.keys():
            self.__stop_camera_capture_process(camera)

        # ensure the camera processors are done
        for camera in self.camera_processes.keys():
            self.__stop_camera_process(camera)

        self.update_subscriber.stop()
        self.frame_manager.cleanup()
