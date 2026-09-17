// SPDX-License-Identifier: AGPL-3.0-or-later
use crate::{
    MissingTopology, Store, StoreError,
    backend::{Connection, canonical_timestamp, decimal_gt, epoch, text},
    store::{snake, upsert, upsert_map},
};
use dashboard_model::{
    BlockRecord, DifficultyRecord, DifficultySource, MinerWinsRow, MiningHistoryRow,
    ParticipationComputeRow, QBlockParticipationRecord,
};
use serde_json::{Value, json};

pub(crate) async fn write_winner(c: &mut Connection, b: &BlockRecord) -> Result<u64, StoreError> {
    // Later enrichment may fill topology/device time, but does not erase richer data.
    let rows = c
        .query(
            "SELECT * FROM blocks WHERE block_hash=?1",
            &[b.block_hash.to_string().into()],
        )
        .await?;
    if let Some(row) = rows.first() {
        let existing: BlockRecord = crate::store::decode(row.clone())?;
        let mut incoming = b.clone();
        if incoming.topology_hash.is_none() {
            incoming.topology_hash = existing.topology_hash.clone();
        }
        if incoming.device_access_time_us.is_none() {
            incoming.device_access_time_us = existing.device_access_time_us;
        }
        if incoming == existing {
            return Ok(0);
        }
        return upsert(c, "blocks", &incoming, &["block_hash"], &[], None).await;
    }
    upsert(c, "blocks", b, &["block_hash"], &[], Some("NOTHING")).await
}
pub(crate) async fn write_difficulty(
    c: &mut Connection,
    d: &DifficultyRecord,
) -> Result<u64, StoreError> {
    if d.source == DifficultySource::Block {
        let rows = c.query("SELECT * FROM difficulty_history WHERE CAST(observed_at_block AS TEXT)=?1 AND source='block'", &[d.observed_at_block.to_string().into()]).await?;
        if let Some(row) = rows.first() {
            let existing: DifficultyRecord = crate::store::decode(row.clone())?;
            let mut incoming = d.clone();
            incoming.observed_at = canonical_timestamp(&incoming.observed_at)?;
            if incoming.topology_hash.is_none() {
                incoming.topology_hash = existing.topology_hash.clone();
            }
            if incoming == existing {
                return Ok(0);
            }
            let mut enriched = existing;
            if enriched.topology_hash.is_none() {
                enriched.topology_hash = incoming.topology_hash.clone();
            }
            if incoming != enriched {
                return Err(StoreError::Invalid("conflicting block difficulty".into()));
            }
            return upsert(
                c,
                "difficulty_history",
                &incoming,
                &["observed_at_block"],
                &[],
                None,
            )
            .await;
        }
        // Preserve irreproducible poll provenance before the historical block takes precedence.
        let old=c.query("SELECT * FROM difficulty_history WHERE CAST(observed_at_block AS TEXT)=?1 AND source='poll'",&[d.observed_at_block.to_string().into()]).await?;
        for row in old {
            let _ = upsert_map(
                c,
                "dashboard_poll_difficulty",
                &row,
                &["observed_at_block"],
                &[],
                Some("NOTHING"),
            )
            .await?;
        }
        upsert(
            c,
            "difficulty_history",
            d,
            &["observed_at_block"],
            &[],
            Some("difficulty_history.source='poll'"),
        )
        .await
    } else {
        let _ = upsert(
            c,
            "dashboard_poll_difficulty",
            d,
            &["observed_at_block"],
            &[],
            Some("NOTHING"),
        )
        .await?;
        upsert(
            c,
            "difficulty_history",
            d,
            &["observed_at_block"],
            &[],
            Some("NOTHING"),
        )
        .await
    }
}
#[expect(
    clippy::cast_possible_truncation,
    reason = "The budget is checked finite, integral, nonnegative, and within i32 before casting"
)]
pub(crate) async fn write_participant(
    c: &mut Connection,
    p: &QBlockParticipationRecord,
) -> Result<u64, StoreError> {
    // Native INTEGER storage rejects fractional and invalid declared budgets consistently.
    if p.budget_seconds
        .is_some_and(|n| !n.is_finite() || n < 0.0 || n.fract() != 0.0 || n > f64::from(i32::MAX))
    {
        return Err(StoreError::Invalid("invalid participant budget".into()));
    }
    let mut object = serde_json::to_value(p)?
        .as_object()
        .cloned()
        .ok_or_else(|| StoreError::Invalid("participant record".into()))?;
    if let Some(n) = p.budget_seconds {
        let _ = object.insert("budgetSeconds".into(), json!(n as i64));
    }
    let object = object.into_iter().map(|(k, v)| (snake(&k), v)).collect();
    upsert_map(c,"qblock_participation",&object,&["qblock_id","account"],&[],Some("qblock_participation.kind IS DISTINCT FROM excluded.kind OR qblock_participation.budget_seconds IS DISTINCT FROM excluded.budget_seconds OR qblock_participation.block_number IS DISTINCT FROM excluded.block_number")).await
}
impl Store {
    /// Newest winners first, with bounded pagination.
    ///
    /// # Errors
    /// Returns storage, validation, or network identity errors.
    pub async fn get_recent_blocks(
        &self,
        limit: u32,
        offset: u64,
    ) -> Result<Vec<BlockRecord>, StoreError> {
        self.api_rows("SELECT * FROM blocks ORDER BY length(CAST(substrate_block_number AS TEXT)) DESC,substrate_block_number DESC LIMIT CAST(?1 AS INTEGER) OFFSET CAST(?2 AS BIGINT)",&[limit.min(1000).into(),offset.into()]).await
    }
    /// Newest wins for one account.
    ///
    /// # Errors
    /// Returns storage, validation, or network identity errors.
    pub async fn get_blocks_by_miner(
        &self,
        miner: &str,
        limit: u32,
    ) -> Result<Vec<BlockRecord>, StoreError> {
        self.rows("SELECT * FROM blocks WHERE miner_id=?1 ORDER BY length(CAST(substrate_block_number AS TEXT)) DESC,substrate_block_number DESC LIMIT CAST(?2 AS INTEGER)",&[miner.into(),limit.min(1000).into()]).await
    }
    /// SQL aggregate of indexed wins, sorted by count.
    ///
    /// # Errors
    /// Returns storage, validation, or network identity errors.
    pub async fn get_miner_wins(&self) -> Result<Vec<MinerWinsRow>, StoreError> {
        self.api_rows("SELECT miner_id,COUNT(*) AS wins,MIN(energy) AS best_energy,AVG(mining_time) AS avg_mining_time,MAX(timestamp) AS last_won_at FROM blocks GROUP BY miner_id ORDER BY wins DESC,miner_id",&[]).await
    }
    /// Slim chart history, filtered in SQL by Unix-second cutoff.
    ///
    /// # Errors
    /// Returns storage, validation, or network identity errors.
    pub async fn get_mining_history_since(
        &self,
        since: &str,
    ) -> Result<Vec<MiningHistoryRow>, StoreError> {
        self.api_rows("SELECT qblock_id,substrate_block_number,timestamp,miner_id,mining_time FROM blocks WHERE timestamp>=CAST(?1 AS BIGINT) ORDER BY length(CAST(substrate_block_number AS TEXT)),substrate_block_number",&[epoch(since)?.into()]).await
    }
    /// Bounded topology repair candidates.
    ///
    /// # Errors
    /// Returns storage, validation, or network identity errors.
    pub async fn get_blocks_missing_topology(
        &self,
        limit: u32,
    ) -> Result<Vec<MissingTopology>, StoreError> {
        self.rows("SELECT block_hash,substrate_block_number FROM blocks WHERE topology_hash IS NULL ORDER BY length(CAST(substrate_block_number AS TEXT)) DESC,substrate_block_number DESC LIMIT CAST(?1 AS INTEGER)",&[limit.min(1000).into()]).await
    }
    /// Backfill one winner topology through the writer.
    ///
    /// # Errors
    /// Returns storage, validation, or network identity errors.
    pub async fn set_block_topology(&self, hash: &str, topology: &str) -> Result<(), StoreError> {
        let _ = self
            .mutate(
                "UPDATE blocks SET topology_hash=?2 WHERE block_hash=?1",
                &[hash.into(), topology.into()],
            )
            .await?;
        Ok(())
    }
    /// Tag previously untagged difficulty history at or after a topology boundary.
    ///
    /// # Errors
    /// Returns storage, validation, or network identity errors.
    pub async fn backfill_difficulty_topology(
        &self,
        from: &str,
        topology: &str,
    ) -> Result<u64, StoreError> {
        let cond = decimal_gt("?1", "observed_at_block");
        self.mutate(&format!("UPDATE difficulty_history SET topology_hash=?2 WHERE topology_hash IS NULL AND NOT {cond}"),&[from.into(),topology.into()]).await
    }
    /// Targeted existence lookup, chunked under engine parameter bounds.
    ///
    /// # Errors
    /// Returns storage, validation, or network identity errors.
    pub async fn get_existing_block_numbers(
        &self,
        numbers: &[String],
    ) -> Result<Vec<String>, StoreError> {
        self.existing("blocks", "substrate_block_number", "", numbers)
            .await
    }
    /// Winner-derived difficulty rows only.
    ///
    /// # Errors
    /// Returns storage, validation, or network identity errors.
    pub async fn get_existing_difficulty_block_numbers(
        &self,
        numbers: &[String],
    ) -> Result<Vec<String>, StoreError> {
        self.existing(
            "difficulty_history",
            "observed_at_block",
            " AND source='block'",
            numbers,
        )
        .await
    }
    async fn existing(
        &self,
        table: &str,
        column: &str,
        extra: &str,
        numbers: &[String],
    ) -> Result<Vec<String>, StoreError> {
        let mut out = Vec::new();
        for chunk in numbers.chunks(500) {
            let placeholders: Vec<_> = (1..=chunk.len()).map(|i| format!("?{i}")).collect();
            let args: Vec<Value> = chunk.iter().cloned().map(Into::into).collect();
            let rows=self.query(&format!("SELECT CAST({column} AS TEXT) AS number FROM {table} WHERE CAST({column} AS TEXT) IN ({}){extra}",placeholders.join(",")),&args).await?;
            for r in rows {
                out.push(text(&r, "number")?);
            }
        }
        Ok(out)
    }
    /// Idempotently mark a stored winner finalized.
    ///
    /// # Errors
    /// Returns storage, validation, or network identity errors.
    pub async fn mark_block_finalized(&self, hash: &str) -> Result<(), StoreError> {
        let _ = self
            .mutate(
                "UPDATE blocks SET finalized=TRUE WHERE block_hash=?1 AND finalized=FALSE",
                &[hash.into()],
            )
            .await?;
        Ok(())
    }
    /// Persist a live poll snapshot without overwriting winner-derived difficulty.
    ///
    /// # Errors
    /// Returns storage, validation, or network identity errors.
    pub async fn insert_difficulty_snapshot(&self, d: &DifficultyRecord) -> Result<(), StoreError> {
        self.ensure_writable()?;
        if d.source != DifficultySource::Poll {
            return Err(StoreError::Invalid(
                "block difficulty requires a generation-guarded block commit".into(),
            ));
        }
        let mut tx = self.write().await?;
        let _ = crate::store::require_bound(tx.conn()).await?;
        let _ = write_difficulty(tx.conn(), d).await?;
        tx.commit().await
    }
    /// Recent difficulty ordered by observation time.
    ///
    /// # Errors
    /// Returns storage, validation, or network identity errors.
    pub async fn get_recent_difficulty(
        &self,
        limit: u32,
    ) -> Result<Vec<DifficultyRecord>, StoreError> {
        self.api_rows(
            "SELECT * FROM difficulty_history ORDER BY observed_at DESC LIMIT CAST(?1 AS INTEGER)",
            &[limit.min(1000).into()],
        )
        .await
    }
    /// Windowed difficulty ordered oldest first.
    ///
    /// # Errors
    /// Returns storage, validation, or network identity errors.
    pub async fn get_difficulty_since(
        &self,
        since: &str,
    ) -> Result<Vec<DifficultyRecord>, StoreError> {
        let since = canonical_timestamp(since)?;
        let p = crate::backend::parameter(1, "timestamptz", self.pg());
        self.api_rows(
            &format!(
                "SELECT * FROM difficulty_history WHERE observed_at>={p} ORDER BY observed_at"
            ),
            &[since.into()],
        )
        .await
    }
    /// Latest difficulty strictly before a chart cutoff.
    ///
    /// # Errors
    /// Returns storage, validation, or network identity errors.
    pub async fn get_difficulty_anchor_before(
        &self,
        since: &str,
    ) -> Result<Option<DifficultyRecord>, StoreError> {
        let since = canonical_timestamp(since)?;
        let p = crate::backend::parameter(1, "timestamptz", self.pg());
        self.api_one(&format!("SELECT * FROM difficulty_history WHERE observed_at<{p} ORDER BY observed_at DESC LIMIT 1"),&[since.into()]).await
    }
    /// Delete a difficulty writer's records.
    ///
    /// # Errors
    /// Returns storage, validation, or network identity errors.
    pub async fn delete_difficulty_history_by_source(
        &self,
        source: DifficultySource,
    ) -> Result<u64, StoreError> {
        self.mutate(
            "DELETE FROM difficulty_history WHERE source=?1",
            &[serde_json::to_value(source)?],
        )
        .await
    }
    /// Participant records in stable account order.
    ///
    /// # Errors
    /// Returns storage, validation, or network identity errors.
    pub async fn get_qblock_participation(
        &self,
        qblock: &str,
    ) -> Result<Vec<QBlockParticipationRecord>, StoreError> {
        self.rows(
            "SELECT * FROM qblock_participation WHERE CAST(qblock_id AS TEXT)=?1 ORDER BY account",
            &[qblock.into()],
        )
        .await
    }
    /// SQL predecessor lookup preserves the block before the requested window.
    ///
    /// # Errors
    /// Returns storage, validation, or network identity errors.
    pub async fn get_participation_compute(
        &self,
        since: &str,
    ) -> Result<Vec<ParticipationComputeRow>, StoreError> {
        let before = decimal_gt("b.qblock_id", "candidate.qblock_id");
        let query = format!(
            "SELECT p.qblock_id,p.account,p.kind,(b.timestamp-pred.timestamp) AS mining_seconds,ms.qpu_access_time_us AS exact_qpu_access_us FROM blocks b JOIN blocks pred ON pred.block_hash=(SELECT candidate.block_hash FROM blocks candidate WHERE {before} ORDER BY length(CAST(candidate.qblock_id AS TEXT)) DESC,candidate.qblock_id DESC LIMIT 1) JOIN qblock_participation p ON p.qblock_id=b.qblock_id LEFT JOIN mining_submissions ms ON ms.miner_id=p.account AND CAST(ms.solution_number AS TEXT)=CAST(p.qblock_id AS TEXT) WHERE b.timestamp>=CAST(?1 AS BIGINT) AND b.timestamp-pred.timestamp>0 ORDER BY length(CAST(p.qblock_id AS TEXT)),p.qblock_id,p.account"
        );
        self.api_rows(&query, &[epoch(since)?.into()]).await
    }
}
