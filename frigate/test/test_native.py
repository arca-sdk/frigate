"""Parity tests for the Rust implementations in frigate_native.

Each test runs the same inputs through the Rust code and through the original
Python code (by patching ``native`` to None) and requires identical results.
"""

import copy
import os
import random
import unittest
from unittest.mock import patch

import numpy as np

from frigate.camera import PTZMetrics
from frigate.config import FrigateConfig
from frigate.config.camera.motion import MotionConfig
from frigate.motion import improved_motion
from frigate.motion.improved_motion import ImprovedMotionDetector
from frigate.track import norfair_tracker
from frigate.track.norfair_tracker import NorfairTracker
from frigate.util import native as native_module
from frigate.util import object as object_util
from frigate.util.native import native

FRAME_SHAPE = (720, 1280)


def random_box(rng: random.Random, max_size: int = 300) -> tuple[int, int, int, int]:
    x = rng.randint(-20, FRAME_SHAPE[1])
    y = rng.randint(-20, FRAME_SHAPE[0])
    return (x, y, x + rng.randint(0, max_size), y + rng.randint(0, max_size))


class TestNativeLoading(unittest.TestCase):
    def test_disabled_by_environment(self):
        with patch.dict(os.environ, {"FRIGATE_DISABLE_NATIVE": "1"}):
            self.assertIsNone(native_module._load_native())


@unittest.skipIf(native is None, "frigate_native is not installed")
class TestNativeRegions(unittest.TestCase):
    def python_clusters(self, min_region, boxes):
        with patch.object(object_util, "native", None):
            return object_util.get_cluster_candidates(FRAME_SHAPE, min_region, boxes)

    def test_cluster_candidates_match_python(self):
        rng = random.Random(1)
        for _ in range(500):
            boxes = [random_box(rng) for _ in range(rng.randint(0, 40))]
            min_region = rng.choice([300, 320, 416])
            self.assertEqual(
                object_util.get_cluster_candidates(FRAME_SHAPE, min_region, boxes),
                self.python_clusters(min_region, boxes),
            )

    def test_cluster_candidates_with_float_boxes(self):
        rng = random.Random(2)
        for _ in range(200):
            boxes = [
                tuple(v + rng.random() for v in random_box(rng))
                for _ in range(rng.randint(1, 20))
            ]
            self.assertEqual(
                object_util.get_cluster_candidates(FRAME_SHAPE, 320, boxes),
                self.python_clusters(320, boxes),
            )

    def test_cluster_candidates_unsupported_input_returns_none(self):
        self.assertIsNone(
            native.cluster_candidates(720, 1280, 320, [(0, 0, float("nan"), 10)])
        )
        self.assertIsNone(native.cluster_candidates(720, 1280, 320, [(0, 0, 10)]))

    def random_detections(self, rng):
        detections = []
        centers = [
            (rng.randint(0, FRAME_SHAPE[1]), rng.randint(0, FRAME_SHAPE[0]))
            for _ in range(rng.randint(1, 4))
        ]
        for _ in range(rng.randint(0, 25)):
            cx, cy = rng.choice(centers)
            width, height = rng.randint(1, 200), rng.randint(1, 200)
            x, y = cx + rng.randint(-30, 30), cy + rng.randint(-30, 30)
            size = rng.choice([320, 416, 640])
            rx = max(0, min(FRAME_SHAPE[1] - size, x - rng.randint(0, 40)))
            ry = max(0, min(FRAME_SHAPE[0] - size, y - rng.randint(0, 40)))
            detections.append(
                (
                    rng.choice(["person", "car", "face", "dog"]),
                    rng.choice([0.5, 0.6, 0.7, 0.71, 0.9, round(rng.random(), 3)]),
                    (x, y, x + width, y + height),
                    width * height,
                    width / height,
                    (rx, ry, rx + size, ry + size),
                )
            )
        return detections

    def test_reduce_detections_match_python(self):
        rng = random.Random(3)
        reduced = 0
        for _ in range(500):
            detections = self.random_detections(rng)
            result = object_util.reduce_detections(FRAME_SHAPE, detections)
            with patch.object(object_util, "native", None):
                expected = object_util.reduce_detections(FRAME_SHAPE, detections)
            self.assertEqual(result, expected)
            reduced += len(detections) - len(result)

        # make sure suppression and consolidation were actually exercised
        self.assertGreater(reduced, 500)

    def test_reduce_detections_unsupported_input_returns_none(self):
        detection = (1, 0.9, (0, 0, 10, 10), 100, 1.0, (0, 0, 320, 320))
        self.assertIsNone(
            native.reduce_detections(720, 1280, [detection], {}, 0.4, {}, 0.9)
        )


@unittest.skipIf(native is None, "frigate_native is not installed")
class TestNativeTracker(unittest.TestCase):
    def test_distance_matches_python(self):
        rng = random.Random(4)
        np_rng = np.random.default_rng(4)
        for _ in range(2000):
            x, y = rng.randint(0, 1200), rng.randint(0, 700)
            detection = np.array(
                [[x, y], [x + rng.randint(-2, 200), y + rng.randint(-2, 200)]]
            )
            estimate = detection + np_rng.normal(0, rng.choice([0.5, 5, 30]), (2, 2))
            self.assertEqual(
                native.box_distance(detection, estimate),
                norfair_tracker.distance(detection, estimate),
            )

    def test_degenerate_boxes_are_infinitely_far(self):
        detection = np.array([[10, 10], [10, 50]])
        estimate = np.array([[10.0, 10.0], [30.0, 50.0]])
        self.assertEqual(native.box_distance(detection, estimate), float("inf"))

    def test_unsupported_dtype_returns_none(self):
        detection = np.array([[10, 10], [20, 50]], dtype=np.uint8)
        estimate = np.array([[10.0, 10.0], [30.0, 50.0]])
        self.assertIsNone(native.box_distance(detection, estimate))


@unittest.skipIf(native is None, "frigate_native is not installed")
class TestNativeMotion(unittest.TestCase):
    def make_detector(self, height, width, masked, use_native, **config):
        motion_config = MotionConfig(**config)
        mask = np.full((height, width), 255, dtype=np.uint8)
        if masked:
            mask[: height // 4, : width // 3] = 0
        object.__setattr__(motion_config, "rasterized_mask", mask)
        if use_native:
            return ImprovedMotionDetector((height, width), motion_config, fps=5)
        with patch.object(improved_motion, "native", None):
            return ImprovedMotionDetector((height, width), motion_config, fps=5)

    def frames(self, height, width, count, seed):
        """YUV frames of a noisy scene with moving objects and a light change."""
        rng = np.random.default_rng(seed)
        background = rng.integers(40, 200, size=(height, width)).astype(np.float32)
        for t in range(count):
            frame = background * (1.6 if t == count // 2 else 1.0)
            x = (20 + t * 9) % (width - 60)
            frame[height // 3 : height // 3 + 50, x : x + 40] = 250 if t % 2 else 10
            frame += rng.normal(0, 4, size=(height, width))
            luma = np.clip(frame, 0, 255).astype(np.uint8)
            chroma = rng.integers(100, 156, size=(height // 2, width), dtype=np.uint8)
            yield np.ascontiguousarray(np.vstack([luma, chroma]))

    def test_motion_matches_python(self):
        cases = [
            dict(improve_contrast=True),
            dict(improve_contrast=False),
            dict(improve_contrast=True, frame_height=50, threshold=15),
            dict(improve_contrast=True, frame_height=None),
        ]
        for case_index, config in enumerate(cases):
            for masked in (False, True):
                with self.subTest(config=config, masked=masked):
                    rust = self.make_detector(360, 640, masked, True, **config)
                    python = self.make_detector(360, 640, masked, False, **config)
                    frames_with_motion = 0
                    for frame in self.frames(360, 640, 40, case_index):
                        boxes = rust.detect(frame)
                        with patch.object(improved_motion, "native", None):
                            expected = python.detect(frame)
                        self.assertEqual(boxes, expected)
                        np.testing.assert_array_equal(rust.avg_frame, python.avg_frame)
                        np.testing.assert_array_equal(
                            rust.contrast_values, python.contrast_values
                        )
                        self.assertEqual(rust.calibrating, python.calibrating)
                        frames_with_motion += bool(boxes)
                    self.assertGreater(frames_with_motion, 0)

    def test_native_pipeline_is_used(self):
        detector = self.make_detector(360, 640, False, True)
        with patch.object(
            improved_motion.native,
            "motion_preprocess",
            wraps=native.motion_preprocess,
        ) as spy:
            detector.detect(next(self.frames(360, 640, 1, 0)))
        spy.assert_called_once()


def tracker_scene(seed: int, frames: int, max_objects: int):
    """Detections of objects that move, stand still, appear and vanish."""
    rng = random.Random(seed)
    objects: list[dict] = []
    frame_time = 1_700_000_000.0
    for _ in range(frames):
        frame_time += 0.2
        if len(objects) < max_objects and rng.random() < 0.15:
            w, h = rng.randint(30, 200), rng.randint(40, 300)
            moving = rng.random() < 0.7
            objects.append(
                {
                    "label": rng.choice(["person", "person", "car", "dog", "cat"]),
                    "x": rng.uniform(0, 1280 - w),
                    "y": rng.uniform(0, 720 - h),
                    "w": w,
                    "h": h,
                    "vx": rng.uniform(-12, 12) if moving else 0.0,
                    "vy": rng.uniform(-6, 6) if moving else 0.0,
                    "life": rng.randint(5, 150),
                }
            )
        detections = []
        for o in objects:
            o["x"] = min(max(0.0, o["x"] + o["vx"]), 1280 - o["w"] - 1)
            o["y"] = min(max(0.0, o["y"] + o["vy"]), 720 - o["h"] - 1)
            o["life"] -= 1
            if rng.random() < 0.1:
                continue  # missed detection
            x1 = max(0, int(o["x"]) + rng.randint(-3, 3))
            y1 = max(0, int(o["y"]) + rng.randint(-3, 3))
            x2 = min(1279, int(o["x"] + o["w"]) + rng.randint(-3, 3))
            y2 = min(719, int(o["y"] + o["h"]) + rng.randint(-3, 3))
            if x2 <= x1 or y2 <= y1:
                continue
            region = (
                max(0, x1 - 50),
                max(0, y1 - 50),
                max(0, x1 - 50) + 320,
                max(0, y1 - 50) + 320,
            )
            detections.append(
                (
                    o["label"],
                    round(rng.uniform(0.5, 0.95), 2),
                    (x1, y1, x2, y2),
                    (x2 - x1) * (y2 - y1),
                    (x2 - x1) / (y2 - y1),
                    region,
                )
            )
        objects = [o for o in objects if o["life"] > 0]
        rng.shuffle(detections)
        yield frame_time, detections


@unittest.skipIf(native is None, "frigate_native is not installed")
class TestNativeObjectTracker(unittest.TestCase):
    """The Rust tracker must leave NorfairTracker in exactly the same state."""

    def camera_config(self, **detect):
        config = FrigateConfig(
            **{
                "mqtt": {"enabled": False},
                "cameras": {
                    "front": {
                        "ffmpeg": {
                            "inputs": [
                                {"path": "rtsp://10.0.0.1/live", "roles": ["detect"]}
                            ]
                        },
                        "detect": {"width": 1280, "height": 720, "fps": 5, **detect},
                        "objects": {"track": ["person", "car", "dog"]},
                    }
                },
            }
        )
        return config.cameras["front"]

    def run_tracker(self, config, frames, use_native: bool, seed: int):
        # object ids are random, so seed both runs the same way
        random.seed(seed)
        states = []
        with patch.object(norfair_tracker, "native", native if use_native else None):
            tracker = NorfairTracker(config, PTZMetrics())
            self.assertEqual(tracker.use_native, use_native)
            for frame_time, detections in frames:
                tracker.match_and_update("frame", frame_time, detections)
                states.append(
                    copy.deepcopy(
                        (
                            tracker.tracked_objects,
                            tracker.disappeared,
                            tracker.positions,
                            tracker.stationary_box_history,
                            tracker.untracked_object_boxes,
                        )
                    )
                )
        return states

    def test_tracker_matches_norfair(self):
        cases = [
            {},
            {"min_initialized": 3, "max_disappeared": 10},
            {"min_initialized": 2, "max_disappeared": 4},
            {"stationary": {"max_frames": {"default": 20}, "threshold": 3}},
        ]
        registered = 0
        for seed, detect in enumerate(cases):
            with self.subTest(detect=detect):
                config = self.camera_config(**detect)
                frames = list(tracker_scene(seed, 250, max_objects=12))
                expected = self.run_tracker(config, frames, False, seed)
                result = self.run_tracker(config, frames, True, seed)
                for frame, (a, b) in enumerate(zip(result, expected)):
                    # numpy arrays inside the objects need array comparisons
                    np.testing.assert_equal(a, b, err_msg=f"frame {frame}")
                registered += len({k for state in expected for k in state[0]})
        self.assertGreater(registered, 100)

    def test_ptz_autotracking_keeps_norfair(self):
        config = self.camera_config()
        config.onvif.autotracking.enabled_in_config = True
        tracker = NorfairTracker(config, PTZMetrics())
        self.assertFalse(tracker.use_native)

    def test_clear_forgets_objects(self):
        config = self.camera_config()
        tracker = NorfairTracker(config, PTZMetrics())
        for frame_time, detections in tracker_scene(1, 30, max_objects=5):
            tracker.match_and_update("frame", frame_time, detections)
        self.assertTrue(tracker.tracked_objects)
        tracker.clear()
        self.assertEqual(tracker.tracked_objects, {})
        self.assertEqual(sum(len(t) for t in tracker._all_trackers()), 0)

    def test_position_percentiles_match_numpy(self):
        rng = random.Random(5)
        for _ in range(500):
            lists = [
                [rng.randint(0, 1280) for _ in range(rng.randint(1, 10))]
                for _ in range(4)
            ]
            expected = (
                np.percentile(lists[0], 15),
                np.percentile(lists[1], 15),
                np.percentile(lists[2], 85),
                np.percentile(lists[3], 85),
            )
            self.assertEqual(native.position_percentiles(*lists), expected)


if __name__ == "__main__":
    unittest.main(verbosity=2)
