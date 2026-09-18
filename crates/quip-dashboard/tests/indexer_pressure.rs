// SPDX-License-Identifier: AGPL-3.0-or-later
//! Admission capacity remains owned until commit, including retry waits.
use quip_dashboard::indexer::admission::Admission;

#[test]
#[expect(
    clippy::panic_in_result_fn,
    reason = "test assertions report permit accounting regressions"
)]
fn reserves_live_capacity_until_work_completes() -> Result<(), Box<dyn std::error::Error>> {
    let admission = Admission::new(4, 1)?;
    let held = vec![
        admission.try_backfill()?,
        admission.try_backfill()?,
        admission.try_backfill()?,
    ];
    assert!(admission.try_backfill().is_err());
    let live = admission.try_live()?;
    assert!(admission.try_live().is_err());
    drop(held);
    let resumed = admission.try_backfill()?;
    drop((live, resumed));
    assert_eq!(admission.active(), 0);
    Ok(())
}

#[test]
#[expect(
    clippy::panic_in_result_fn,
    reason = "test assertions report permit accounting regressions"
)]
fn hundred_thousand_announcements_cannot_escape_blocked_commit_capacity()
-> Result<(), Box<dyn std::error::Error>> {
    let admission = Admission::default();
    let mut held = Vec::new();
    for _ in 0..100_000 {
        if let Ok(permit) = admission.try_backfill() {
            held.push(permit);
        }
        assert!(admission.active() <= 64);
        assert!(admission.backfill_active() <= 56);
    }
    assert_eq!(held.len(), 56);
    let mut live = Vec::new();
    for _ in 0..8 {
        live.push(admission.try_live()?);
    }
    assert_eq!(admission.active(), 64);
    assert!(admission.try_live().is_err());
    // A retry retains its permit; no new admission becomes possible until commit releases it.
    for _ in 0..1000 {
        assert!(admission.try_backfill().is_err());
    }
    drop(held);
    assert_eq!(admission.active(), 8);
    drop(live);
    assert_eq!(admission.active(), 0);
    Ok(())
}
