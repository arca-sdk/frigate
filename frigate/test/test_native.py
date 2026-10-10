"""Parity tests for the Rust implementations in frigate_native.

Each test runs the same inputs through the Rust code and through the original
Python code (by patching ``native`` to None) and requires identical results.
"""

import os
import random
import unittest
from unittest.mock import patch

import numpy as np

from frigate.config.camera.motion import MotionConfig
from frigate.motion import improved_motion
from frigate.motion.improved_motion import ImprovedMotionDetector
from frigate.track import norfair_tracker
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


if __name__ == "__main__":
    unittest.main(verbosity=2)
