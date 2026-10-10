//! Rust implementations of Frigate's per-frame hot paths.
//!
//! Every function reproduces the result of the Python code it replaces. When
//! an input falls outside what the Rust version handles, the function returns
//! `None` and the caller runs the original Python implementation, so edge
//! cases (including the errors they raise) behave exactly as before.

use numpy::ndarray::Array2;
use numpy::{
    dtype, IntoPyArray, PyArray2, PyArrayDescrMethods, PyReadonlyArray2, PyReadwriteArray2,
    PyUntypedArray, PyUntypedArrayMethods,
};
use pyo3::exceptions::PyValueError;
use pyo3::prelude::*;
use pyo3::types::{PyDict, PyList};
use std::sync::Arc;

pub mod motion;
pub mod region;
pub mod track;
pub mod tracker;

/// Clustering loop of `get_cluster_candidates`, one sorted list per cluster.
#[pyfunction]
fn cluster_candidates(
    frame_h: i64,
    frame_w: i64,
    min_region: i64,
    boxes: &Bound<'_, PyAny>,
) -> Option<Vec<Vec<usize>>> {
    let boxes: Vec<[f64; 4]> = boxes.extract().ok()?;
    if boxes.iter().flatten().any(|v| !v.is_finite()) {
        return None;
    }
    Some(region::cluster_candidates(
        frame_h, frame_w, min_region, &boxes,
    ))
}

fn extract_box(obj: &Bound<'_, PyAny>) -> Option<[f64; 4]> {
    let b: [f64; 4] = obj.extract().ok()?;
    b.iter().all(|v| v.is_finite()).then_some(b)
}

/// `reduce_detections`, returning indices into `detections` in output order.
#[pyfunction]
fn reduce_detections(
    frame_h: f64,
    frame_w: f64,
    detections: &Bound<'_, PyList>,
    nms_thresholds: &Bound<'_, PyDict>,
    nms_default: f64,
    consolidation_thresholds: &Bound<'_, PyDict>,
    consolidation_default: f64,
) -> PyResult<Option<Vec<usize>>> {
    let mut labels: Vec<String> = Vec::new();
    let mut parsed: Vec<region::Detection> = Vec::with_capacity(detections.len());

    for item in detections.iter() {
        let (Ok(label), Ok(score), Ok(bbox), Ok(area_key), Ok(region)) = (
            item.get_item(0).and_then(|v| v.extract::<String>()),
            item.get_item(1).and_then(|v| v.extract::<f64>()),
            item.get_item(2),
            item.get_item(3).and_then(|v| v.extract::<f64>()),
            item.get_item(5),
        ) else {
            return Ok(None);
        };
        let (Some(bbox), Some(region)) = (extract_box(&bbox), extract_box(&region)) else {
            return Ok(None);
        };
        if !score.is_finite() || !area_key.is_finite() {
            return Ok(None);
        }
        let label = match labels.iter().position(|l| *l == label) {
            Some(i) => i,
            None => {
                labels.push(label);
                labels.len() - 1
            }
        };
        parsed.push(region::Detection {
            label,
            score,
            bbox,
            area_key,
            region,
        });
    }

    let lookup = |map: &Bound<'_, PyDict>, default: f64| -> PyResult<Vec<f64>> {
        labels
            .iter()
            .map(|l| match map.get_item(l)? {
                Some(v) => v.extract::<f64>(),
                None => Ok(default),
            })
            .collect()
    };
    let nms = lookup(nms_thresholds, nms_default)?;
    let consolidation = lookup(consolidation_thresholds, consolidation_default)?;

    Ok(region::reduce_detections(
        frame_h,
        frame_w,
        &parsed,
        labels.len(),
        &nms,
        &consolidation,
    ))
}

/// Read a 2x2 numeric array of points as `f64`.
fn read_points(obj: &Bound<'_, PyAny>) -> Option<[[f64; 2]; 2]> {
    let py = obj.py();
    let array = obj.cast::<PyUntypedArray>().ok()?;
    if array.shape() != [2, 2] {
        return None;
    }
    let descr = array.dtype();
    let values: Vec<f64> = if descr.is_equiv_to(&dtype::<f64>(py)) {
        let a = obj.extract::<PyReadonlyArray2<'_, f64>>().ok()?;
        a.as_array().iter().copied().collect()
    } else if descr.is_equiv_to(&dtype::<i64>(py)) {
        let a = obj.extract::<PyReadonlyArray2<'_, i64>>().ok()?;
        a.as_array().iter().map(|&v| v as f64).collect()
    } else if descr.is_equiv_to(&dtype::<i32>(py)) {
        let a = obj.extract::<PyReadonlyArray2<'_, i32>>().ok()?;
        a.as_array().iter().map(|&v| v as f64).collect()
    } else {
        return None;
    };
    Some([[values[0], values[1]], [values[2], values[3]]])
}

/// The tracker's `distance(detection_points, estimate)`.
#[pyfunction]
fn box_distance(detection: &Bound<'_, PyAny>, estimate: &Bound<'_, PyAny>) -> Option<f64> {
    let detection = read_points(detection)?;
    let estimate = read_points(estimate)?;
    // the Python version works in float64 only for exactly representable ints
    if detection
        .iter()
        .flatten()
        .chain(estimate.iter().flatten())
        .any(|v| v.abs() > 9.0e15)
    {
        return None;
    }
    Some(track::box_distance(detection, estimate))
}

/// `(blurred_frame, thresh_dilated, contrast_index)` from `motion_preprocess`.
type MotionResult<'py> = (Bound<'py, PyArray2<u8>>, Bound<'py, PyArray2<u8>>, usize);

/// Pixel pipeline of `ImprovedMotionDetector.detect()`.
///
/// Returns `(blurred_frame, thresh_dilated, contrast_index)` and updates
/// `contrast_values` in place.
#[pyfunction]
#[allow(clippy::too_many_arguments)]
fn motion_preprocess<'py>(
    py: Python<'py>,
    frame: PyReadonlyArray2<'py, u8>,
    frame_h: usize,
    frame_w: usize,
    out_h: usize,
    out_w: usize,
    improve_contrast: bool,
    mut contrast_values: PyReadwriteArray2<'py, u8>,
    contrast_index: usize,
    mask: Option<PyReadonlyArray2<'py, u8>>,
    blur_weights: Vec<f64>,
    avg_frame: PyReadonlyArray2<'py, f32>,
    threshold: f64,
) -> PyResult<MotionResult<'py>> {
    let err = |msg: &str| PyValueError::new_err(msg.to_string());

    let shape = frame.shape();
    let stride = shape[1];
    if shape[0] < frame_h || stride < frame_w || frame_h == 0 || frame_w == 0 {
        return Err(err("frame is smaller than frame_h x frame_w"));
    }
    if out_h == 0 || out_w == 0 {
        return Err(err("motion frame size must be positive"));
    }
    let luma = frame
        .as_slice()
        .map_err(|_| err("frame must be C contiguous"))?;

    if avg_frame.shape() != [out_h, out_w] {
        return Err(err("avg_frame must match the motion frame size"));
    }
    let avg = avg_frame
        .as_slice()
        .map_err(|_| err("avg_frame must be C contiguous"))?;

    let mask_slice: &[u8] = match &mask {
        Some(m) => {
            if m.shape() != [out_h, out_w] {
                return Err(err("mask must match the motion frame size"));
            }
            m.as_slice().map_err(|_| err("mask must be C contiguous"))?
        }
        None => &[],
    };

    let radius = blur_weights.len() / 2;
    if blur_weights.len().is_multiple_of(2)
        || (1..=radius).any(|i| blur_weights[radius + i] != blur_weights[radius - i])
    {
        return Err(err("blur_weights must be an odd length symmetric kernel"));
    }

    if contrast_values.shape()[1] != 2 || contrast_values.shape()[0] == 0 {
        return Err(err("contrast_values must have shape (n, 2)"));
    }
    if contrast_index >= contrast_values.shape()[0] {
        return Err(err("contrast_index out of range"));
    }
    let contrast = contrast_values
        .as_slice_mut()
        .map_err(|_| err("contrast_values must be C contiguous"))?;
    let (contrast_pairs, _) = contrast.as_chunks_mut::<2>();

    let params = motion::MotionParams {
        luma,
        stride,
        frame_h,
        frame_w,
        out_h,
        out_w,
        improve_contrast,
        contrast_values: contrast_pairs,
        contrast_index,
        mask: mask_slice,
        blur_weights: &blur_weights,
        avg_frame: avg,
        threshold,
    };
    let result = py.detach(|| motion::motion_pipeline(params));

    let to_array = |data: Vec<u8>| -> PyResult<Bound<'py, PyArray2<u8>>> {
        Array2::from_shape_vec((out_h, out_w), data)
            .map(|a| a.into_pyarray(py))
            .map_err(|e| PyValueError::new_err(e.to_string()))
    };
    Ok((
        to_array(result.frame)?,
        to_array(result.thresh_dilated)?,
        result.contrast_index,
    ))
}

/// `numpy.ndarray.astype(int)` for one float: truncation, and the x86
/// "integer indefinite" value for anything that does not fit.
fn numpy_float_to_int(v: f64) -> i64 {
    if v.is_finite() && v > -9.223_372_036_854_776e18 && v < 9.223_372_036_854_776e18 {
        v.trunc() as i64
    } else {
        i64::MIN
    }
}

/// A tracked object returned from `NativeTracker.update`:
/// `(global_id, estimate as ints, estimate_velocity, last detection data)`.
type ActiveObject<'py> = (
    u64,
    (i64, i64, i64, i64),
    Bound<'py, PyArray2<f64>>,
    Py<PyAny>,
);

/// norfair's `Tracker` for static cameras, see `tracker.rs`.
///
/// Detections are `(label, box, data)` tuples; `data` is handed back as the
/// object's last detection data and past detections, like norfair's
/// `Detection.data`.
#[pyclass(module = "frigate_native")]
struct NativeTracker {
    tracker: tracker::Tracker<Arc<Py<PyAny>>>,
    labels: Vec<String>,
}

#[pymethods]
impl NativeTracker {
    #[new]
    #[pyo3(signature = (
        distance_threshold,
        hit_counter_max,
        initialization_delay,
        r=4.0,
        q=0.1,
        pos_variance=10.0,
        pos_vel_covariance=0.0,
        vel_variance=1.0,
        past_detections_length=4,
    ))]
    #[allow(clippy::too_many_arguments)]
    fn new(
        distance_threshold: f64,
        hit_counter_max: i64,
        initialization_delay: i64,
        r: f64,
        q: f64,
        pos_variance: f64,
        pos_vel_covariance: f64,
        vel_variance: f64,
        past_detections_length: usize,
    ) -> PyResult<Self> {
        // same validation as norfair's Tracker
        if initialization_delay < 0 || initialization_delay >= hit_counter_max {
            return Err(PyValueError::new_err(format!(
                "Argument 'initialization_delay' for 'Tracker' class should be an int between 0 and (hit_counter_max = {hit_counter_max}). The selected value is {initialization_delay}.\n"
            )));
        }
        Ok(NativeTracker {
            tracker: tracker::Tracker::new(tracker::TrackerConfig {
                distance_threshold,
                hit_counter_max,
                initialization_delay,
                past_detections_length,
                filter: tracker::FilterParams {
                    r,
                    q,
                    pos_variance,
                    pos_vel_covariance,
                    vel_variance,
                },
            }),
            labels: Vec::new(),
        })
    }

    /// `Tracker.update(detections)`; returns the active objects in order.
    fn update<'py>(
        &mut self,
        py: Python<'py>,
        detections: &Bound<'py, PyList>,
    ) -> PyResult<Vec<ActiveObject<'py>>> {
        let mut parsed = Vec::with_capacity(detections.len());
        for item in detections.iter() {
            let (label, points, data): (String, [f64; 4], Py<PyAny>) = item.extract()?;
            let label = match self.labels.iter().position(|l| *l == label) {
                Some(i) => i,
                None => {
                    self.labels.push(label);
                    self.labels.len() - 1
                }
            };
            parsed.push(tracker::Detection {
                label,
                points,
                data: Arc::new(data),
            });
        }

        let active = self.tracker.update(parsed).map_err(PyValueError::new_err)?;

        active
            .into_iter()
            .map(|i| {
                let obj = &self.tracker.objects[i];
                let e = obj.estimate_points();
                let estimate = (
                    numpy_float_to_int(e[0]),
                    numpy_float_to_int(e[1]),
                    numpy_float_to_int(e[2]),
                    numpy_float_to_int(e[3]),
                );
                let velocity = Array2::from_shape_vec((2, 2), obj.velocity().to_vec())
                    .map_err(|e| PyValueError::new_err(e.to_string()))?
                    .into_pyarray(py);
                let global_id = obj.global_id.expect("active objects have ids");
                Ok((global_id, estimate, velocity, obj.last_data.clone_ref(py)))
            })
            .collect()
    }

    /// Data of the past detections kept for `global_id`, oldest first.
    fn past_detection_data(&self, py: Python<'_>, global_id: u64) -> Option<Vec<Py<PyAny>>> {
        self.tracker
            .objects
            .iter()
            .find(|o| o.global_id == Some(global_id))
            .map(|o| {
                o.past_detections
                    .iter()
                    .map(|(_, d)| d.clone_ref(py))
                    .collect()
            })
    }

    /// Drop the object with `global_id`, like filtering `tracked_objects`.
    fn remove(&mut self, global_id: u64) {
        self.tracker
            .objects
            .retain(|o| o.global_id != Some(global_id));
    }

    /// Forget every object, like `tracker.tracked_objects = []`.
    fn clear(&mut self) {
        self.tracker.objects.clear();
    }

    fn __len__(&self) -> usize {
        self.tracker.objects.len()
    }
}

/// The four `np.percentile` calls of `NorfairTracker.update_position`:
/// 15th percentile of the x/y minimums and 85th of the x/y maximums.
#[pyfunction]
fn position_percentiles(
    xmins: Vec<f64>,
    ymins: Vec<f64>,
    xmaxs: Vec<f64>,
    ymaxs: Vec<f64>,
) -> Option<(f64, f64, f64, f64)> {
    let lists = [&xmins, &ymins, &xmaxs, &ymaxs];
    if lists
        .iter()
        .any(|l| l.is_empty() || l.iter().any(|v| !v.is_finite()))
    {
        return None;
    }
    Some((
        tracker::percentile(&xmins, 15.0),
        tracker::percentile(&ymins, 15.0),
        tracker::percentile(&xmaxs, 85.0),
        tracker::percentile(&ymaxs, 85.0),
    ))
}

#[pymodule]
fn frigate_native(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add("__version__", env!("CARGO_PKG_VERSION"))?;
    m.add_function(wrap_pyfunction!(cluster_candidates, m)?)?;
    m.add_function(wrap_pyfunction!(reduce_detections, m)?)?;
    m.add_function(wrap_pyfunction!(box_distance, m)?)?;
    m.add_function(wrap_pyfunction!(motion_preprocess, m)?)?;
    m.add_function(wrap_pyfunction!(position_percentiles, m)?)?;
    m.add_class::<NativeTracker>()?;
    Ok(())
}
