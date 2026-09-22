// SPDX-License-Identifier: AGPL-3.0-or-later
//! Republishing qblock files from a seeded store, as an API-only deployment does.
#![expect(
    clippy::panic_in_result_fn,
    reason = "test assertions report export regressions while propagating store and IO errors"
)]

use dashboard_model::{BlockHash, BlockRecord, QBlockParticipationRecord};
use dashboard_store::{BlockCommit, BlockRecords, GenerationGuard, Indexable, Store, StoreConfig};
use quip_dashboard::indexer::file_writer::FileWriter;

type TestResult = Result<(), Box<dyn std::error::Error>>;

const QBLOCK_ID: &str = "7";
const MINER: &str = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
/// One hour old: past `RESTORE_MIN_AGE_SECS` (300), so the settle filter keeps
/// the winner, and well inside the 14-day window `rebuild_manifests` lists in
/// `metadata.json`. Both bounds are relative to the wall clock, so a fixed
/// timestamp cannot satisfy them both — it would age out of the manifest
/// window and the second test would stop asserting anything.
const AGE_SECS: u64 = 3600;

/// Seed a store holding one settled winner with one participant.
///
/// Mirrors the commit path `http_contract.rs` uses: coverage is initialized
/// per domain, then the winner and its participation land in one `commit_block`.
async fn seeded_store(directory: &std::path::Path) -> Result<Store, Box<dyn std::error::Error>> {
    let store = Store::open(StoreConfig::Turso {
        path: directory.join("export.db"),
    })
    .await?;
    let genesis = format!("0x{}", "00".repeat(32)).parse::<BlockHash>()?;
    store.bind_network(&genesis, &[]).await?;
    let domains = [Indexable::Winners, Indexable::Participation];
    for domain in domains {
        let _ = store.initialize_coverage(domain, 1, "1".parse()?).await?;
    }
    let timestamp = u64::try_from(chrono::Utc::now().timestamp())?.saturating_sub(AGE_SECS);
    let winner = BlockRecord {
        block_hash: format!("0x{}", "11".repeat(32)).parse()?,
        substrate_block_number: "42".parse()?,
        substrate_block_hash: format!("0x{}", "22".repeat(32)).parse()?,
        substrate_parent_hash: format!("0x{}", "33".repeat(32)).parse()?,
        timestamp,
        miner_id: MINER.to_owned(),
        energy: 1.5,
        diversity: 0.25,
        num_valid_solutions: 3,
        mining_time: 12.0,
        device_access_time_us: None,
        reward: "1000".parse()?,
        qblock_id: QBLOCK_ID.parse()?,
        nonce: "9".parse()?,
        num_nodes: 4,
        num_edges: 6,
        difficulty_energy: 1.0,
        min_diversity: 0.1,
        min_solutions: 1,
        finalized: true,
        topology_hash: None,
    };
    let _ = store
        .commit_block(&BlockCommit {
            genesis,
            hash: winner.substrate_block_hash.clone(),
            height: winner.substrate_block_number.clone(),
            guards: domains
                .into_iter()
                .map(|indexable| GenerationGuard {
                    indexable,
                    expected: 1,
                })
                .collect(),
            records: BlockRecords {
                winner: Some(winner),
                participation: vec![QBlockParticipationRecord {
                    qblock_id: QBLOCK_ID.parse()?,
                    account: MINER.to_owned(),
                    kind: "Quantum".to_owned(),
                    budget_seconds: Some(30.0),
                    block_number: "42".parse()?,
                }],
                ..BlockRecords::default()
            },
            completed: domains.to_vec(),
        })
        .await?;
    Ok(store)
}

#[tokio::test]
async fn export_writes_a_qblock_file_for_a_settled_winner() -> TestResult {
    let dir = tempfile::tempdir()?;
    let store = seeded_store(dir.path()).await?;
    let files = tempfile::tempdir()?;
    let writer = FileWriter::new(files.path().to_path_buf());

    assert!(
        !writer.has_qblock(QBLOCK_ID).await?,
        "the file must be absent before the export, or this test asserts nothing"
    );

    let complete = quip_dashboard::qblock_export::restore_qblock_files(&store, &writer, 0).await;

    assert!(complete, "a reachable store should report a complete pass");
    assert!(
        writer.has_qblock(QBLOCK_ID).await?,
        "the winner's qblock file should exist after an export pass"
    );
    Ok(())
}

#[tokio::test]
async fn export_lists_the_restored_file_in_the_recent_manifest() -> TestResult {
    let dir = tempfile::tempdir()?;
    let store = seeded_store(dir.path()).await?;
    let files = tempfile::tempdir()?;
    let writer = FileWriter::new(files.path().to_path_buf());

    let complete = quip_dashboard::qblock_export::restore_qblock_files(&store, &writer, 0).await;
    assert!(complete, "a reachable store should report a complete pass");
    // restore_qblock sets the file mtime to the winner's timestamp, so the
    // rebuild files it under its chain day. A winner older than this cutoff
    // would land in a per-day history manifest instead.
    writer
        .rebuild_manifests(
            chrono::Utc::now().timestamp() - quip_dashboard::qblock_export::RECENT_DAYS * 86_400,
        )
        .await?;

    let manifest: serde_json::Value = serde_json::from_slice(
        &tokio::fs::read(files.path().join("qblocks/metadata.json")).await?,
    )?;
    let recent = manifest
        .get("qblocks")
        .and_then(serde_json::Value::as_array)
        .ok_or("metadata.json has no qblocks array")?;
    assert_eq!(recent.len(), 1, "the restored file should be listed once");
    Ok(())
}
