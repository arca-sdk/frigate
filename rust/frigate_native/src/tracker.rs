//! Port of the parts of norfair's `Tracker` that Frigate uses.
//!
//! Covers `Tracker.update()` with a scalar distance (Frigate's `distance()`),
//! `OptimizedKalmanFilter`, hit counters, initialization delay and past
//! detections. Not covered, because Frigate only uses them for PTZ cameras
//! with autotracking (which keep using norfair): ReID matching, coordinate
//! transformations, per point scores and `period` other than 1. Per point hit
//! counters are omitted too; without scores they never affect the result.
//!
//! Floating point operations follow norfair and numpy order exactly, so the
//! matches, estimates and object lifecycles are identical.

use std::sync::atomic::{AtomicU64, Ordering};

use crate::track::box_distance;

/// norfair's `_TrackedObjectFactory.global_count`, shared by every tracker in
/// the process like the Python class attribute.
static GLOBAL_COUNT: AtomicU64 = AtomicU64::new(0);

fn next_global_id() -> u64 {
    GLOBAL_COUNT.fetch_add(1, Ordering::Relaxed) + 1
}

#[derive(Clone, Copy)]
pub struct FilterParams {
    pub r: f64,
    pub q: f64,
    pub pos_variance: f64,
    pub pos_vel_covariance: f64,
    pub vel_variance: f64,
}

/// `OptimizedKalmanFilter` for one box (four coordinates), measured with an
/// identity H matrix and no R override, as norfair does for detections
/// without scores.
struct Filter {
    x_pos: [f64; 4],
    x_vel: [f64; 4],
    pos_variance: [f64; 4],
    pos_vel_covariance: [f64; 4],
    vel_variance: [f64; 4],
}

impl Filter {
    fn new(points: [f64; 4], p: &FilterParams) -> Self {
        Filter {
            x_pos: points,
            x_vel: [0.0; 4],
            pos_variance: [0.0 + p.pos_variance; 4],
            pos_vel_covariance: [0.0 + p.pos_vel_covariance; 4],
            vel_variance: [0.0 + p.vel_variance; 4],
        }
    }

    fn predict(&mut self) {
        for i in 0..4 {
            self.x_pos[i] += self.x_vel[i];
        }
    }

    #[allow(clippy::needless_range_loop)]
    fn update(&mut self, z: [f64; 4], p: &FilterParams) {
        // H is the identity, so diagonal = 1 and one_minus_diagonal = 0; the
        // multiplications by them are kept to match numpy bit for bit
        let (diagonal, one_minus_diagonal) = (1.0_f64, 0.0_f64);
        let kalman_r = p.r * 1.0;
        for i in 0..4 {
            let error = (z[i] - self.x_pos[i]) * diagonal;
            let vel_var_plus_pos_vel_cov = self.pos_vel_covariance[i] + self.vel_variance[i];
            let added_variances = self.pos_variance[i]
                + self.pos_vel_covariance[i]
                + vel_var_plus_pos_vel_cov
                + p.q
                + kalman_r;
            let kalman_r_over_added = kalman_r / added_variances;
            let vel_over_added = vel_var_plus_pos_vel_cov / added_variances;
            let added_variances_or_kalman_r =
                added_variances * one_minus_diagonal + kalman_r * diagonal;

            self.x_pos[i] += diagonal * ((1.0 - kalman_r_over_added) * error);
            self.x_vel[i] += diagonal * (vel_over_added * error);

            self.pos_variance[i] = (1.0 - kalman_r_over_added) * added_variances_or_kalman_r;
            self.pos_vel_covariance[i] = vel_over_added * added_variances_or_kalman_r;
            self.vel_variance[i] +=
                p.q - diagonal * ((vel_over_added * vel_over_added) * added_variances);
        }
    }

    /// The estimate as `[[x_min, y_min], [x_max, y_max]]`.
    fn estimate(&self) -> [[f64; 2]; 2] {
        [
            [self.x_pos[0], self.x_pos[1]],
            [self.x_pos[2], self.x_pos[3]],
        ]
    }
}

/// A detection fed to the tracker; `D` is whatever the caller attaches.
pub struct Detection<D> {
    pub label: usize,
    pub points: [f64; 4],
    pub data: D,
}

pub struct TrackedObject<D> {
    pub global_id: Option<u64>,
    pub label: usize,
    pub hit_counter: i64,
    pub is_initializing: bool,
    pub age: i64,
    pub last_data: D,
    /// `(age when added, data)`, spread over the object's lifetime
    pub past_detections: Vec<(i64, D)>,
    filter: Filter,
}

impl<D: Clone> TrackedObject<D> {
    pub fn estimate_points(&self) -> [f64; 4] {
        self.filter.x_pos
    }

    pub fn velocity(&self) -> [f64; 4] {
        self.filter.x_vel
    }

    fn step(&mut self) {
        self.hit_counter -= 1;
        self.age += 1;
        self.filter.predict();
    }

    fn add_to_past_detections(&mut self, data: &D, past_detections_length: usize) {
        if past_detections_length == 0 {
            return;
        }
        if self.past_detections.len() < past_detections_length {
            self.past_detections.push((self.age, data.clone()));
        } else if self.age >= self.past_detections[0].0 * past_detections_length as i64 {
            self.past_detections.remove(0);
            self.past_detections.push((self.age, data.clone()));
        }
    }
}

pub struct TrackerConfig {
    pub distance_threshold: f64,
    pub hit_counter_max: i64,
    pub initialization_delay: i64,
    pub past_detections_length: usize,
    pub filter: FilterParams,
}

pub struct Tracker<D> {
    pub config: TrackerConfig,
    pub objects: Vec<TrackedObject<D>>,
}

/// Distances come back from the distance function as Python floats, are
/// stored in a float32 matrix, and are compared against the Python float
/// threshold in float64.
const NAN_ERROR: &str =
    "\nReceived nan values from distance function, please check your distance function for errors!";

impl<D: Clone> Tracker<D> {
    pub fn new(config: TrackerConfig) -> Self {
        Tracker {
            config,
            objects: Vec::new(),
        }
    }

    /// `Tracker.update()`: returns the indices of active objects, in order.
    pub fn update(&mut self, detections: Vec<Detection<D>>) -> Result<Vec<usize>, &'static str> {
        // remove stale trackers
        self.objects.retain(|o| o.hit_counter >= 0);

        for obj in self.objects.iter_mut() {
            obj.step();
        }

        let detections: Vec<Option<Detection<D>>> = detections.into_iter().map(Some).collect();
        let all: Vec<usize> = (0..detections.len()).collect();

        // initialized objects first, then the ones still initializing get
        // the detections that are left
        let initialized: Vec<usize> = (0..self.objects.len())
            .filter(|&i| !self.objects[i].is_initializing)
            .collect();
        let initializing: Vec<usize> = (0..self.objects.len())
            .filter(|&i| self.objects[i].is_initializing)
            .collect();
        let mut detections = detections;
        let unmatched = self.update_objects_in_place(&initialized, &all, &mut detections)?;
        let unmatched = self.update_objects_in_place(&initializing, &unmatched, &mut detections)?;

        for d in unmatched {
            let detection = detections[d].take().expect("detection used twice");
            self.create(detection);
        }

        Ok((0..self.objects.len())
            .filter(|&i| !self.objects[i].is_initializing && self.objects[i].hit_counter >= 0)
            .collect())
    }

    /// `_update_objects_in_place` for detections; returns unmatched detections.
    fn update_objects_in_place(
        &mut self,
        objects: &[usize],
        candidates: &[usize],
        detections: &mut [Option<Detection<D>>],
    ) -> Result<Vec<usize>, &'static str> {
        if candidates.is_empty() {
            return Ok(Vec::new());
        }

        // ScalarDistance.get_distances: float32 matrix, inf across labels
        let cols = objects.len();
        let mut matrix = vec![f32::INFINITY; candidates.len() * cols];
        for (c, &cand) in candidates.iter().enumerate() {
            let det = detections[cand].as_ref().expect("missing detection");
            let det_points = [
                [det.points[0], det.points[1]],
                [det.points[2], det.points[3]],
            ];
            for (o, &obj) in objects.iter().enumerate() {
                let tracked = &self.objects[obj];
                if det.label != tracked.label {
                    continue;
                }
                matrix[c * cols + o] = box_distance(det_points, tracked.filter.estimate()) as f32;
            }
        }
        if matrix.iter().any(|d| d.is_nan()) {
            return Err(NAN_ERROR);
        }

        let matches = match_dets_and_objs(&matrix, cols, self.config.distance_threshold);
        if matches.is_empty() {
            return Ok(candidates.to_vec());
        }

        let mut unmatched: Vec<usize> = candidates
            .iter()
            .enumerate()
            .filter(|(c, _)| !matches.iter().any(|m| m.0 == *c))
            .map(|(_, &d)| d)
            .collect();

        for &(c, o) in &matches {
            let distance = matrix[c * cols + o];
            if (distance as f64) < self.config.distance_threshold {
                let det = detections[candidates[c]]
                    .take()
                    .expect("detection matched twice");
                self.hit(objects[o], det);
            } else {
                unmatched.push(candidates[c]);
            }
        }
        Ok(unmatched)
    }

    /// `TrackedObject.hit()` with period 1 and no point scores.
    fn hit(&mut self, index: usize, detection: Detection<D>) {
        let past_detections_length = self.config.past_detections_length;
        let config = &self.config;
        let obj = &mut self.objects[index];
        obj.add_to_past_detections(&detection.data, past_detections_length);
        obj.last_data = detection.data;
        obj.hit_counter = (obj.hit_counter + 2).min(config.hit_counter_max);
        if obj.is_initializing && obj.hit_counter > config.initialization_delay {
            obj.is_initializing = false;
            obj.global_id = Some(next_global_id());
        }
        obj.filter.update(detection.points, &config.filter);
    }

    /// `_TrackedObjectFactory.create()` with period 1.
    fn create(&mut self, detection: Detection<D>) {
        let hit_counter = 1;
        let is_initializing = hit_counter <= self.config.initialization_delay;
        let global_id = if is_initializing {
            None
        } else {
            Some(next_global_id())
        };
        let past_detections = if self.config.past_detections_length > 0 {
            vec![(0, detection.data.clone())]
        } else {
            Vec::new()
        };
        self.objects.push(TrackedObject {
            global_id,
            label: detection.label,
            hit_counter,
            is_initializing,
            age: 0,
            last_data: detection.data,
            past_detections,
            filter: Filter::new(detection.points, &self.config.filter),
        });
    }
}

/// `Tracker.match_dets_and_objs`: repeatedly take the global minimum.
/// Returns `(detection, object)` pairs in the order they were matched.
fn match_dets_and_objs(matrix: &[f32], cols: usize, threshold: f64) -> Vec<(usize, usize)> {
    let mut m = matrix.to_vec();
    let mut matches = Vec::new();
    if m.is_empty() || cols == 0 {
        return matches;
    }
    let rows = m.len() / cols;
    let filler = (threshold + 1.0) as f32;

    loop {
        // argmin returns the first occurrence of the minimum; the matrix
        // has no NaN (checked by the caller)
        let (flat, current_min) =
            m.iter()
                .enumerate()
                .fold((0usize, f32::INFINITY), |best, (i, &v)| {
                    if v < best.1 {
                        (i, v)
                    } else {
                        best
                    }
                });
        if (current_min as f64) >= threshold {
            break;
        }
        let (det, obj) = (flat / cols, flat % cols);
        matches.push((det, obj));
        for v in &mut m[det * cols..(det + 1) * cols] {
            *v = filler;
        }
        for r in 0..rows {
            m[r * cols + obj] = filler;
        }
    }
    matches
}

/// `np.percentile(values, q)` (linear method) for a short list.
pub fn percentile(values: &[f64], q: f64) -> f64 {
    let mut sorted = values.to_vec();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let n = sorted.len();
    let virtual_index = (n - 1) as f64 * (q / 100.0);
    if virtual_index >= (n - 1) as f64 {
        return sorted[n - 1];
    }
    let previous = virtual_index.floor();
    let gamma = virtual_index - previous;
    let a = sorted[previous as usize];
    let b = sorted[previous as usize + 1];
    let diff = b - a;
    // numpy's _lerp switches formula at 0.5 for accuracy
    if gamma >= 0.5 {
        b - diff * (1.0 - gamma)
    } else {
        a + diff * gamma
    }
}
