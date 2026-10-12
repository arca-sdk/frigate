//! Box geometry used by the per-frame detection loop.
//!
//! Each function mirrors the Python implementation in `frigate/util/object.py`
//! and `frigate/util/image.py` operation for operation, including the order of
//! floating point operations and Python's `int()` truncation, so the results
//! are identical. Box coordinates arrive as `f64` because Python passes a mix
//! of ints and floats; pixel coordinates are exactly representable.

/// A box as `(x_min, y_min, x_max, y_max)`.
pub type Box4 = [f64; 4];

/// Python's `area()` helper, which counts pixels inclusively.
#[inline]
pub fn area(b: &Box4) -> f64 {
    (b[2] - b[0] + 1.0) * (b[3] - b[1] + 1.0)
}

#[inline]
fn box_inside(outer: &Box4, inner: &Box4) -> bool {
    inner[0] >= outer[0] && inner[1] >= outer[1] && inner[2] <= outer[2] && inner[3] <= outer[3]
}

/// Port of `calculate_region` (Python ints are truncated toward zero).
#[allow(clippy::too_many_arguments)]
pub fn calculate_region(
    frame_h: i64,
    frame_w: i64,
    xmin: f64,
    ymin: f64,
    xmax: f64,
    ymax: f64,
    model_size: i64,
    multiplier: f64,
) -> [i64; 4] {
    // size is the longest edge and divisible by 4
    let mut size = ((xmax - xmin).max(ymax - ymin) * multiplier / 4.0).floor() * 4.0;
    size = size.trunc();
    let mut size = size as i64;
    if size < model_size {
        size = model_size;
    }
    let half = size as f64 / 2.0;

    let mut x_offset = ((xmax - xmin) / 2.0 + xmin - half).trunc() as i64;
    if x_offset < 0 {
        x_offset = 0;
    } else if x_offset > frame_w - size {
        x_offset = (frame_w - size).max(0);
    }

    let mut y_offset = ((ymax - ymin) / 2.0 + ymin - half).trunc() as i64;
    if y_offset < 0 {
        y_offset = 0;
    } else if y_offset > frame_h - size {
        y_offset = (frame_h - size).max(0);
    }

    [x_offset, y_offset, x_offset + size, y_offset + size]
}

/// Port of `get_cluster_boundary`: the area a box may pull other boxes from.
fn cluster_boundary(b: &Box4, min_region: i64) -> Box4 {
    let width = b[2] - b[0];
    let height = b[3] - b[1];
    let max_region_area = (width * height).abs() / 0.1;
    let max_region_size = (min_region as f64).max(max_region_area.sqrt().trunc());

    let centroid_x = width / 2.0 + b[0];
    let centroid_y = height / 2.0 + b[1];

    let max_x_dist = (max_region_size - width / 2.0 * 1.1).trunc();
    let max_y_dist = (max_region_size - height / 2.0 * 1.1).trunc();

    [
        (centroid_x - max_x_dist).trunc(),
        (centroid_y - max_y_dist).trunc(),
        (centroid_x + max_x_dist).trunc(),
        (centroid_y + max_y_dist).trunc(),
    ]
}

/// Port of `get_cluster_region` for the boxes at `indices`.
pub fn cluster_region(
    frame_h: i64,
    frame_w: i64,
    min_region: i64,
    indices: &[usize],
    boxes: &[Box4],
) -> [i64; 4] {
    let mut min_x = frame_w as f64;
    let mut min_y = frame_h as f64;
    let mut max_x = 0.0_f64;
    let mut max_y = 0.0_f64;
    for &i in indices {
        let b = &boxes[i];
        min_x = b[0].min(min_x);
        min_y = b[1].min(min_y);
        max_x = b[2].max(max_x);
        max_y = b[3].max(max_y);
    }
    calculate_region(
        frame_h, frame_w, min_x, min_y, max_x, max_y, min_region, 1.35,
    )
}

/// Port of the clustering loop in `get_cluster_candidates`.
///
/// Returns every cluster in creation order with sorted indices. Python then
/// de-duplicates them through a set, which the wrapper keeps doing so the
/// final iteration order is unchanged.
pub fn cluster_candidates(
    frame_h: i64,
    frame_w: i64,
    min_region: i64,
    boxes: &[Box4],
) -> Vec<Vec<usize>> {
    let mut candidates = Vec::new();
    let mut used = vec![false; boxes.len()];

    for current in 0..boxes.len() {
        if used[current] {
            continue;
        }
        let mut cluster = vec![current];
        used[current] = true;
        let boundary = cluster_boundary(&boxes[current], min_region);

        for compare in 0..boxes.len() {
            if used[compare] || !box_inside(&boundary, &boxes[compare]) {
                continue;
            }

            // get the region if this box were added to the cluster
            cluster.push(compare);
            let region = cluster_region(frame_h, frame_w, min_region, &cluster, boxes);
            let region_f = [
                region[0] as f64,
                region[1] as f64,
                region[2] as f64,
                region[3] as f64,
            ];

            // if the region could be smaller and any box would be too small
            // for the resulting region, don't cluster
            let mut should_cluster = true;
            if region[2] - region[0] > min_region {
                let region_area = area(&region_f);
                should_cluster = cluster
                    .iter()
                    .all(|&i| area(&boxes[i]) / region_area >= 0.05);
            }

            if should_cluster {
                used[compare] = true;
            } else {
                cluster.pop();
            }
        }

        cluster.sort_unstable();
        candidates.push(cluster);
    }

    candidates
}

/// One entry of the `reduce_detections` input.
pub struct Detection {
    pub label: usize,
    pub score: f64,
    pub bbox: Box4,
    pub area_key: f64,
    pub region: Box4,
}

/// Port of `clipped`: object within 5px of a region border that is not a
/// frame edge.
fn clipped(d: &Detection, frame_h: f64, frame_w: f64) -> bool {
    let b = &d.bbox;
    let r = &d.region;
    (r[0] > 5.0 && b[0] - r[0] <= 5.0)
        || (r[1] > 5.0 && b[1] - r[1] <= 5.0)
        || (frame_w - r[2] > 5.0 && r[2] - b[2] <= 5.0)
        || (frame_h - r[3] > 5.0 && r[3] - b[3] <= 5.0)
}

/// `cv::Rect2d` as used by `cv2.dnn.NMSBoxes`.
#[derive(Clone, Copy)]
struct Rect2d {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

impl Rect2d {
    fn area(&self) -> f64 {
        self.w * self.h
    }

    fn empty(&self) -> bool {
        self.w <= 0.0 || self.h <= 0.0
    }

    /// `cv::Rect_<double>::operator&`.
    fn intersect(&self, b: &Rect2d) -> Rect2d {
        let none = Rect2d {
            x: 0.0,
            y: 0.0,
            w: 0.0,
            h: 0.0,
        };
        if self.empty() || b.empty() {
            return none;
        }
        let (rx_min, rx_max) = if self.x < b.x { (self, b) } else { (b, self) };
        let (ry_min, ry_max) = if self.y < b.y { (self, b) } else { (b, self) };
        if (rx_min.x < 0.0 && rx_min.x + rx_min.w < rx_max.x)
            || rx_max.x - rx_min.x >= rx_min.w
            || (ry_min.y < 0.0 && ry_min.y + ry_min.h < ry_max.y)
            || ry_max.y - ry_min.y >= ry_min.h
        {
            return none;
        }
        Rect2d {
            x: rx_max.x,
            y: ry_max.y,
            w: (rx_min.w - (rx_max.x - rx_min.x)).min(rx_max.w),
            h: (ry_min.h - (ry_max.y - ry_min.y)).min(ry_max.h),
        }
    }
}

/// `rectOverlap` from OpenCV's dnn module (1 - jaccard distance, in float).
fn rect_overlap(a: &Rect2d, b: &Rect2d) -> f32 {
    let aa = a.area();
    let ab = b.area();
    let distance = if aa + ab <= f64::EPSILON {
        0.0
    } else {
        let aab = a.intersect(b).area();
        1.0 - aab / (aa + ab - aab)
    };
    1.0_f32 - distance as f32
}

/// `cv2.dnn.NMSBoxes` (eta = 1, no top_k): indices kept, highest score first.
fn nms_boxes(
    boxes: &[Rect2d],
    scores: &[f32],
    score_threshold: f32,
    nms_threshold: f32,
) -> Vec<usize> {
    let mut order: Vec<(f32, usize)> = scores
        .iter()
        .enumerate()
        .filter(|(_, &s)| s > score_threshold)
        .map(|(i, &s)| (s, i))
        .collect();
    // std::stable_sort with a descending comparator; equal scores keep order
    order.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));

    let mut kept: Vec<usize> = Vec::new();
    for &(_, idx) in &order {
        let keep = kept
            .iter()
            .all(|&k| rect_overlap(&boxes[idx], &boxes[k]) <= nms_threshold);
        if keep {
            kept.push(idx);
        }
    }
    kept
}

/// Group positions by label, keeping first-appearance order (like a dict).
fn group_by_label(labels: impl Iterator<Item = usize>, label_count: usize) -> Vec<Vec<usize>> {
    let mut group_of_label: Vec<Option<usize>> = vec![None; label_count];
    let mut groups: Vec<Vec<usize>> = Vec::new();
    for (pos, label) in labels.enumerate() {
        match group_of_label[label] {
            Some(g) => groups[g].push(pos),
            None => {
                group_of_label[label] = Some(groups.len());
                groups.push(vec![pos]);
            }
        }
    }
    groups
}

/// Port of `reduce_detections`: per-label NMS followed by consolidation of
/// detections mostly contained in larger ones.
///
/// Returns indices into `detections` in output order, or `None` when Python
/// would raise (a zero-area box), so the caller can fall back and keep the
/// original error behavior.
pub fn reduce_detections(
    frame_h: f64,
    frame_w: f64,
    detections: &[Detection],
    label_count: usize,
    nms_thresholds: &[f64],
    consolidation_thresholds: &[f64],
) -> Option<Vec<usize>> {
    // non-maxima suppression per label
    let mut selected: Vec<usize> = Vec::with_capacity(detections.len());
    for group in group_by_label(detections.iter().map(|d| d.label), label_count) {
        let label = detections[group[0]].label;
        let boxes: Vec<Rect2d> = group
            .iter()
            .map(|&i| {
                let b = &detections[i].bbox;
                Rect2d {
                    x: b[0],
                    y: b[1],
                    w: b[2] - b[0],
                    h: b[3] - b[1],
                }
            })
            .collect();
        // objects on the edge of a region get a reduced confidence that is
        // still above the score threshold
        let scores: Vec<f32> = group
            .iter()
            .map(|&i| {
                let d = &detections[i];
                if clipped(d, frame_h, frame_w) {
                    0.6_f32
                } else {
                    d.score as f32
                }
            })
            .collect();
        for k in nms_boxes(&boxes, &scores, 0.5, nms_thresholds[label] as f32) {
            selected.push(group[k]);
        }
    }

    // drop detections that are mostly inside another detection of the same label
    let mut consolidated: Vec<usize> = Vec::with_capacity(selected.len());
    for group in group_by_label(selected.iter().map(|&i| detections[i].label), label_count) {
        let members: Vec<usize> = group.iter().map(|&p| selected[p]).collect();
        if members.len() == 1 {
            consolidated.push(members[0]);
            continue;
        }

        let mut by_area = members;
        by_area.sort_by(|&a, &b| {
            detections[a]
                .area_key
                .partial_cmp(&detections[b].area_key)
                .unwrap_or(std::cmp::Ordering::Equal)
        });

        for (pos, &current) in by_area.iter().enumerate() {
            let current_det = &detections[current];
            let current_box = &current_det.bbox;
            let current_area = area(current_box);
            let threshold = consolidation_thresholds[current_det.label];
            let mut overlap = false;

            for &other in &by_area[pos + 1..] {
                let to_check = &detections[other].bbox;
                let other_area = area(to_check);
                if other_area == 0.0 {
                    return None;
                }
                // a much smaller detection is not compared (car parked in a
                // driveway vs cars on the street behind it)
                if current_area / other_area < 0.05 {
                    continue;
                }
                if current_box[2] < to_check[0]
                    || current_box[0] > to_check[2]
                    || current_box[1] > to_check[3]
                    || current_box[3] < to_check[1]
                {
                    continue;
                }
                let intersect = [
                    current_box[0].max(to_check[0]),
                    current_box[1].max(to_check[1]),
                    current_box[2].min(to_check[2]),
                    current_box[3].min(to_check[3]),
                ];
                if current_area == 0.0 {
                    return None;
                }
                if area(&intersect) / current_area > threshold {
                    overlap = true;
                    break;
                }
            }

            if !overlap {
                consolidated.push(current);
            }
        }
    }

    Some(consolidated)
}
