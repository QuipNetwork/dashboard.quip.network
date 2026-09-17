// SPDX-License-Identifier: AGPL-3.0-or-later
//! Interval planning from committed coverage; pruning never becomes coverage.
use dashboard_store::Coverage;

/// Inclusive height interval used for durable gaps.
pub type Interval = [u64; 2];

/// Return sorted uncovered intervals, respecting a separately recorded pruning floor.
#[must_use]
pub fn uncovered(coverage: &Coverage, head: u64) -> Vec<Interval> {
    let start = match coverage.pruned_floor {
        Some(u64::MAX) => return Vec::new(),
        Some(floor) => coverage.start.max(floor + 1),
        None => coverage.start,
    };
    if start > head {
        return Vec::new();
    }
    let (Some(low), Some(high)) = (coverage.low, coverage.high) else {
        return vec![[start, head]];
    };
    let mut ranges = Vec::new();
    if start < low {
        ranges.push([start, head.min(low - 1)]);
    }
    for [a, b] in &coverage.gaps {
        let a = (*a).max(start);
        let b = (*b).min(head);
        if a <= b {
            ranges.push([a, b]);
        }
    }
    if let Some(tail) = high.checked_add(1) {
        let tail = tail.max(start);
        if tail <= head {
            ranges.push([tail, head]);
        }
    }
    ranges
}

/// Subtract known failed winner heights before publishing an otherwise proven range.
#[must_use]
pub fn subtract_points(range: Interval, points: &[u64]) -> Vec<Interval> {
    let [from, through] = range;
    if from > through {
        return Vec::new();
    }
    let mut points = points.to_vec();
    points.sort_unstable();
    points.dedup();
    let mut cursor = Some(from);
    let mut result = Vec::new();
    for point in points {
        let Some(start) = cursor else {
            break;
        };
        if point < start || point > through {
            continue;
        }
        if start < point {
            result.push([start, point - 1]);
        }
        cursor = point.checked_add(1);
    }
    if let Some(start) = cursor
        && start <= through
    {
        result.push([start, through]);
    }
    result
}
