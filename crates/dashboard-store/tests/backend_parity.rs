// SPDX-License-Identifier: AGPL-3.0-or-later
//! Real-engine domain and transaction parity scenarios.
use dashboard_model::{
    BlockHash, BlockRecord, DecimalString, DifficultyRecord, DifficultySource,
    QBlockParticipationRecord,
};
use dashboard_store::{
    BlockCommit, BlockRecords, CommitResult, GenerationGuard, Indexable, RangeCompletion, Scan,
    ScanId, Store, StoreConfig,
};
use std::error::Error;
fn hash(n: u64) -> Result<BlockHash, Box<dyn Error>> {
    Ok(format!("0x{n:064x}").parse()?)
}
fn block(n: u64) -> Result<BlockRecord, Box<dyn Error>> {
    Ok(serde_json::from_value(
        serde_json::json!({"blockHash":hash(n+1000)?,"substrateBlockNumber":n.to_string(),"substrateBlockHash":hash(n)?,"substrateParentHash":hash(n-1)?,"timestamp":1_700_000_000+n*6,"minerId":"alice","energy":-7.5,"diversity":0.5,"numValidSolutions":2,"miningTime":0.06,"deviceAccessTimeUs":null,"reward":"115792089237316195423570985008687907853269984665640564039457584007913129639935","qblockId":n.to_string(),"nonce":"18446744073709551615","numNodes":8,"numEdges":16,"difficultyEnergy":-7.0,"minDiversity":0.1,"minSolutions":1,"finalized":true,"topologyHash":null}),
    )?)
}
fn batch(n: u64, r#gen: u64) -> Result<BlockCommit, Box<dyn Error>> {
    Ok(BlockCommit {
        genesis: hash(0)?,
        hash: hash(n)?,
        height: DecimalString::from(n),
        guards: vec![GenerationGuard {
            indexable: Indexable::Winners,
            expected: r#gen,
        }],
        records: BlockRecords {
            winner: Some(block(n)?),
            ..BlockRecords::default()
        },
        completed: vec![Indexable::Winners],
    })
}
#[expect(
    clippy::too_many_lines,
    reason = "Keep the complete transaction scenario visible for auditing"
)]
async fn scenario(store: &Store) -> Result<(), Box<dyn Error>> {
    assert!(store.set_self_address(Some("alice")).await.is_err());
    store.bind_network(&hash(0)?, &[]).await?;
    assert!(store.bind_network(&hash(99)?, &[]).await.is_err());
    assert_eq!(
        store.commit_block(&batch(42, 2)?).await?,
        CommitResult::StaleGeneration
    );
    assert!(store.get_recent_blocks(100, 0).await?.is_empty());
    assert_eq!(
        store.commit_block(&batch(42, 1)?).await?,
        CommitResult::Applied
    );
    assert_eq!(
        store.commit_block(&batch(42, 1)?).await?,
        CommitResult::AlreadyApplied
    );
    assert_eq!(store.get_recent_blocks(100, 0).await?.len(), 1);
    let winner = store.get_recent_blocks(1, 0).await?.remove(0);
    assert_eq!(winner.reward, block(42)?.reward);
    let mut bad = batch(43, 1)?;
    bad.guards.push(GenerationGuard {
        indexable: Indexable::Participation,
        expected: 1,
    });
    bad.completed.push(Indexable::Participation);
    bad.records.participation.push(QBlockParticipationRecord {
        qblock_id: 43.into(),
        account: "alice".into(),
        kind: "Cpu".into(),
        budget_seconds: Some(-1.0),
        block_number: 43.into(),
    });
    assert!(store.commit_block(&bad).await.is_err());
    assert_eq!(store.get_recent_blocks(100, 0).await?.len(), 1);
    assert!(store.coverage(Indexable::Participation).await?.is_none());
    let late = BlockCommit {
        genesis: hash(0)?,
        hash: hash(42)?,
        height: 42.into(),
        guards: vec![GenerationGuard {
            indexable: Indexable::Participation,
            expected: 1,
        }],
        records: BlockRecords {
            participation: vec![QBlockParticipationRecord {
                qblock_id: 42.into(),
                account: "bob".into(),
                kind: "Gpu".into(),
                budget_seconds: None,
                block_number: 40.into(),
            }],
            ..BlockRecords::default()
        },
        completed: vec![Indexable::Participation],
    };
    assert_eq!(store.commit_block(&late).await?, CommitResult::Applied);
    assert_eq!(
        store.commit_block(&late).await?,
        CommitResult::AlreadyApplied
    );
    assert_eq!(store.get_qblock_participation("42").await?.len(), 1);
    let _ = store.commit_block(&batch(40, 1)?).await?;
    let _ = store.commit_block(&batch(41, 1)?).await?;
    let cov = store
        .coverage(Indexable::Winners)
        .await?
        .ok_or("missing coverage")?;
    assert!(cov.contains(40, 42));
    let mut conflict = batch(42, 1)?;
    conflict.hash = hash(999)?;
    assert!(store.commit_block(&conflict).await.is_err());
    let scan = Scan {
        id: ScanId("range-one".into()),
        genesis: hash(0)?,
        at: hash(50)?,
        finalized_height: 50.into(),
        indexable: Indexable::Winners,
        expected_generation: 1,
    };
    let _ = store.begin_scan(&scan).await?;
    let range = RangeCompletion {
        genesis: hash(0)?,
        indexable: Indexable::Winners,
        expected_generation: 1,
        from: 0.into(),
        through: 50.into(),
        scan_id: scan.id.clone(),
    };
    assert!(store.commit_range(&range).await.is_err());
    let _ = store
        .append_scan_page(&scan.id, None, Some(&[1]), &[44.into(), 42.into()])
        .await?;
    assert!(store.commit_range(&range).await.is_err());
    let _ = store
        .append_scan_page(&scan.id, Some(&[1]), None, &[])
        .await?;
    assert!(store.commit_range(&range).await.is_err());
    let _ = store.commit_block(&batch(44, 1)?).await?;
    assert_eq!(store.commit_range(&range).await?, CommitResult::Applied);
    assert!(
        store
            .coverage(Indexable::Winners)
            .await?
            .ok_or("coverage")?
            .contains(0, 50)
    );
    let generations = store.reindex(&[Indexable::Participation]).await?;
    assert_eq!(generations.first().ok_or("generation")?.expected, 2);
    assert!(store.get_qblock_participation("42").await?.is_empty());
    assert_eq!(
        store.commit_block(&late).await?,
        CommitResult::StaleGeneration
    );
    assert_eq!(store.get_recent_blocks(100, 0).await?.len(), 4);
    let poll = DifficultyRecord {
        observed_at_block: 42.into(),
        difficulty_energy: -7.0,
        min_diversity: 0.1,
        min_solutions: 1,
        observed_at: "2023-11-14T22:17:32.000Z".into(),
        topology_hash: None,
        source: DifficultySource::Poll,
    };
    store.insert_difficulty_snapshot(&poll).await?;
    let mut d = poll.clone();
    d.source = DifficultySource::Block;
    d.difficulty_energy = -8.0;
    let commit = BlockCommit {
        genesis: hash(0)?,
        hash: hash(42)?,
        height: 42.into(),
        guards: vec![GenerationGuard {
            indexable: Indexable::Difficulty,
            expected: 1,
        }],
        records: BlockRecords {
            difficulty: Some(d),
            ..BlockRecords::default()
        },
        completed: vec![Indexable::Difficulty],
    };
    let _ = store.commit_block(&commit).await?;
    assert_eq!(
        store
            .get_recent_difficulty(1)
            .await?
            .first()
            .ok_or("difficulty")?
            .source,
        DifficultySource::Block
    );
    let _ = store.reindex(&[Indexable::Difficulty]).await?;
    assert_eq!(
        store
            .get_recent_difficulty(1)
            .await?
            .first()
            .ok_or("difficulty")?
            .source,
        DifficultySource::Poll
    );
    assert!(
        store
            .get_difficulty_anchor_before(&poll.observed_at)
            .await?
            .is_none()
    );
    store.set_descriptor_checkpoint("100").await?;
    store.set_descriptor_checkpoint("99").await?;
    assert_eq!(
        store.get_descriptor_checkpoint().await?.as_deref(),
        Some("100")
    );
    assert!(store.pending_migrations().await?.is_empty());
    descriptors(store).await?;
    snapshots(store).await?;
    submissions(store).await?;
    authorship(store).await?;
    winner_queries(store).await?;
    node_summaries(store).await?;
    poll_after_block(store).await?;
    timestamp_order(store).await?;
    poll_dedup(store).await?;
    observability(store).await?;
    Ok(())
}
#[tokio::test]
async fn turso_domain_and_transaction_parity() -> Result<(), Box<dyn Error>> {
    let dir = tempfile::tempdir()?;
    scenario(
        &Store::open(StoreConfig::Turso {
            path: dir.path().join("test.db"),
        })
        .await?,
    )
    .await
}
#[cfg(feature = "postgres")]
#[tokio::test]
#[ignore = "requires STORE_TEST_POSTGRES_URL pointing to disposable local Postgres"]
async fn postgres_domain_and_transaction_parity() -> Result<(), Box<dyn Error>> {
    use sqlx::Connection as _;
    let base = std::env::var("STORE_TEST_POSTGRES_URL")?;
    let mut admin = sqlx::PgConnection::connect(&base).await?;
    let suffix = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)?
        .as_nanos();
    let name = format!("store_parity_{suffix}");
    let _ = sqlx::raw_sql(sqlx::AssertSqlSafe(format!("CREATE DATABASE {name}")))
        .execute(&mut admin)
        .await?;
    let url = format!(
        "{}/{name}",
        base.rsplit_once('/').ok_or("test database URL")?.0
    );
    scenario(
        &Store::open(StoreConfig::Postgres {
            url,
            max_connections: 2,
        })
        .await?,
    )
    .await
}
#[tokio::test]
#[expect(
    clippy::panic_in_result_fn,
    reason = "Test assertions report regressions while setup propagates errors"
)]
async fn invalid_configuration_is_rejected() -> Result<(), Box<dyn Error>> {
    for url in ["", "bogus"] {
        assert!(
            Store::open(StoreConfig::Postgres {
                url: url.into(),
                max_connections: 2
            })
            .await
            .is_err()
        );
    }
    Ok(())
}

async fn descriptors(store: &Store) -> Result<(), Box<dyn Error>> {
    let mut d: dashboard_model::NodeDescriptorRecord = serde_json::from_value(serde_json::json!({
        "accountId":"descriptor-account","blockNumber":"99","blockHash":hash(99)?,
        "extrinsicIndex":2,"blockTimestamp":1_700_000_000,"firstBlockTimestamp":1_700_000_000,
        "descriptor":{"schema":"quip.node_descriptor.v1","descriptorVersion":1,"nodeName":"before"},
        "observedAt":"2026-01-01T00:00:00.000Z"
    }))?;
    store.upsert_node_descriptor(&d).await?;
    d.block_number = 100.into();
    d.block_timestamp += 500;
    d.descriptor.node_name = "after".into();
    store.upsert_node_descriptor(&d).await?;
    d.extrinsic_index = 1;
    d.descriptor.node_name = "stale".into();
    store.upsert_node_descriptor(&d).await?;
    d.block_number = 99.into();
    d.extrinsic_index = 99;
    store.upsert_node_descriptor(&d).await?;
    let stored = store
        .get_node_descriptor(&d.account_id)
        .await?
        .ok_or("descriptor")?;
    assert_eq!(stored.block_number, 100.into());
    assert_eq!(stored.descriptor.node_name, "after");
    assert_eq!(stored.first_block_timestamp, 1_700_000_000);
    store
        .backfill_node_descriptor_first_seen(&d.account_id, 1_600_000_000)
        .await?;
    store
        .backfill_node_descriptor_first_seen(&d.account_id, 1_800_000_000)
        .await?;
    assert_eq!(
        store
            .get_all_node_descriptors()
            .await?
            .first()
            .ok_or("descriptor")?
            .first_block_timestamp,
        1_600_000_000
    );
    store
        .backfill_node_descriptor_first_seen("missing", 1)
        .await?;
    assert!(store.get_node_descriptor("missing").await?.is_none());
    Ok(())
}

async fn snapshots(store: &Store) -> Result<(), Box<dyn Error>> {
    let head: dashboard_model::ChainHead = serde_json::from_value(serde_json::json!({
        "bestBlockNumber":"200","bestBlockHash":hash(200)?,"finalizedBlockNumber":"190",
        "finalizedBlockHash":hash(190)?,"finalityLag":10,"qblockCount":18_446_744_073_709_551_615_u64,
        "currentQBlockId":"6","currentQBlockParticipants":3,
        "runtime":{"specName":"quip","specVersion":118,"transactionVersion":1,"implName":"quip-node","lastRuntimeUpgrade":"180"},
        "updatedAt":"2026-01-01T00:00:00.000Z"
    }))?;
    store.upsert_chain_head(&head).await?;
    assert_eq!(store.get_chain_head().await?, Some(head));
    let mut epoch = dashboard_model::BabeEpochState {
        epoch_index: 1,
        current_slot: 12.into(),
        epoch_start_slot: 10.into(),
        slots_per_epoch: 10,
        current_slot_in_epoch: 2,
        authority_count: 2,
    };
    store.upsert_babe_epoch(&epoch).await?;
    epoch.epoch_index = 2;
    store.upsert_babe_epoch(&epoch).await?;
    assert_eq!(store.get_current_babe_epoch().await?, Some(epoch));
    let authority = dashboard_model::BabeAuthorityRecord {
        account_id: "alice".into(),
        display_name: Some("Alice".into()),
    };
    store
        .upsert_babe_authorities(2, std::slice::from_ref(&authority))
        .await?;
    assert_eq!(store.get_active_babe_authorities().await?, vec![authority]);
    store.upsert_babe_authorities(2, &[]).await?;
    assert!(store.get_active_babe_authorities().await?.is_empty());
    let mut miners = Vec::new();
    for n in 0..501_u64 {
        miners.push(dashboard_model::ChainMinerRecord {
            account_id: format!("miner-{n}"),
            deposit: 0.into(),
            proofs_submitted: n.into(),
            proofs_won: n.into(),
            rewards_earned: n.into(),
            telemetry_node_address: None,
            hardware: None,
        });
    }
    store.upsert_chain_miners(&miners).await?;
    store.upsert_chain_miners(&[]).await?;
    assert_eq!(
        store
            .get_chain_miners()
            .await?
            .first()
            .ok_or("miners")?
            .rewards_earned,
        500.into()
    );
    let hardware: dashboard_model::MinerHardwareRecord = serde_json::from_value(
        serde_json::json!({"accountId":"alice","nodeId":"node","miners":[{"id":"gpu1","type":"GPU"}],"primaryType":"GPU","source":"self","observedAt":"2026-01-01T00:00:00.000Z"}),
    )?;
    store.upsert_miner_hardware(&hardware).await?;
    assert_eq!(store.get_miner_hardware("alice").await?, Some(hardware));
    store.set_self_address(Some("alice")).await?;
    assert_eq!(store.get_self_address().await?.as_deref(), Some("alice"));
    store.set_self_address(None).await?;
    assert!(store.get_self_address().await?.is_none());
    store
        .set_device_access_time_backfill_marker("triggered")
        .await?;
    assert_eq!(
        store
            .get_device_access_time_backfill_marker()
            .await?
            .as_deref(),
        Some("triggered")
    );
    store
        .put_metadata(&hash(0)?, &hash(190)?, 118, &hash(777)?, &[0, 1, 255])
        .await?;
    assert_eq!(
        store.get_metadata(&hash(0)?, &hash(190)?).await?,
        Some((118, hash(777)?, vec![0, 1, 255]))
    );
    Ok(())
}

async fn submissions(store: &Store) -> Result<(), Box<dyn Error>> {
    let mut s: dashboard_model::MiningSubmissionRecord = serde_json::from_value(
        serde_json::json!({"minerId":"alice","solutionNumber":41,"tsNs":"1700000000000000000","energyMilli":1500,"diversityMilli":2500,"thresholdMilli":1000,"lastProofBlockHash":hash(1)?,"extrinsicHash":null,"chainBlockHash":null,"chainBlockNumber":null,"powSequence":49,"outcome":"submitted","attemptCount":7,"bestEnergyMilli":1400,"numValid":3,"minerType":"CUDA","qpuAccessTimeUs":0,"observedAt":"2026-01-01T00:00:00.000Z"}),
    )?;
    store.insert_mining_submission(&s).await?;
    s.solution_number = u64::MAX;
    s.qpu_access_time_us = u64::MAX;
    store
        .commit_mining_submissions("alice", std::slice::from_ref(&s), u64::MAX)
        .await?;
    s.observed_at = "2026-01-02T00:00:00.000Z".into();
    s.outcome = "won".into();
    store.insert_mining_submission(&s).await?;
    let rows = store.get_recent_mining_submissions("alice", 10).await?;
    assert_eq!(rows.len(), 2);
    let last = rows.first().ok_or("submission")?;
    assert_eq!(last.solution_number, u64::MAX);
    assert_eq!(last.qpu_access_time_us, u64::MAX);
    assert_eq!(last.outcome, "won");
    assert_eq!(last.observed_at, "2026-01-01T00:00:00.000Z");
    assert_eq!(
        store
            .count_mining_submissions_with_attempts("alice")
            .await?,
        2
    );
    store.set_mining_checkpoint("alice", 1).await?;
    assert_eq!(store.get_mining_checkpoint("alice").await?, Some(u64::MAX));
    assert!(
        store
            .commit_mining_submissions("bob", &[s], u64::MAX)
            .await
            .is_err()
    );
    assert!(store.get_mining_checkpoint("bob").await?.is_none());
    store.reset_mining_history("alice").await?;
    assert!(
        store
            .get_recent_mining_submissions("alice", 10)
            .await?
            .is_empty()
    );
    assert!(store.get_mining_checkpoint("alice").await?.is_none());
    Ok(())
}

async fn authorship(store: &Store) -> Result<(), Box<dyn Error>> {
    let _ = store
        .initialize_coverage(Indexable::Authorship, 1, 99.into())
        .await?;
    for n in [100, 99, 100, 101] {
        let b = BlockCommit {
            genesis: hash(0)?,
            hash: hash(n)?,
            height: n.into(),
            guards: vec![GenerationGuard {
                indexable: Indexable::Authorship,
                expected: 1,
            }],
            records: BlockRecords {
                authorship: Some(dashboard_store::AuthorshipRecord {
                    account_id: "validator".into(),
                    block_number: n.into(),
                    timestamp: 1_700_000_000 + n,
                    had_winner: n == 100,
                }),
                ..BlockRecords::default()
            },
            completed: vec![Indexable::Authorship],
        };
        let _ = store.commit_block(&b).await?;
    }
    assert_eq!(
        store.count_authorship_blocks_in_range("99", "100").await?,
        2
    );
    let rows = store.get_validator_authorship().await?;
    let a = rows.first().ok_or("authorship")?;
    assert_eq!(a.blocks_authored, 3);
    assert_eq!(a.blocks_authored_with_pow, 1);
    assert_eq!(a.last_authored_block, Some(101.into()));
    assert!(store.try_authorship_cutover().await?);
    assert!(store.try_authorship_cutover().await?);
    assert!(store.is_authorship_cutover().await?);
    let _ = store.reindex(&[Indexable::Authorship]).await?;
    assert!(!store.is_authorship_cutover().await?);
    let c = store
        .coverage(Indexable::Authorship)
        .await?
        .ok_or("coverage")?;
    assert_eq!(c.start, 99);
    assert_eq!(c.r#gen, 2);
    assert!(c.high.is_none());
    assert_eq!(
        store
            .get_validator_authorship()
            .await?
            .first()
            .ok_or("summary floor")?
            .blocks_authored,
        3
    );
    assert!(!store.try_authorship_cutover().await?);
    Ok(())
}

/// Node summaries follow the winner writes of `winner_queries`.
async fn node_summaries(store: &Store) -> Result<(), Box<dyn Error>> {
    let bob = store.get_node_summary("bob").await?.ok_or("bob summary")?;
    assert_eq!((bob.wins, bob.last_won_qblock_id), (1, 100.into()));
    assert_eq!(
        store
            .get_block(&bob.last_won_block_hash)
            .await?
            .ok_or("bob last won block")?
            .qblock_id,
        100.into()
    );
    // Qblock ids order numerically, so "44" outranks "9".
    let alice_blocks = store.get_blocks_by_miner("alice", 1000).await?;
    let alice = store
        .get_node_summary("alice")
        .await?
        .ok_or("alice summary")?;
    assert_eq!(alice.wins, u64::try_from(alice_blocks.len())?);
    assert_eq!(
        alice.last_won_qblock_id,
        alice_blocks
            .iter()
            .map(|b| b.qblock_id.to_string().parse::<u64>())
            .collect::<Result<Vec<_>, _>>()?
            .into_iter()
            .max()
            .ok_or("alice wins")?
            .into()
    );
    assert!(store.get_node_summary("carol").await?.is_none());
    Ok(())
}
async fn winner_queries(store: &Store) -> Result<(), Box<dyn Error>> {
    let b = batch(9, 1)?;
    let _ = store.commit_block(&b).await?;
    let mut enriched = batch(100, 1)?;
    let winner = enriched.records.winner.as_mut().ok_or("winner")?;
    winner.miner_id = "bob".into();
    winner.device_access_time_us = Some(u64::MAX);
    winner.topology_hash = Some(hash(123)?);
    let _ = store.commit_block(&enriched).await?;
    assert_eq!(
        store
            .get_recent_blocks(1, 1)
            .await?
            .first()
            .ok_or("page")?
            .substrate_block_number,
        44.into()
    );
    let mut replay = enriched.clone();
    replay
        .records
        .winner
        .as_mut()
        .ok_or("winner")?
        .device_access_time_us = None;
    replay
        .records
        .winner
        .as_mut()
        .ok_or("winner")?
        .topology_hash = None;
    assert_eq!(
        store.commit_block(&replay).await?,
        CommitResult::AlreadyApplied
    );
    assert_eq!(
        store
            .get_blocks_by_miner("bob", 1)
            .await?
            .first()
            .ok_or("block")?
            .device_access_time_us,
        Some(u64::MAX)
    );
    assert!(store.probe_device_access_time_data().await?.has_reported);
    let numbers: Vec<_> = (0..1100).map(|n| n.to_string()).collect();
    assert_eq!(store.get_existing_block_numbers(&numbers).await?.len(), 6);
    assert!(store.get_existing_block_numbers(&[]).await?.is_empty());
    assert_eq!(store.get_miner_wins().await?.len(), 2);
    assert_eq!(
        store
            .get_mining_history_since("2023-11-14T22:23:20.000Z")
            .await?
            .len(),
        1
    );
    let p = BlockCommit {
        genesis: hash(0)?,
        hash: hash(100)?,
        height: 100.into(),
        guards: vec![GenerationGuard {
            indexable: Indexable::Participation,
            expected: 2,
        }],
        records: BlockRecords {
            participation: vec![QBlockParticipationRecord {
                qblock_id: 100.into(),
                account: "bob".into(),
                kind: "Gpu".into(),
                budget_seconds: None,
                block_number: 99.into(),
            }],
            ..BlockRecords::default()
        },
        completed: vec![Indexable::Participation],
    };
    let _ = store.commit_block(&p).await?;
    let rows = store
        .get_participation_compute("2023-11-14T22:23:20.000Z")
        .await?;
    assert_eq!(rows.len(), 1);
    assert!((rows.first().ok_or("compute")?.mining_seconds - 336.0).abs() < f64::EPSILON);
    Ok(())
}

async fn poll_after_block(store: &Store) -> Result<(), Box<dyn Error>> {
    let d = DifficultyRecord {
        observed_at_block: 200.into(),
        difficulty_energy: -7.0,
        min_diversity: 0.1,
        min_solutions: 1,
        observed_at: "2026-01-01T00:00:00.000Z".into(),
        topology_hash: None,
        source: DifficultySource::Block,
    };
    let b = BlockCommit {
        genesis: hash(0)?,
        hash: hash(200)?,
        height: 200.into(),
        guards: vec![GenerationGuard {
            indexable: Indexable::Difficulty,
            expected: 2,
        }],
        records: BlockRecords {
            difficulty: Some(d.clone()),
            ..BlockRecords::default()
        },
        completed: vec![Indexable::Difficulty],
    };
    let _ = store.commit_block(&b).await?;
    assert!(store.insert_difficulty_snapshot(&d).await.is_err());
    let mut enriched = b.clone();
    enriched
        .records
        .difficulty
        .as_mut()
        .ok_or("difficulty")?
        .topology_hash = Some(hash(777)?);
    assert_eq!(store.commit_block(&enriched).await?, CommitResult::Applied);
    assert_eq!(
        store.commit_block(&enriched).await?,
        CommitResult::AlreadyApplied
    );
    enriched
        .records
        .difficulty
        .as_mut()
        .ok_or("difficulty")?
        .min_solutions = 2;
    assert!(store.commit_block(&enriched).await.is_err());
    let mut poll = d;
    poll.source = DifficultySource::Poll;
    poll.difficulty_energy = -6.0;
    store.insert_difficulty_snapshot(&poll).await?;
    let _ = store.reindex(&[Indexable::Difficulty]).await?;
    assert_eq!(store.get_recent_difficulty(1).await?.first(), Some(&poll));
    Ok(())
}

async fn timestamp_order(store: &Store) -> Result<(), Box<dyn Error>> {
    let poll = DifficultyRecord {
        observed_at_block: 300.into(),
        difficulty_energy: -7.0,
        min_diversity: 0.1,
        min_solutions: 1,
        observed_at: "2026-01-03T01:00:00+01:00".into(),
        topology_hash: None,
        source: DifficultySource::Poll,
    };
    store.insert_difficulty_snapshot(&poll).await?;
    let rows = store
        .get_difficulty_since("2026-01-03T01:30:00+01:00")
        .await?;
    assert!(rows.is_empty());
    assert_eq!(
        store
            .get_difficulty_anchor_before("2026-01-03T01:30:00+01:00")
            .await?
            .ok_or("anchor")?
            .observed_at,
        "2026-01-03T00:00:00.000Z"
    );
    Ok(())
}

async fn poll_dedup(store: &Store) -> Result<(), Box<dyn Error>> {
    // timestamp_order left a -7.0 poll at block 300; repeating it is a no-op.
    let mut poll = DifficultyRecord {
        observed_at_block: 301.into(),
        difficulty_energy: -7.0,
        min_diversity: 0.1,
        min_solutions: 1,
        observed_at: "2026-01-03T00:00:06.000Z".into(),
        topology_hash: None,
        source: DifficultySource::Poll,
    };
    store.insert_difficulty_snapshot(&poll).await?;
    let latest = store.get_recent_difficulty(1).await?;
    assert_eq!(
        latest.first().map(|d| d.observed_at_block.to_string()),
        Some("300".into()),
        "an unchanged poll must not add a row"
    );
    poll.observed_at_block = 302.into();
    poll.observed_at = "2026-01-03T00:00:12.000Z".into();
    poll.difficulty_energy = -8.0;
    store.insert_difficulty_snapshot(&poll).await?;
    assert_eq!(store.get_recent_difficulty(1).await?.first(), Some(&poll));
    Ok(())
}

async fn observability(store: &Store) -> Result<(), Box<dyn Error>> {
    let value: dashboard_model::IndexerObservability = serde_json::from_value(serde_json::json!({
        "chainHeadFromNode":"300","lastStatusFetchAt":"2026-01-01T00:00:00.000Z","lastBlockInsertAt":null,
        "lastSubstrateEventAt":null,"bestBlockHeight":"300","finalizedBlockHeight":"300","chainConnected":true,
        "minerStats":null,"deviceAccessTimeBackfill":"triggered","indexer":{"backfillQueueDepth":5,"coverage":{},"difficultyDataStartBlock":null,"backfillEtaSeconds":780}
    }))?;
    store.set_indexer_observability(&value).await?;
    assert_eq!(store.get_indexer_observability().await?, Some(value));
    Ok(())
}
