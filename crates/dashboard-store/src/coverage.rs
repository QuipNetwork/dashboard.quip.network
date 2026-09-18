// SPDX-License-Identifier: AGPL-3.0-or-later
use crate::{
    BlockCommit, CommitResult, Coverage, GenerationGuard, Indexable, RangeCompletion,
    RetainedBlock, Scan, ScanId, ScanProgress, Store, StoreError,
    backend::{Connection, decimal_order, now, text},
    store::{Write, get_meta, require_bound, set_meta},
};
use crate::{backend, blocks, miners};
use dashboard_model::{BlockHash, DecimalString as BlockHeight};
use serde_json::{Value, json};
use std::collections::BTreeMap;

impl Coverage {
    /// Empty coverage preserves the domain's first eligible height.
    #[must_use]
    pub fn empty(r#gen: u64, start: u64) -> Self {
        Self {
            v: 1,
            r#gen,
            start,
            low: None,
            high: None,
            gaps: Vec::new(),
            pruned_floor: None,
            updated_at: None,
        }
    }
    /// Whether the interval has been persisted without gaps.
    #[must_use]
    pub fn contains(&self, from: u64, through: u64) -> bool {
        from <= through
            && self.low.is_some_and(|n| n <= from)
            && self.high.is_some_and(|n| n >= through)
            && !self.gaps.iter().any(|[a, b]| *a <= through && *b >= from)
    }
    pub(crate) fn cover(&mut self, a: u64, b: u64) -> Result<bool, StoreError> {
        if a > b || a < self.start {
            return Err(StoreError::Invalid("coverage outside domain floor".into()));
        }
        if self.contains(a, b) {
            return Ok(false);
        }
        if let (Some(low), Some(high)) = (self.low, self.high) {
            if a > high.saturating_add(1) {
                self.gaps.push([high + 1, a - 1]);
            }
            if b.saturating_add(1) < low {
                self.gaps.push([b + 1, low - 1]);
            }
            let mut gaps = Vec::new();
            for [x, y] in &self.gaps {
                if *y < a || *x > b {
                    gaps.push([*x, *y]);
                    continue;
                }
                if *x < a {
                    gaps.push([*x, a - 1]);
                }
                if *y > b {
                    gaps.push([b + 1, *y]);
                }
            }
            gaps.sort_unstable();
            self.gaps = gaps;
            self.low = Some(low.min(a));
            self.high = Some(high.max(b));
        } else {
            self.low = Some(a);
            self.high = Some(b);
        }
        self.updated_at = Some(now());
        Ok(true)
    }
}
fn generation_key(i: Indexable) -> String {
    format!("indexer.generation.{}", i.name())
}
fn coverage_key(i: Indexable) -> String {
    format!("indexer.coverage.{}", i.name())
}
async fn generation(c: &mut Connection, i: Indexable) -> Result<u64, StoreError> {
    let raw = get_meta(c, &generation_key(i)).await?;
    Ok(raw
        .and_then(|s| s.parse::<u64>().ok())
        .filter(|n| *n > 0)
        .unwrap_or(1))
}
async fn coverage(c: &mut Connection, i: Indexable, start: u64) -> Result<Coverage, StoreError> {
    let r#gen = generation(c, i).await?;
    let Some(raw) = get_meta(c, &coverage_key(i)).await? else {
        return Ok(Coverage::empty(r#gen, start));
    };
    let cov: Coverage = serde_json::from_str(&raw)?;
    if cov.v != 1
        || cov.r#gen != r#gen
        || (cov.low.is_some() != cov.high.is_some())
        || cov.low.zip(cov.high).is_some_and(|(l, h)| l > h)
    {
        return Err(StoreError::Invalid("invalid persisted coverage".into()));
    }
    let mut previous = None;
    for [a, b] in &cov.gaps {
        if a > b
            || cov.low.is_none_or(|l| l >= *a)
            || cov.high.is_none_or(|h| h <= *b)
            || previous.is_some_and(|p: u64| p.saturating_add(1) >= *a)
        {
            return Err(StoreError::Invalid(
                "invalid persisted coverage gaps".into(),
            ));
        }
        previous = Some(*b);
    }
    Ok(cov)
}
async fn save_coverage(c: &mut Connection, i: Indexable, cov: &Coverage) -> Result<(), StoreError> {
    set_meta(c, &coverage_key(i), Some(&serde_json::to_string(cov)?)).await
}
fn height(h: &BlockHeight) -> Result<u64, StoreError> {
    h.to_string()
        .parse()
        .map_err(|_| StoreError::Invalid("height exceeds u64".into()))
}
async fn network(c: &mut Connection, g: &BlockHash) -> Result<(), StoreError> {
    if require_bound(c).await? != g.to_string() {
        return Err(StoreError::NetworkIdentity);
    }
    Ok(())
}

impl Store {
    /// Read a domain generation; absent legacy generations mean one.
    ///
    /// # Errors
    /// Returns storage, validation, or network identity errors.
    pub async fn generation(&self, indexable: Indexable) -> Result<u64, StoreError> {
        let raw = self.meta(&generation_key(indexable)).await?;
        Ok(raw
            .and_then(|s| s.parse().ok())
            .filter(|n| *n > 0)
            .unwrap_or(1))
    }
    /// Check whether a verified finalized target has an actual current-generation commit.
    /// Identity and coverage are read in one snapshot. Announced targets, pruning floors,
    /// and unavailable markers alone never count as committed progress.
    ///
    /// # Errors
    /// Returns storage errors, invalid persisted coverage, or a conflicting hash.
    pub async fn committed_target(&self, target: &RetainedBlock) -> Result<bool, StoreError> {
        let rows=self.query("SELECT 'identity' AS key,hash AS value FROM dashboard_finalized WHERE height=?1 UNION ALL SELECT key,value FROM meta WHERE key IN ('indexer.coverage.winners','indexer.coverage.difficulty','indexer.coverage.participation','indexer.coverage.authorship','indexer.generation.winners','indexer.generation.difficulty','indexer.generation.participation','indexer.generation.authorship')",&[target.height.to_string().into()]).await?;
        let values = rows
            .iter()
            .map(|row| Ok((text(row, "key")?, text(row, "value")?)))
            .collect::<Result<BTreeMap<_, _>, StoreError>>()?;
        let Some(hash) = values.get("identity") else {
            return Ok(false);
        };
        if hash
            .parse::<BlockHash>()
            .map_err(|error| StoreError::Invalid(error.to_string()))?
            != target.hash
        {
            return Err(StoreError::ConflictingHistory(target.height.to_string()));
        }
        let number = height(&target.height)?;
        for domain in [
            Indexable::Winners,
            Indexable::Difficulty,
            Indexable::Participation,
            Indexable::Authorship,
        ] {
            let Some(value) = values.get(&coverage_key(domain)) else {
                continue;
            };
            let coverage: Coverage = serde_json::from_str(value)?;
            let generation = values
                .get(&generation_key(domain))
                .and_then(|value| value.parse::<u64>().ok())
                .filter(|generation| *generation > 0)
                .unwrap_or(1);
            if coverage.r#gen == generation && coverage.contains(number, number) {
                return Ok(true);
            }
        }
        Ok(false)
    }
    /// Read stored coverage without claiming work for an uninitialized domain.
    ///
    /// # Errors
    /// Returns storage, validation, or network identity errors.
    pub async fn coverage(&self, indexable: Indexable) -> Result<Option<Coverage>, StoreError> {
        self.meta(&coverage_key(indexable))
            .await?
            .map(|s| serde_json::from_str(&s).map_err(Into::into))
            .transpose()
    }
    /// Enumerate retained hash evidence in bounded pages before network binding.
    ///
    /// # Errors
    /// Returns storage, validation, or network identity errors.
    pub async fn retained_history(
        &self,
        limit: u32,
        offset: u64,
    ) -> Result<Vec<RetainedBlock>, StoreError> {
        let rows=self.query("SELECT height,hash FROM (SELECT height,hash FROM dashboard_finalized UNION SELECT CAST(substrate_block_number AS TEXT) AS height,substrate_block_hash AS hash FROM blocks UNION SELECT CAST(finalized_block_number AS TEXT) AS height,finalized_block_hash AS hash FROM chain_head) history ORDER BY length(height),height,hash LIMIT CAST(?1 AS INTEGER) OFFSET CAST(?2 AS BIGINT)",&[limit.min(1000).into(),offset.into()]).await?;
        rows.iter()
            .map(|r| {
                Ok(RetainedBlock {
                    height: text(r, "height")?
                        .parse()
                        .map_err(|_| StoreError::Invalid("invalid retained height".into()))?,
                    hash: text(r, "hash")?
                        .parse()
                        .map_err(|_| StoreError::Invalid("invalid retained hash".into()))?,
                })
            })
            .collect()
    }
    /// Read verified persistent genesis for administrative operations without upstream access.
    ///
    /// # Errors
    /// Returns storage or invalid persisted hash errors.
    pub async fn bound_genesis(&self) -> Result<Option<BlockHash>, StoreError> {
        self.meta("dashboard.genesis")
            .await?
            .map(|hash| {
                hash.parse()
                    .map_err(|_| StoreError::Invalid("invalid bound genesis".into()))
            })
            .transpose()
    }
    /// Bind verified genesis only after all retained height/hash evidence agrees.
    ///
    /// # Errors
    /// Returns storage, validation, or network identity errors.
    pub async fn bind_network(
        &self,
        genesis: &BlockHash,
        evidence: &[RetainedBlock],
    ) -> Result<(), StoreError> {
        self.bind_network_with(genesis, |row| {
            std::future::ready(if evidence.contains(&row) {
                Ok(row.hash)
            } else {
                Err(StoreError::NetworkIdentity)
            })
        })
        .await
    }
    /// Verify every retained identity in bounded pages, then persist verified genesis.
    /// The callback returns the upstream hash at the supplied height. It must not mutate
    /// this store: verification holds the writer lock, with no SQL transaction open.
    /// Cancelling or failing verification leaves an unbound database unbound.
    ///
    /// # Errors
    /// Returns callback, storage, or mismatching network identity errors.
    pub async fn bind_network_with<F, Fut>(
        &self,
        genesis: &BlockHash,
        mut verify: F,
    ) -> Result<(), StoreError>
    where
        F: FnMut(RetainedBlock) -> Fut,
        Fut: Future<Output = Result<BlockHash, StoreError>>,
    {
        let mut writer = self.lock_writer().await?;
        if let Some(bound) = get_meta(&mut writer.conn, "dashboard.genesis").await? {
            if bound != genesis.to_string() {
                return Err(StoreError::NetworkIdentity);
            }
            return Ok(());
        }
        let mut offset = 0;
        let mut any = false;
        loop {
            let rows = self.retained_history(512, offset).await?;
            if rows.is_empty() {
                break;
            }
            any = true;
            offset += u64::try_from(rows.len()).map_err(|e| StoreError::Invalid(e.to_string()))?;
            for row in rows {
                let retained_hash = row.hash.clone();
                if verify(row).await? != retained_hash {
                    return Err(StoreError::NetworkIdentity);
                }
            }
        }
        if !any {
            for table in [
                "blocks",
                "difficulty_history",
                "validator_authorship",
                "validator_authorship_blocks",
                "node_descriptors",
                "qblock_participation",
                "chain_miners",
            ] {
                if !writer
                    .conn
                    .query(&format!("SELECT 1 AS present FROM {table} LIMIT 1"), &[])
                    .await?
                    .is_empty()
                {
                    return Err(StoreError::NetworkIdentity);
                }
            }
        }
        let mut tx = Write::begin(writer).await?;
        set_meta(tx.conn(), "dashboard.genesis", Some(&genesis.to_string())).await?;
        tx.commit().await
    }
    /// Apply independently guarded domain records and merge coverage in one transaction.
    #[expect(
        clippy::too_many_lines,
        reason = "Keep the complete transaction scenario visible for auditing"
    )]
    ///
    /// # Errors
    /// Returns storage, validation, or network identity errors.
    pub async fn commit_block(&self, batch: &BlockCommit) -> Result<CommitResult, StoreError> {
        self.ensure_writable()?;
        let mut guards = BTreeMap::new();
        for g in &batch.guards {
            if guards.insert(g.indexable, g.expected).is_some() {
                return Err(StoreError::Invalid("duplicate generation guard".into()));
            }
        }
        let mut affected = batch.completed.clone();
        if batch.records.winner.is_some() {
            affected.push(Indexable::Winners);
        }
        if batch.records.difficulty.is_some() {
            affected.push(Indexable::Difficulty);
        }
        if batch.records.authorship.is_some() {
            affected.push(Indexable::Authorship);
        }
        if !batch.records.participation.is_empty() {
            affected.push(Indexable::Participation);
        }
        if affected.is_empty() || affected.iter().any(|i| !guards.contains_key(i)) {
            return Err(StoreError::Invalid(
                "every record and completion requires a guard".into(),
            ));
        }
        let n = height(&batch.height)?;
        let mut tx = self.write().await?;
        network(tx.conn(), &batch.genesis).await?;
        for (i, expected) in &guards {
            if generation(tx.conn(), *i).await? != *expected {
                return Ok(CommitResult::StaleGeneration);
            }
        }
        let existing=tx.conn().query("SELECT hash FROM dashboard_finalized WHERE height=?1 UNION SELECT substrate_block_hash AS hash FROM blocks WHERE CAST(substrate_block_number AS TEXT)=?1",&[batch.height.to_string().into()]).await?;
        for row in &existing {
            if text(row, "hash")? != batch.hash.to_string() {
                return Err(StoreError::ConflictingHistory(batch.height.to_string()));
            }
        }
        // Validate finalized provenance before changing any domain.
        if let Some(w) = &batch.records.winner
            && (w.substrate_block_number != batch.height
                || w.substrate_block_hash != batch.hash
                || !w.finalized)
        {
            return Err(StoreError::Invalid(
                "winner provenance does not match finalized commit".into(),
            ));
        }
        if let Some(d) = &batch.records.difficulty
            && (d.observed_at_block != batch.height
                || d.source != dashboard_model::DifficultySource::Block)
        {
            return Err(StoreError::Invalid(
                "difficulty provenance does not match commit".into(),
            ));
        }
        if let Some(a) = &batch.records.authorship
            && a.block_number != batch.height
        {
            return Err(StoreError::Invalid(
                "authorship height does not match commit".into(),
            ));
        }
        let mut changed = false;
        if let Some(w) = &batch.records.winner {
            changed |= blocks::write_winner(tx.conn(), w).await? > 0;
        }
        if let Some(d) = &batch.records.difficulty {
            changed |= blocks::write_difficulty(tx.conn(), d).await? > 0;
        }
        if let Some(a) = &batch.records.authorship {
            changed |= miners::write_authorship(tx.conn(), a).await? > 0;
        }
        for p in &batch.records.participation {
            changed |= blocks::write_participant(tx.conn(), p).await? > 0;
        }
        for i in &batch.completed {
            let mut cov = coverage(
                tx.conn(),
                *i,
                if *i == Indexable::Authorship { n } else { 0 },
            )
            .await?;
            if cov.cover(n, n)? {
                save_coverage(tx.conn(), *i, &cov).await?;
                changed = true;
            }
        }
        if batch.records.authorship.is_some()
            && get_meta(tx.conn(), "indexer.authorship.cutover")
                .await?
                .as_deref()
                == Some("1")
        {
            miners::recompute(tx.conn()).await?;
        }
        let _ = tx.conn().execute("INSERT INTO dashboard_finalized(height,hash) VALUES(?1,?2) ON CONFLICT(height) DO NOTHING",&[batch.height.to_string().into(),batch.hash.to_string().into()]).await?;
        tx.commit().await?;
        Ok(if changed {
            CommitResult::Applied
        } else {
            CommitResult::AlreadyApplied
        })
    }
    /// Create or resume one pinned winner enumeration. State identity is immutable.
    ///
    /// # Errors
    /// Returns storage, validation, or network identity errors.
    pub async fn begin_scan(&self, scan: &Scan) -> Result<CommitResult, StoreError> {
        self.ensure_writable()?;
        if scan.id.0.is_empty() {
            return Err(StoreError::Invalid("empty scan identifier".into()));
        }
        let mut tx = self.write().await?;
        network(tx.conn(), &scan.genesis).await?;
        if generation(tx.conn(), scan.indexable).await? != scan.expected_generation {
            return Ok(CommitResult::StaleGeneration);
        }
        let old = tx
            .conn()
            .query(
                "SELECT * FROM dashboard_scans WHERE id=?1",
                &[scan.id.0.clone().into()],
            )
            .await?;
        if let Some(old) = old.first() {
            if text(old, "at_hash")? != scan.at.to_string()
                || text(old, "genesis")? != scan.genesis.to_string()
                || text(old, "generation")? != scan.expected_generation.to_string()
                || text(old, "domain")? != scan.indexable.name()
                || text(old, "finalized_height")? != scan.finalized_height.to_string()
            {
                return Err(StoreError::Invalid(
                    "scan cursor reused for different state".into(),
                ));
            }
            return Ok(CommitResult::AlreadyApplied);
        }
        let _ = tx.conn().execute("INSERT INTO dashboard_scans(id,genesis,at_hash,finalized_height,domain,generation,finished) VALUES(?1,?2,?3,?4,?5,?6,FALSE)",&[scan.id.0.clone().into(),scan.genesis.to_string().into(),scan.at.to_string().into(),scan.finalized_height.to_string().into(),scan.indexable.name().into(),scan.expected_generation.to_string().into()]).await?;
        tx.commit().await?;
        Ok(CommitResult::Applied)
    }
    /// Persist a bounded enumeration page and its cursor together. None means exhaustion.
    ///
    /// # Errors
    /// Returns storage, validation, or network identity errors.
    pub async fn append_scan_page(
        &self,
        scan_id: &ScanId,
        expected_cursor: Option<&[u8]>,
        next_cursor: Option<&[u8]>,
        heights: &[BlockHeight],
    ) -> Result<CommitResult, StoreError> {
        self.ensure_writable()?;
        if heights.len() > 1000 || next_cursor.is_some_and(|n| Some(n) == expected_cursor) {
            return Err(StoreError::Invalid(
                "oversize or non-advancing scan page".into(),
            ));
        }
        let mut tx = self.write().await?;
        let bound = require_bound(tx.conn()).await?;
        let rows = tx
            .conn()
            .query(
                "SELECT * FROM dashboard_scans WHERE id=?1",
                &[scan_id.0.clone().into()],
            )
            .await?;
        let row = rows.first().ok_or(StoreError::IncompleteScan)?;
        if text(row, "genesis")? != bound {
            return Err(StoreError::NetworkIdentity);
        }
        let domain: Indexable = serde_json::from_value(json!(text(row, "domain")?))?;
        if generation(tx.conn(), domain).await?.to_string() != text(row, "generation")? {
            return Ok(CommitResult::StaleGeneration);
        }
        let finished =
            row.get("finished") == Some(&json!(true)) || row.get("finished") == Some(&json!(1));
        let cursor = row
            .get("cursor")
            .filter(|v| !v.is_null())
            .map(|v| v.as_str().ok_or(StoreError::IncompleteScan))
            .transpose()?;
        let expected = expected_cursor.map(serde_json::to_string).transpose()?;
        if finished || cursor != expected.as_deref() {
            return Err(StoreError::IncompleteScan);
        }
        let ceiling: u64 = text(row, "finalized_height")?
            .parse()
            .map_err(|_| StoreError::IncompleteScan)?;
        for n in heights {
            if height(n)? > ceiling {
                return Err(StoreError::Invalid(
                    "winner above pinned finalized state".into(),
                ));
            }
            let _ = tx.conn().execute("INSERT INTO dashboard_scan_winners(scan_id,height) VALUES(?1,?2) ON CONFLICT(scan_id,height) DO NOTHING",&[scan_id.0.clone().into(),n.to_string().into()]).await?;
        }
        let next = next_cursor.map(serde_json::to_string).transpose()?;
        let sql = if next_cursor.is_none() {
            "UPDATE dashboard_scans SET cursor=?2,finished=TRUE WHERE id=?1"
        } else {
            "UPDATE dashboard_scans SET cursor=?2 WHERE id=?1"
        };
        let _ = tx
            .conn()
            .execute(
                sql,
                &[
                    scan_id.0.clone().into(),
                    next.map_or(Value::Null, Into::into),
                ],
            )
            .await?;
        tx.commit().await?;
        Ok(CommitResult::Applied)
    }
    /// Read the durable cursor for a restart.
    ///
    /// # Errors
    /// Returns storage, validation, or network identity errors.
    pub async fn scan_progress(&self, id: &ScanId) -> Result<Option<ScanProgress>, StoreError> {
        let rows = self
            .query(
                "SELECT cursor,finished FROM dashboard_scans WHERE id=?1",
                &[id.0.clone().into()],
            )
            .await?;
        rows.first()
            .map(|r| {
                Ok(ScanProgress {
                    cursor: r
                        .get("cursor")
                        .filter(|v| !v.is_null())
                        .map(|v| {
                            serde_json::from_str(v.as_str().ok_or(StoreError::IncompleteScan)?)
                                .map_err(StoreError::from)
                        })
                        .transpose()?,
                    finished: r.get("finished") == Some(&json!(true))
                        || r.get("finished") == Some(&json!(1)),
                })
            })
            .transpose()
    }
    /// Complete a range only after exhausted enumeration and all its winner commits.
    ///
    /// # Errors
    /// Returns storage, validation, or network identity errors.
    pub async fn commit_range(&self, r: &RangeCompletion) -> Result<CommitResult, StoreError> {
        self.ensure_writable()?;
        let from = height(&r.from)?;
        let through = height(&r.through)?;
        if from > through {
            return Err(StoreError::Invalid("reversed range".into()));
        }
        let mut tx = self.write().await?;
        network(tx.conn(), &r.genesis).await?;
        if generation(tx.conn(), r.indexable).await? != r.expected_generation {
            return Ok(CommitResult::StaleGeneration);
        }
        let rows = tx
            .conn()
            .query(
                "SELECT * FROM dashboard_scans WHERE id=?1 AND finished=TRUE",
                &[r.scan_id.0.clone().into()],
            )
            .await?;
        let s = rows.first().ok_or(StoreError::IncompleteScan)?;
        if text(s, "genesis")? != r.genesis.to_string()
            || text(s, "domain")? != r.indexable.name()
            || text(s, "generation")? != r.expected_generation.to_string()
            || text(s, "finalized_height")?
                .parse::<u64>()
                .map_err(|_| StoreError::IncompleteScan)?
                < through
        {
            return Err(StoreError::IncompleteScan);
        }
        // Only winner-based domains can infer non-winner completion from QBlock enumeration.
        if r.indexable == Indexable::Authorship {
            return Err(StoreError::Invalid(
                "authorship requires per-block evidence".into(),
            ));
        }
        let mut cov = coverage(tx.conn(), r.indexable, 0).await?;
        let mut offset = 0_u64;
        loop {
            let rows=tx.conn().query(&format!("SELECT height FROM dashboard_scan_winners WHERE scan_id=?1 ORDER BY {} LIMIT 512 OFFSET CAST(?2 AS BIGINT)",decimal_order("height")),&[r.scan_id.0.clone().into(),offset.into()]).await?;
            if rows.is_empty() {
                break;
            }
            for row in &rows {
                let n: u64 = text(row, "height")?
                    .parse()
                    .map_err(|_| StoreError::IncompleteScan)?;
                if from <= n && n <= through && !cov.contains(n, n) {
                    return Err(StoreError::IncompleteScan);
                }
            }
            offset += u64::try_from(rows.len()).map_err(|e| StoreError::Invalid(e.to_string()))?;
        }
        let changed = cov.cover(from, through)?;
        if changed {
            save_coverage(tx.conn(), r.indexable, &cov).await?;
        }
        tx.commit().await?;
        Ok(if changed {
            CommitResult::Applied
        } else {
            CommitResult::AlreadyApplied
        })
    }
    /// Generation-guarded pruning state changes never add coverage.
    ///
    /// # Errors
    /// Returns storage, validation, or network identity errors.
    pub async fn set_pruned_floor(
        &self,
        guard: &GenerationGuard,
        floor: Option<BlockHeight>,
    ) -> Result<CommitResult, StoreError> {
        let mut tx = self.write().await?;
        let _ = require_bound(tx.conn()).await?;
        if generation(tx.conn(), guard.indexable).await? != guard.expected {
            return Ok(CommitResult::StaleGeneration);
        }
        let mut cov = coverage(tx.conn(), guard.indexable, 0).await?;
        cov.pruned_floor = floor.as_ref().map(height).transpose()?;
        cov.updated_at = Some(now());
        save_coverage(tx.conn(), guard.indexable, &cov).await?;
        tx.commit().await?;
        Ok(CommitResult::Applied)
    }
    /// Bump generations, drop owned rows, and clear coverage atomically.
    ///
    /// # Errors
    /// Returns storage, validation, or network identity errors.
    pub async fn reindex(
        &self,
        indexables: &[Indexable],
    ) -> Result<Vec<GenerationGuard>, StoreError> {
        let mut tx = self.write().await?;
        let _ = require_bound(tx.conn()).await?;
        let mut result = Vec::new();
        let mut unique = indexables.to_vec();
        unique.sort_unstable();
        unique.dedup();
        for i in unique {
            let next = generation(tx.conn(), i)
                .await?
                .checked_add(1)
                .ok_or_else(|| StoreError::Invalid("generation exhausted".into()))?;
            let old = coverage(tx.conn(), i, 0).await?;
            set_meta(tx.conn(), &generation_key(i), Some(&next.to_string())).await?;
            let _ = tx
                .conn()
                .execute("DELETE FROM meta WHERE key=?1", &[coverage_key(i).into()])
                .await?;
            let _ = tx
                .conn()
                .execute(
                    "DELETE FROM dashboard_unavailable WHERE domain=?1",
                    &[i.name().into()],
                )
                .await?;
            match i {
                Indexable::Winners => {
                    tx.conn()
                        .batch("DELETE FROM blocks; DELETE FROM node_summary")
                        .await?;
                }
                Indexable::Participation => {
                    tx.conn().batch("DELETE FROM qblock_participation").await?;
                }
                Indexable::Difficulty => {
                    tx.conn().batch("DELETE FROM difficulty_history WHERE source='block'; INSERT INTO difficulty_history SELECT * FROM dashboard_poll_difficulty ON CONFLICT(observed_at_block) DO NOTHING;").await?;
                }
                Indexable::Authorship => {
                    tx.conn().batch("DELETE FROM validator_authorship_blocks; DELETE FROM meta WHERE key='indexer.authorship.cutover'").await?;
                    if old.start > 0 {
                        save_coverage(tx.conn(), i, &Coverage::empty(next, old.start)).await?;
                    }
                }
            }
            let _ = tx.conn().execute("DELETE FROM dashboard_scan_winners WHERE scan_id IN (SELECT id FROM dashboard_scans WHERE domain=?1)",&[i.name().into()]).await?;
            let _ = tx
                .conn()
                .execute(
                    "DELETE FROM dashboard_scans WHERE domain=?1",
                    &[i.name().into()],
                )
                .await?;
            result.push(GenerationGuard {
                indexable: i,
                expected: next,
            });
        }
        tx.commit().await?;
        Ok(result)
    }
}

impl Store {
    /// Persist a domain's initial floor before its first finalized completion.
    ///
    /// # Errors
    /// Returns storage, validation, or network identity errors.
    pub async fn initialize_coverage(
        &self,
        indexable: Indexable,
        expected: u64,
        start: BlockHeight,
    ) -> Result<CommitResult, StoreError> {
        let mut tx = self.write().await?;
        let _ = require_bound(tx.conn()).await?;
        if generation(tx.conn(), indexable).await? != expected {
            return Ok(CommitResult::StaleGeneration);
        }
        if get_meta(tx.conn(), &coverage_key(indexable))
            .await?
            .is_some()
        {
            return Ok(CommitResult::AlreadyApplied);
        }
        save_coverage(
            tx.conn(),
            indexable,
            &Coverage::empty(expected, height(&start)?),
        )
        .await?;
        tx.commit().await?;
        Ok(CommitResult::Applied)
    }
    /// Most recent persisted enumeration for a domain generation, including exhausted scans.
    ///
    /// # Errors
    /// Returns storage, validation, or network identity errors.
    pub async fn active_scan(
        &self,
        indexable: Indexable,
        expected: u64,
    ) -> Result<Option<Scan>, StoreError> {
        let rows=self.query("SELECT * FROM dashboard_scans WHERE domain=?1 AND generation=?2 ORDER BY length(finalized_height) DESC,finalized_height DESC,id DESC LIMIT 1",&[indexable.name().into(),expected.to_string().into()]).await?;
        rows.first()
            .map(|r| {
                Ok(Scan {
                    id: ScanId(text(r, "id")?),
                    genesis: text(r, "genesis")?
                        .parse()
                        .map_err(|_| StoreError::NetworkIdentity)?,
                    at: text(r, "at_hash")?
                        .parse()
                        .map_err(|_| StoreError::IncompleteScan)?,
                    finalized_height: text(r, "finalized_height")?
                        .parse()
                        .map_err(|_| StoreError::IncompleteScan)?,
                    indexable,
                    expected_generation: expected,
                })
            })
            .transpose()
    }
    /// Keyset pagination over discovered winner heights for bounded restart replay.
    ///
    /// # Errors
    /// Returns storage, validation, or network identity errors.
    pub async fn scan_winners(
        &self,
        id: &ScanId,
        after_height: Option<BlockHeight>,
        limit: u32,
    ) -> Result<Vec<BlockHeight>, StoreError> {
        let mut args = vec![id.0.clone().into(), limit.min(1000).into()];
        let condition = if let Some(height) = after_height {
            args.push(height.to_string().into());
            format!(" AND {}", backend::decimal_gt("height", "?3"))
        } else {
            String::new()
        };
        let rows=self.query(&format!("SELECT height FROM dashboard_scan_winners WHERE scan_id=?1{condition} ORDER BY length(height),height LIMIT CAST(?2 AS INTEGER)"),&args).await?;
        rows.iter()
            .map(|r| {
                text(r, "height")?
                    .parse()
                    .map_err(|_| StoreError::IncompleteScan)
            })
            .collect()
    }
    /// Latest observed finalized target, independent of completed coverage.
    ///
    /// # Errors
    /// Returns storage, validation, or network identity errors.
    pub async fn finalized_target(&self) -> Result<Option<RetainedBlock>, StoreError> {
        self.meta("dashboard.finalized.target")
            .await?
            .map(|s| {
                let (height, hash): (String, String) = serde_json::from_str(&s)?;
                Ok(RetainedBlock {
                    height: height
                        .parse()
                        .map_err(|_| StoreError::Invalid("invalid finalized target".into()))?,
                    hash: hash
                        .parse()
                        .map_err(|_| StoreError::Invalid("invalid finalized target hash".into()))?,
                })
            })
            .transpose()
    }
    /// Monotonic target update with equal-height hash conflict detection.
    ///
    /// # Errors
    /// Returns storage, validation, or network identity errors.
    pub async fn set_finalized_target(
        &self,
        target: &RetainedBlock,
    ) -> Result<CommitResult, StoreError> {
        let mut tx = self.write().await?;
        let _ = require_bound(tx.conn()).await?;
        if let Some(s) = get_meta(tx.conn(), "dashboard.finalized.target").await? {
            let (old_height, old_hash): (String, String) = serde_json::from_str(&s)?;
            let old_height: u64 = old_height
                .parse()
                .map_err(|_| StoreError::Invalid("invalid target height".into()))?;
            let n = height(&target.height)?;
            if old_height > n {
                return Ok(CommitResult::AlreadyApplied);
            }
            if old_height == n {
                if old_hash != target.hash.to_string() {
                    return Err(StoreError::ConflictingHistory(n.to_string()));
                }
                return Ok(CommitResult::AlreadyApplied);
            }
        }
        set_meta(
            tx.conn(),
            "dashboard.finalized.target",
            Some(&serde_json::to_string(&(
                target.height.to_string(),
                target.hash.to_string(),
            ))?),
        )
        .await?;
        tx.commit().await?;
        Ok(CommitResult::Applied)
    }
}

impl Store {
    /// Record proven data absence without changing coverage or pruning floors.
    ///
    /// # Errors
    /// Returns invalid provenance, stale network identity, or storage failures.
    pub async fn mark_unavailable(
        &self,
        genesis: &BlockHash,
        block: &crate::UnavailableBlock,
    ) -> Result<CommitResult, StoreError> {
        let valid_domain = match block.reason {
            crate::UnavailableReason::MissingRetainedNonce => Indexable::Winners,
            crate::UnavailableReason::MissingRetainedDifficulty => Indexable::Difficulty,
        };
        if block.guard.indexable != valid_domain {
            return Err(StoreError::Invalid(
                "unavailable reason does not match domain".into(),
            ));
        }
        let n = height(&block.height)?;
        let mut tx = self.write().await?;
        network(tx.conn(), genesis).await?;
        if generation(tx.conn(), block.guard.indexable).await? != block.guard.expected {
            return Ok(CommitResult::StaleGeneration);
        }
        let existing = tx.conn().query(
            "SELECT hash FROM dashboard_finalized WHERE height=?1 UNION SELECT substrate_block_hash AS hash FROM blocks WHERE CAST(substrate_block_number AS TEXT)=?1",
            &[block.height.to_string().into()],
        ).await?;
        for row in existing {
            if text(&row, "hash")? != block.hash.to_string() {
                return Err(StoreError::ConflictingHistory(block.height.to_string()));
            }
        }
        if coverage(tx.conn(), block.guard.indexable, 0)
            .await?
            .contains(n, n)
        {
            return Ok(CommitResult::AlreadyApplied);
        }
        let changed = tx.conn().execute(
            "INSERT INTO dashboard_unavailable(domain,generation,height,block_hash,enrichment_hash,reason,observed_at,next_height) VALUES(?1,?2,?3,?4,?5,?6,?7,?8) ON CONFLICT(domain,generation,height) DO NOTHING",
            &[
                block.guard.indexable.name().into(), block.guard.expected.to_string().into(),
                block.height.to_string().into(), block.hash.to_string().into(),
                block.enrichment_at.to_string().into(), block.reason.name().into(), now().into(),
                n.checked_add(1).map_or(Value::Null, |next| next.to_string().into()),
            ],
        ).await?;
        let _ = tx.conn().execute(
            "INSERT INTO dashboard_finalized(height,hash) VALUES(?1,?2) ON CONFLICT(height) DO NOTHING",
            &[block.height.to_string().into(), block.hash.to_string().into()],
        ).await?;
        tx.commit().await?;
        Ok(if changed > 0 {
            CommitResult::Applied
        } else {
            CommitResult::AlreadyApplied
        })
    }

    /// Whether this domain generation has a durable absence marker at the height.
    ///
    /// # Errors
    /// Returns storage errors. Hash identity is enforced when recording the marker.
    pub async fn is_unavailable(
        &self,
        indexable: Indexable,
        expected: u64,
        height: u64,
    ) -> Result<bool, StoreError> {
        Ok(!self.query(
            "SELECT height FROM dashboard_unavailable WHERE domain=?1 AND generation=?2 AND height=?3",
            &[indexable.name().into(), expected.to_string().into(), height.to_string().into()],
        ).await?.is_empty())
    }

    /// Find the first automatically retryable interval within an uncovered gap.
    /// Results stay bounded even when many earlier heights have absence markers.
    ///
    /// # Errors
    /// Returns reversed ranges, invalid retained heights, or storage errors.
    pub async fn retryable_range(
        &self,
        indexable: Indexable,
        expected: u64,
        from: u64,
        through: u64,
    ) -> Result<Option<[u64; 2]>, StoreError> {
        if from > through {
            return Err(StoreError::Invalid("reversed retry range".into()));
        }
        let start = if self.is_unavailable(indexable, expected, from).await? {
            // Every gap after a marked prefix begins at an exact stored successor.
            // This avoids converting u64 heights through SQL signed or float types.
            let after = backend::decimal_gt("candidate.next_height", "?3");
            let beyond = backend::decimal_gt("candidate.next_height", "?4");
            let rows = self.query(&format!(
                "SELECT candidate.next_height AS height FROM dashboard_unavailable candidate WHERE candidate.domain=?1 AND candidate.generation=?2 AND candidate.next_height IS NOT NULL AND {after} AND NOT {beyond} AND NOT EXISTS (SELECT 1 FROM dashboard_unavailable blocked WHERE blocked.domain=?1 AND blocked.generation=?2 AND blocked.height=candidate.next_height) ORDER BY length(candidate.next_height),candidate.next_height LIMIT 1"
            ), &[indexable.name().into(),expected.to_string().into(),from.to_string().into(),through.to_string().into()]).await?;
            let Some(row) = rows.first() else {
                return Ok(None);
            };
            text(row, "height")?
                .parse::<u64>()
                .map_err(|_| StoreError::Invalid("invalid unavailable successor".into()))?
        } else {
            from
        };
        let after = backend::decimal_gt("height", "?3");
        let beyond = backend::decimal_gt("height", "?4");
        let rows = self.query(&format!(
            "SELECT height FROM dashboard_unavailable WHERE domain=?1 AND generation=?2 AND {after} AND NOT {beyond} ORDER BY length(height),height LIMIT 1"
        ), &[indexable.name().into(),expected.to_string().into(),start.to_string().into(),through.to_string().into()]).await?;
        let end = match rows.first() {
            Some(row) => text(row, "height")?
                .parse::<u64>()
                .map_err(|_| StoreError::Invalid("invalid unavailable height".into()))?
                .checked_sub(1)
                .ok_or_else(|| StoreError::Invalid("invalid retry boundary".into()))?,
            None => through,
        };
        Ok(Some([start, end]))
    }
}
