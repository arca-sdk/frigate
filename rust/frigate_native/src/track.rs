//! Distance function used by the norfair object tracker.

/// Port of `distance()` in `frigate/track/norfair_tracker.py`.
///
/// Both arguments are 2x2 point arrays `[[x_min, y_min], [x_max, y_max]]`.
/// Compares the bottom-center position relative to the estimate's size and
/// the change in width and height. Degenerate boxes are infinitely far away.
pub fn box_distance(detection: [[f64; 2]; 2], estimate: [[f64; 2]; 2]) -> f64 {
    let estimate_dim = [
        estimate[1][0] - estimate[0][0],
        estimate[1][1] - estimate[0][1],
    ];
    let detection_dim = [
        detection[1][0] - detection[0][0],
        detection[1][1] - detection[0][1],
    ];

    if !estimate_dim.iter().all(|v| v.is_finite())
        || !detection_dim.iter().all(|v| v.is_finite())
        || estimate_dim[0] <= 0.0
        || estimate_dim[1] <= 0.0
        || detection_dim[0] <= 0.0
        || detection_dim[1] <= 0.0
    {
        return f64::INFINITY;
    }

    // bottom center positions
    let detection_position = [
        (detection[0][0] + detection[1][0]) / 2.0,
        detection[0][1].max(detection[1][1]),
    ];
    let estimate_position = [
        (estimate[0][0] + estimate[1][0]) / 2.0,
        estimate[0][1].max(estimate[1][1]),
    ];

    // change in x relative to w and in y relative to h
    let dx = (detection_position[0] - estimate_position[0]) / estimate_dim[0];
    let dy = (detection_position[1] - estimate_position[1]) / estimate_dim[1];

    // ratio of widths and heights, normalized to 0
    let width_ratio = ratio_minus_one(estimate_dim[0], detection_dim[0]);
    let height_ratio = ratio_minus_one(estimate_dim[1], detection_dim[1]);

    (dx * dx + dy * dy + width_ratio * width_ratio + height_ratio * height_ratio).sqrt()
}

#[inline]
fn ratio_minus_one(a: f64, b: f64) -> f64 {
    let (low, high) = if a <= b { (a, b) } else { (b, a) };
    high / low - 1.0
}
