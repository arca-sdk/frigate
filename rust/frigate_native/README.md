# frigate_native

Rust implementations of code that runs on every frame of every camera. Each
function returns exactly the same result as the Python code it replaces; the
Python versions stay in place as the reference and as the fallback.

| Function | Replaces | Speedup (CPU) |
| --- | --- | --- |
| `motion_preprocess` | pixel pipeline of `ImprovedMotionDetector.detect()` (resize, contrast, mask, blur, frame delta, threshold, dilate) | 3x without contrast, 6x with contrast (the default) |
| `box_distance` | `distance()` used by the norfair tracker for every detection/object pair | ~100x per pair |
| `cluster_candidates` | clustering loop of `get_cluster_candidates()` | 4x (5 boxes) to 20x (40 boxes) |
| `reduce_detections` | `reduce_detections()` (per label NMS and consolidation) | 3-4x |

Contour extraction in the motion detector stays in OpenCV, because the order of
the contours it returns determines how motion boxes are clustered.

End to end, with 8 cameras looping a 768x432 clip at 5 fps on the CPU detector
(12 core x86-64), camera tracking processes used:

| Build | Tracking CPU | Frames processed per camera | CPU per processed frame |
| --- | --- | --- | --- |
| upstream | 146% of a core | 1.4 fps | ~130 ms |
| this fork, `FRIGATE_DISABLE_NATIVE=1` | 14.7% | 2.8 fps | 6.6 ms |
| this fork, Rust enabled | 12.1% | 2.9 fps | 5.2 ms |

Most of the gain comes from running OpenCV single threaded in the camera
tracking processes (see below); the Rust code takes another ~20% off what
remains. All three runs tracked the same objects.

Detector input preparation (crop, YUV to RGB, resize) was also ported and is
bit-exact, but OpenCV's SIMD code is as fast single threaded, so it was dropped.
The real cost there was OpenCV spreading tiny images over a thread pool, which
is now disabled in the camera tracking process instead.

## How it is used

`frigate/util/native.py` imports the module if it is available. Callers use it
when present and fall back to Python when it is missing or returns `None` for
input it does not handle, so edge cases (including the errors Python would
raise) behave as before.

Set `FRIGATE_DISABLE_NATIVE=1` to force the Python implementations, for example
to compare behavior. Frigate logs at startup which implementation it uses.

## Building

The Docker build compiles it in the `native-build` stage and places the module
next to the `frigate` package in `/opt/frigate`, so every image variant built
from the shared `rootfs` stage includes it.

To build a wheel by hand (needs Rust and `pip install maturin`):

```bash
cd rust/frigate_native
maturin build --release
```

The hot loops are compiled twice, once for baseline x86-64 and once for AVX2,
and the right version is picked at runtime. AVX2 does not enable FMA, so
floating point results are identical either way.

## Testing

`frigate/test/test_native.py` runs randomized inputs through both
implementations and requires identical results. It is skipped when the module
is not installed.

```bash
python3 -u -m unittest frigate.test.test_native
```
