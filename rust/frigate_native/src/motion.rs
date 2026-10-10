//! Pixel pipeline of `ImprovedMotionDetector.detect()`.
//!
//! Covers everything from downscaling the luma plane to the dilated threshold
//! image. Contour extraction stays in OpenCV because the order of the motion
//! boxes it returns feeds the region clustering. Each step reproduces the
//! exact arithmetic of the numpy, scipy and OpenCV call it replaces.

pub struct MotionParams<'a> {
    /// Luma plane of the frame, `frame_h` rows of `stride` bytes.
    pub luma: &'a [u8],
    pub stride: usize,
    pub frame_h: usize,
    pub frame_w: usize,
    pub out_h: usize,
    pub out_w: usize,
    pub improve_contrast: bool,
    /// Rolling `[min, max]` history, updated in place.
    pub contrast_values: &'a mut [[u8; 2]],
    pub contrast_index: usize,
    /// Resized motion mask, 0 where motion is masked. Empty when unmasked.
    pub mask: &'a [u8],
    /// Gaussian kernel exactly as scipy builds it (odd length, symmetric).
    pub blur_weights: &'a [f64],
    pub avg_frame: &'a [f32],
    pub threshold: f64,
}

pub struct MotionOutput {
    /// Blurred frame that gets accumulated into the running average.
    pub frame: Vec<u8>,
    /// Dilated binary threshold image used for contour detection.
    pub thresh_dilated: Vec<u8>,
    pub contrast_index: usize,
}

/// `cv2.resize(..., interpolation=cv2.INTER_NEAREST)` for one channel.
#[inline(always)]
fn resize_nearest(p: &MotionParams) -> Vec<u8> {
    let (sw, sh, dw, dh) = (p.frame_w, p.frame_h, p.out_w, p.out_h);
    let mut out = vec![0u8; dw * dh];
    if sw == dw && sh == dh {
        for y in 0..dh {
            out[y * dw..(y + 1) * dw].copy_from_slice(&p.luma[y * p.stride..y * p.stride + sw]);
        }
        return out;
    }

    // same double arithmetic as OpenCV's resizeNN
    let ifx = 1.0 / (dw as f64 / sw as f64);
    let ify = 1.0 / (dh as f64 / sh as f64);
    let x_ofs: Vec<usize> = (0..dw)
        .map(|x| ((x as f64 * ifx).floor() as usize).min(sw - 1))
        .collect();
    for y in 0..dh {
        let sy = ((y as f64 * ify).floor() as usize).min(sh - 1);
        let src = &p.luma[sy * p.stride..sy * p.stride + sw];
        let dst = &mut out[y * dw..(y + 1) * dw];
        for (d, &sx) in dst.iter_mut().zip(&x_ofs) {
            *d = src[sx];
        }
    }
    out
}

/// C-style `(uint8)` truncation of a value known to be in `[0, 256)`.
///
/// Rust's `as u8` saturates and handles NaN, which blocks vectorization; the
/// callers guarantee the range, so the unchecked conversion is exact.
#[inline(always)]
fn trunc_u8(v: f64) -> u8 {
    debug_assert!((0.0..256.0).contains(&v));
    // SAFETY: v is finite and within i32 range
    unsafe { v.to_int_unchecked::<i32>() as u8 }
}

/// `np.percentile(frame, q)` with the default linear method, cast to uint8.
fn percentile_u8(hist: &[usize; 256], n: usize, q: f64) -> u8 {
    let kth = |k: usize| -> u8 {
        let mut seen = 0;
        for (value, &count) in hist.iter().enumerate() {
            seen += count;
            if seen > k {
                return value as u8;
            }
        }
        255
    };

    let virtual_index = (n - 1) as f64 * (q / 100.0);
    if virtual_index >= (n - 1) as f64 {
        return kth(n - 1);
    }
    let previous = virtual_index.floor();
    let gamma = virtual_index - previous;
    let a = kth(previous as usize);
    let b = kth(previous as usize + 1);
    let diff = (b - a) as f64;
    // numpy's _lerp, which switches formula at 0.5 for accuracy
    let value = if gamma >= 0.5 {
        b as f64 - diff * (1.0 - gamma)
    } else {
        a as f64 + diff * gamma
    };
    value as u8
}

/// Contrast stretch based on a rolling average of the 4th/96th percentiles.
#[inline(always)]
fn improve_contrast(frame: &mut [u8], p: &mut MotionParams) -> usize {
    let mut hist = [0usize; 256];
    for &v in frame.iter() {
        hist[v as usize] += 1;
    }
    let min_value = percentile_u8(&hist, frame.len(), 4.0);
    let max_value = percentile_u8(&hist, frame.len(), 96.0);

    // skip contrast calcs if the image is a single color
    if min_value >= max_value {
        return p.contrast_index;
    }

    let history = p.contrast_values.len();
    p.contrast_values[p.contrast_index] = [min_value, max_value];
    let mut index = p.contrast_index + 1;
    if index == history {
        index = 0;
    }

    let (sum_min, sum_max) = p
        .contrast_values
        .iter()
        .fold((0u64, 0u64), |(a, b), v| (a + v[0] as u64, b + v[1] as u64));
    let avg_min = sum_min as f64 / history as f64;
    let avg_max = sum_max as f64 / history as f64;
    let range = avg_max - avg_min;

    for v in frame.iter_mut() {
        let clipped = (*v as f64).max(avg_min).min(avg_max);
        *v = trunc_u8((clipped - avg_min) / range * 255.0);
    }
    index
}

/// scipy's 'reflect' boundary: the edge sample is repeated.
#[inline]
fn reflect(index: isize, len: isize) -> usize {
    let period = 2 * len;
    let mut i = index.rem_euclid(period);
    if i >= len {
        i = period - 1 - i;
    }
    i as usize
}

/// `scipy.ndimage.gaussian_filter` on a uint8 image: axis 0, then axis 1,
/// each pass truncated back into uint8 like scipy does for integer arrays.
///
/// Each output is accumulated exactly as scipy's symmetric `correlate1d`:
/// `center * w[r]`, then `(before + after) * w[r - k]` for k = r down to 1.
#[inline(always)]
fn gaussian_blur(frame: &[u8], w: usize, h: usize, weights: &[f64]) -> Vec<u8> {
    let radius = weights.len() / 2;
    let center = weights[radius];

    // axis 0, processed a row at a time so the inner loops vectorize
    let src: Vec<f64> = frame.iter().map(|&v| v as f64).collect();
    let mut vertical = vec![0u8; w * h];
    let mut acc = vec![0f64; w];
    for y in 0..h {
        let row = &src[y * w..(y + 1) * w];
        for (a, &v) in acc.iter_mut().zip(row) {
            *a = v * center;
        }
        for k in (1..=radius).rev() {
            let above = reflect(y as isize - k as isize, h as isize) * w;
            let below = reflect(y as isize + k as isize, h as isize) * w;
            let (above, below) = (&src[above..above + w], &src[below..below + w]);
            let wk = weights[radius - k];
            for ((a, &b), &c) in acc.iter_mut().zip(above).zip(below) {
                *a += (b + c) * wk;
            }
        }
        for (o, &a) in vertical[y * w..(y + 1) * w].iter_mut().zip(&acc) {
            *o = trunc_u8(a);
        }
    }

    // axis 1 on a reflect-padded copy of each row
    let mut out = vec![0u8; w * h];
    let mut padded = vec![0f64; w + 2 * radius];
    for y in 0..h {
        let row = &vertical[y * w..(y + 1) * w];
        for (p, &v) in padded[radius..radius + w].iter_mut().zip(row) {
            *p = v as f64;
        }
        for k in 1..=radius {
            padded[radius - k] = row[reflect(-(k as isize), w as isize)] as f64;
            padded[radius + w - 1 + k] = row[reflect((w - 1 + k) as isize, w as isize)] as f64;
        }
        let out_row = &mut out[y * w..(y + 1) * w];
        if radius == 1 {
            // the radius Frigate uses, unrolled so the loop vectorizes
            let w0 = weights[0];
            let taps = padded[..w]
                .iter()
                .zip(&padded[1..w + 1])
                .zip(&padded[2..w + 2]);
            for (o, ((&before, &c), &after)) in out_row.iter_mut().zip(taps) {
                *o = trunc_u8(c * center + (before + after) * w0);
            }
        } else {
            for (x, o) in out_row.iter_mut().enumerate() {
                let c = x + radius;
                let mut a = padded[c] * center;
                for k in (1..=radius).rev() {
                    a += (padded[c - k] + padded[c + k]) * weights[radius - k];
                }
                *o = trunc_u8(a);
            }
        }
    }
    out
}

/// `cv2.threshold(THRESH_BINARY)` for uint8 with maxval 255.
#[inline(always)]
fn threshold_binary(delta: &mut [u8], threshold: f64) {
    let ithresh = threshold.floor();
    if ithresh < 0.0 {
        delta.fill(255);
    } else if ithresh >= 255.0 {
        delta.fill(0);
    } else {
        let t = ithresh as u8;
        for v in delta.iter_mut() {
            *v = if *v > t { 255 } else { 0 };
        }
    }
}

/// `cv2.dilate(src, None, iterations=1)`: 3x3 max, outside pixels ignored
/// (OpenCV's default border value for dilation is the type minimum).
#[inline(always)]
fn dilate3x3(src: &[u8], w: usize, h: usize) -> Vec<u8> {
    // horizontal max of each pixel and its neighbors
    let mut rows = vec![0u8; w * h];
    for (line, out) in src.chunks_exact(w).zip(rows.chunks_exact_mut(w)) {
        out.copy_from_slice(line);
        if w > 1 {
            for (o, &n) in out[..w - 1].iter_mut().zip(&line[1..]) {
                *o = (*o).max(n);
            }
            for (o, &n) in out[1..].iter_mut().zip(&line[..w - 1]) {
                *o = (*o).max(n);
            }
        }
    }

    // vertical max of the row maxima
    let mut out = rows.clone();
    for y in 0..h {
        let dst = &mut out[y * w..(y + 1) * w];
        if y > 0 {
            for (d, &a) in dst.iter_mut().zip(&rows[(y - 1) * w..y * w]) {
                *d = (*d).max(a);
            }
        }
        if y + 1 < h {
            for (d, &b) in dst.iter_mut().zip(&rows[(y + 1) * w..(y + 2) * w]) {
                *d = (*d).max(b);
            }
        }
    }
    out
}

/// `saturate_cast<uchar>(std::abs(v))` as in `cv2.convertScaleAbs`: round
/// half to even. Adding and subtracting 2^23 rounds exactly that way for
/// 0 <= v < 2^23 without a libm call; the clamp saturates like OpenCV.
#[inline(always)]
fn round_abs_u8(v: f32) -> u8 {
    const MAGIC: f32 = 8_388_608.0;
    let v = v.abs().min(MAGIC - 1.0);
    let rounded = ((v + MAGIC) - MAGIC).min(255.0);
    // SAFETY: rounded is finite and within [0, 255]
    unsafe { rounded.to_int_unchecked::<i32>() as u8 }
}

pub fn motion_pipeline(p: MotionParams) -> MotionOutput {
    #[cfg(target_arch = "x86_64")]
    if std::arch::is_x86_feature_detected!("avx2") {
        // SAFETY: the CPU supports AVX2
        return unsafe { motion_pipeline_avx2(p) };
    }
    motion_pipeline_impl(p)
}

/// The same code compiled for AVX2. AVX2 does not enable FMA, so floating
/// point results are identical to the baseline build.
#[cfg(target_arch = "x86_64")]
#[target_feature(enable = "avx2")]
unsafe fn motion_pipeline_avx2(p: MotionParams) -> MotionOutput {
    motion_pipeline_impl(p)
}

#[inline(always)]
fn motion_pipeline_impl(mut p: MotionParams) -> MotionOutput {
    let (w, h) = (p.out_w, p.out_h);
    let mut frame = resize_nearest(&p);

    let mut contrast_index = p.contrast_index;
    if p.improve_contrast {
        contrast_index = improve_contrast(&mut frame, &mut p);
    }

    // masked pixels are zeroed to match the average frame at startup
    if !p.mask.is_empty() {
        for (v, &m) in frame.iter_mut().zip(p.mask) {
            if m == 0 {
                *v = 0;
            }
        }
    }

    let frame = gaussian_blur(&frame, w, h, p.blur_weights);

    // absdiff against cv2.convertScaleAbs(avg_frame), which rounds half to even
    let mut delta: Vec<u8> = frame
        .iter()
        .zip(p.avg_frame)
        .map(|(&v, &avg)| v.abs_diff(round_abs_u8(avg * 1.0_f32 + 0.0_f32)))
        .collect();

    threshold_binary(&mut delta, p.threshold);
    let thresh_dilated = dilate3x3(&delta, w, h);

    MotionOutput {
        frame,
        thresh_dilated,
        contrast_index,
    }
}
