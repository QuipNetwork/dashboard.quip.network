// SPDX-License-Identifier: AGPL-3.0-or-later
use crate::{
    AuthorshipRecord, Store, StoreError,
    backend::{Connection, decimal_gt, iso, text},
    store::{decode, get_meta, require_bound, set_meta, upsert},
};
use dashboard_model::{
    MinerHardwareRecord, MiningSubmissionRecord, NodeDescriptorRecord, ValidatorAuthorshipRecord,
};
use serde_json::json;
use std::collections::BTreeMap;

pub(crate) async fn write_authorship(
    c: &mut Connection,
    a: &AuthorshipRecord,
) -> Result<u64, StoreError> {
    let rows = c.query("SELECT validator,timestamp,had_winner FROM validator_authorship_blocks WHERE CAST(block_number AS TEXT)=?1", &[a.block_number.to_string().into()]).await?;
    for row in rows {
        if text(&row, "validator")? != a.account_id
            || crate::backend::canonical_timestamp(&text(&row, "timestamp")?)? != iso(a.timestamp)?
        {
            return Err(StoreError::Invalid(
                "conflicting finalized authorship".into(),
            ));
        }
    }
    upsert(c,"validator_authorship_blocks",&json!({"validator":a.account_id,"blockNumber":a.block_number,"timestamp":iso(a.timestamp)?,"hadWinner":a.had_winner}),&["validator","block_number"],&[],Some("validator_authorship_blocks.had_winner=FALSE AND excluded.had_winner=TRUE")).await
}
fn fresh_authorship_sql(postgres: bool) -> String {
    let max = if postgres {
        "MAX(block_number)"
    } else {
        "ltrim(MAX(substr('00000000000000000000',1,20-length(block_number))||block_number),'0')"
    };
    format!(
        "SELECT validator AS account_id,COUNT(*) AS blocks_authored,SUM(CASE WHEN had_winner THEN 1 ELSE 0 END) AS blocks_authored_with_pow,{max} AS last_authored_block,MAX(timestamp) AS last_authored_at,FALSE AS online FROM validator_authorship_blocks GROUP BY validator"
    )
}
async fn fresh(c: &mut Connection) -> Result<Vec<ValidatorAuthorshipRecord>, StoreError> {
    let rows = c.query(&fresh_authorship_sql(c.pg()), &[]).await?;
    rows.into_iter().map(decode).collect()
}
pub(crate) async fn recompute(c: &mut Connection) -> Result<(), StoreError> {
    for item in fresh(c).await? {
        let _ = upsert(c,"validator_authorship",&json!({"accountId":item.account_id,"blocksAuthored":item.blocks_authored,"blocksAuthoredWithPow":item.blocks_authored_with_pow,"lastAuthoredBlock":item.last_authored_block,"lastAuthoredAt":item.last_authored_at}),&["account_id"],&[],None).await?;
    }
    Ok(())
}
impl Store {
    /// Store latest descriptor by the chain's `(height, extrinsic)` order.
    ///
    /// # Errors
    /// Returns storage, validation, or network identity errors.
    pub async fn upsert_node_descriptor(&self, r: &NodeDescriptorRecord) -> Result<(), StoreError> {
        let mut tx = self.write().await?;
        let _ = require_bound(tx.conn()).await?;
        let mut value = r.clone();
        value.first_block_timestamp = r.block_timestamp;
        let cond = format!(
            "{} OR (node_descriptors.block_number=excluded.block_number AND node_descriptors.extrinsic_index<excluded.extrinsic_index)",
            decimal_gt("excluded.block_number", "node_descriptors.block_number")
        );
        let _ = upsert(
            tx.conn(),
            "node_descriptors",
            &value,
            &["account_id"],
            &["first_block_timestamp"],
            Some(&cond),
        )
        .await?;
        let _ = tx
            .conn()
            .execute(
                "UPDATE node_descriptors SET node_name=descriptor->>'nodeName' WHERE account_id=?1",
                &[r.account_id.clone().into()],
            )
            .await?;
        tx.commit().await
    }
    /// Descriptors sorted by node name with account fallback.
    ///
    /// # Errors
    /// Returns storage, validation, or network identity errors.
    pub async fn get_all_node_descriptors(&self) -> Result<Vec<NodeDescriptorRecord>, StoreError> {
        self.api_rows(
            "SELECT * FROM node_descriptors ORDER BY coalesce(node_name,account_id),account_id",
            &[],
        )
        .await
    }
    /// Resolve one descriptor by account.
    ///
    /// # Errors
    /// Returns storage, validation, or network identity errors.
    pub async fn get_node_descriptor(
        &self,
        account: &str,
    ) -> Result<Option<NodeDescriptorRecord>, StoreError> {
        self.api_one(
            "SELECT * FROM node_descriptors WHERE account_id=?1",
            &[account.into()],
        )
        .await
    }
    /// Lower first-seen time without changing descriptor provenance.
    ///
    /// # Errors
    /// Returns storage, validation, or network identity errors.
    pub async fn backfill_node_descriptor_first_seen(
        &self,
        account: &str,
        timestamp: u64,
    ) -> Result<(), StoreError> {
        let _ = self.mutate("UPDATE node_descriptors SET first_block_timestamp=CAST(?2 AS BIGINT) WHERE account_id=?1 AND first_block_timestamp>CAST(?2 AS BIGINT)",&[account.into(),timestamp.into()]).await?;
        Ok(())
    }
    /// Current descriptor scan checkpoint.
    ///
    /// # Errors
    /// Returns storage, validation, or network identity errors.
    pub async fn get_descriptor_checkpoint(&self) -> Result<Option<String>, StoreError> {
        self.meta("descriptor_checkpoint").await
    }
    /// Monotonic descriptor scan progress.
    ///
    /// # Errors
    /// Returns storage, validation, or network identity errors.
    pub async fn set_descriptor_checkpoint(&self, number: &str) -> Result<(), StoreError> {
        self.set_monotonic("descriptor_checkpoint", number).await
    }
    pub(crate) async fn set_monotonic(&self, key: &str, value: &str) -> Result<(), StoreError> {
        self.ensure_writable()?;
        let _: dashboard_model::DecimalString = value
            .parse()
            .map_err(|_| StoreError::Invalid("noncanonical checkpoint".into()))?;
        let cond = decimal_gt("excluded.value", "meta.value");
        let _ = self.mutate(&format!("INSERT INTO meta(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE meta.value IS NULL OR {cond}"),&[key.into(),value.into()]).await?;
        Ok(())
    }
    /// Persist miner hardware identity without discarding JSON fields.
    ///
    /// # Errors
    /// Returns storage, validation, or network identity errors.
    pub async fn upsert_miner_hardware(&self, r: &MinerHardwareRecord) -> Result<(), StoreError> {
        self.upsert("miner_hardware",r,&["account_id"],&[],Some("miner_hardware.node_id IS DISTINCT FROM excluded.node_id OR miner_hardware.miners IS DISTINCT FROM excluded.miners OR miner_hardware.primary_type IS DISTINCT FROM excluded.primary_type OR miner_hardware.source IS DISTINCT FROM excluded.source")).await
    }
    /// One hardware identity.
    ///
    /// # Errors
    /// Returns storage, validation, or network identity errors.
    pub async fn get_miner_hardware(
        &self,
        account: &str,
    ) -> Result<Option<MinerHardwareRecord>, StoreError> {
        self.one(
            "SELECT * FROM miner_hardware WHERE account_id=?1",
            &[account.into()],
        )
        .await
    }
    /// Hardware inventory newest first.
    ///
    /// # Errors
    /// Returns storage, validation, or network identity errors.
    pub async fn get_all_miner_hardware(&self) -> Result<Vec<MinerHardwareRecord>, StoreError> {
        self.api_rows(
            "SELECT * FROM miner_hardware ORDER BY observed_at DESC",
            &[],
        )
        .await
    }
    /// Submission updates preserve the original observation time.
    ///
    /// # Errors
    /// Returns storage, validation, or network identity errors.
    pub async fn insert_mining_submission(
        &self,
        r: &MiningSubmissionRecord,
    ) -> Result<(), StoreError> {
        self.upsert(
            "mining_submissions",
            r,
            &["miner_id", "solution_number"],
            &["observed_at"],
            None,
        )
        .await
    }
    /// Recent submissions for one local miner, bounded and numerically ordered.
    ///
    /// # Errors
    /// Returns storage, validation, or network identity errors.
    pub async fn get_recent_mining_submissions(
        &self,
        miner: &str,
        limit: u32,
    ) -> Result<Vec<MiningSubmissionRecord>, StoreError> {
        self.api_rows("SELECT * FROM mining_submissions WHERE miner_id=?1 ORDER BY length(CAST(solution_number AS TEXT)) DESC,solution_number DESC LIMIT CAST(?2 AS INTEGER)",&[miner.into(),limit.min(1000).into()]).await
    }
    /// Distinct submitted problems with nonempty attempts.
    ///
    /// # Errors
    /// Returns storage, validation, or network identity errors.
    pub async fn count_mining_submissions_with_attempts(
        &self,
        miner: &str,
    ) -> Result<u64, StoreError> {
        let rows=self.query_api("SELECT COUNT(*) AS n FROM mining_submissions WHERE miner_id=?1 AND attempt_count>0",&[miner.into()]).await?;
        rows.first()
            .map(|r| {
                text(r, "n")?
                    .parse()
                    .map_err(|e: std::num::ParseIntError| StoreError::Invalid(e.to_string()))
            })
            .transpose()
            .map(|n| n.unwrap_or(0))
    }
    /// Durable checkpoint for the miner catch-up loop.
    ///
    /// # Errors
    /// Returns storage, validation, or network identity errors.
    pub async fn get_mining_checkpoint(&self, miner: &str) -> Result<Option<u64>, StoreError> {
        self.meta(&format!("mining_checkpoint:{miner}"))
            .await?
            .map(|s| {
                s.parse()
                    .map_err(|e: std::num::ParseIntError| StoreError::Invalid(e.to_string()))
            })
            .transpose()
    }
    /// Monotonic checkpoint; never resets when the miner restarts.
    ///
    /// # Errors
    /// Returns storage, validation, or network identity errors.
    pub async fn set_mining_checkpoint(&self, miner: &str, number: u64) -> Result<(), StoreError> {
        self.set_monotonic(&format!("mining_checkpoint:{miner}"), &number.to_string())
            .await
    }
    /// Atomically persist submissions and their catch-up checkpoint.
    ///
    /// # Errors
    /// Returns storage, validation, or network identity errors.
    pub async fn commit_mining_submissions(
        &self,
        miner: &str,
        records: &[MiningSubmissionRecord],
        checkpoint: u64,
    ) -> Result<(), StoreError> {
        let mut tx = self.write().await?;
        let _ = require_bound(tx.conn()).await?;
        for r in records {
            if r.miner_id != miner || r.solution_number > checkpoint {
                return Err(StoreError::Invalid(
                    "submission does not belong to checkpoint".into(),
                ));
            }
            let _ = upsert(
                tx.conn(),
                "mining_submissions",
                r,
                &["miner_id", "solution_number"],
                &["observed_at"],
                None,
            )
            .await?;
        }
        let key = format!("mining_checkpoint:{miner}");
        let old = get_meta(tx.conn(), &key)
            .await?
            .map(|s| {
                s.parse::<u64>()
                    .map_err(|e| StoreError::Invalid(e.to_string()))
            })
            .transpose()?
            .unwrap_or(0);
        if checkpoint >= old {
            set_meta(tx.conn(), &key, Some(&checkpoint.to_string())).await?;
        }
        tx.commit().await
    }
    /// Operator-requested reset removes submissions and checkpoint together.
    ///
    /// # Errors
    /// Returns storage, validation, or network identity errors.
    pub async fn reset_mining_history(&self, miner: &str) -> Result<(), StoreError> {
        let mut tx = self.write().await?;
        let _ = require_bound(tx.conn()).await?;
        let _ = tx
            .conn()
            .execute(
                "DELETE FROM mining_submissions WHERE miner_id=?1",
                &[miner.into()],
            )
            .await?;
        let _ = tx
            .conn()
            .execute(
                "DELETE FROM meta WHERE key=?1",
                &[format!("mining_checkpoint:{miner}").into()],
            )
            .await?;
        tx.commit().await
    }
    /// Legacy counters floor fresh facts until each validator catches up.
    ///
    /// # Errors
    /// Returns storage, validation, or network identity errors.
    pub async fn get_validator_authorship(
        &self,
    ) -> Result<Vec<ValidatorAuthorshipRecord>, StoreError> {
        // Read summary floors, fresh facts, and cutover in one database snapshot.
        let sql = format!(
            "SELECT 0 AS merge_order,account_id,blocks_authored,blocks_authored_with_pow,last_authored_block,last_authored_at,FALSE AS online FROM validator_authorship UNION ALL SELECT 1 AS merge_order,facts.* FROM ({}) facts WHERE NOT EXISTS(SELECT 1 FROM meta WHERE key='indexer.authorship.cutover' AND value='1') ORDER BY merge_order",
            fresh_authorship_sql(self.pg())
        );
        let rows = self.query_api(&sql, &[]).await?;
        let mut merged: BTreeMap<String, ValidatorAuthorshipRecord> = BTreeMap::new();
        for mut row in rows {
            let _ = row.remove("merge_order");
            let mut r: ValidatorAuthorshipRecord = decode(row)?;
            if let Some(old) = merged.get(&r.account_id) {
                r.blocks_authored = r.blocks_authored.max(old.blocks_authored);
                r.blocks_authored_with_pow =
                    r.blocks_authored_with_pow.max(old.blocks_authored_with_pow);
                let number = r
                    .last_authored_block
                    .as_ref()
                    .map(dashboard_model::DecimalString::to_u64)
                    .transpose()
                    .map_err(|e| StoreError::Invalid(e.to_string()))?
                    .unwrap_or(0);
                let old_number = old
                    .last_authored_block
                    .as_ref()
                    .map(dashboard_model::DecimalString::to_u64)
                    .transpose()
                    .map_err(|e| StoreError::Invalid(e.to_string()))?
                    .unwrap_or(0);
                if old_number > number {
                    r.last_authored_block.clone_from(&old.last_authored_block);
                    r.last_authored_at.clone_from(&old.last_authored_at);
                }
            }
            let _ = merged.insert(r.account_id.clone(), r);
        }
        let mut rows: Vec<_> = merged.into_values().collect();
        rows.sort_by(|a, b| {
            b.blocks_authored
                .cmp(&a.blocks_authored)
                .then(a.account_id.cmp(&b.account_id))
        });
        Ok(rows)
    }
    /// Count authorship facts in an inclusive height interval.
    ///
    /// # Errors
    /// Returns storage, validation, or network identity errors.
    pub async fn count_authorship_blocks_in_range(
        &self,
        from: &str,
        through: &str,
    ) -> Result<u64, StoreError> {
        let low = decimal_gt("?1", "block_number");
        let high = decimal_gt("block_number", "?2");
        let rows=self.query(&format!("SELECT COUNT(*) AS n FROM validator_authorship_blocks WHERE NOT {low} AND NOT {high}"),&[from.into(),through.into()]).await?;
        rows.first()
            .map(|r| {
                text(r, "n")?
                    .parse()
                    .map_err(|e: std::num::ParseIntError| StoreError::Invalid(e.to_string()))
            })
            .transpose()
            .map(|n| n.unwrap_or(0))
    }
    /// Whether authored history has replaced the legacy aggregate floor.
    ///
    /// # Errors
    /// Returns storage, validation, or network identity errors.
    pub async fn is_authorship_cutover(&self) -> Result<bool, StoreError> {
        Ok(self.meta("indexer.authorship.cutover").await?.as_deref() == Some("1"))
    }
    /// Recompute aggregate totals from facts in the serialized transaction.
    ///
    /// # Errors
    /// Returns storage, validation, or network identity errors.
    pub async fn recompute_authorship_summary(&self) -> Result<(), StoreError> {
        let mut tx = self.write().await?;
        let _ = require_bound(tx.conn()).await?;
        recompute(tx.conn()).await?;
        tx.commit().await
    }
    /// Cut over only when every legacy validator's count is represented by facts.
    ///
    /// # Errors
    /// Returns storage, validation, or network identity errors.
    pub async fn try_authorship_cutover(&self) -> Result<bool, StoreError> {
        let mut tx = self.write().await?;
        let _ = require_bound(tx.conn()).await?;
        if get_meta(tx.conn(), "indexer.authorship.cutover")
            .await?
            .as_deref()
            == Some("1")
        {
            tx.commit().await?;
            return Ok(true);
        }
        let fresh = fresh(tx.conn()).await?;
        let old = tx
            .conn()
            .query(
                "SELECT account_id,blocks_authored FROM validator_authorship",
                &[],
            )
            .await?;
        for row in old {
            let account = text(&row, "account_id")?;
            let count: u64 = text(&row, "blocks_authored")?
                .parse()
                .map_err(|e: std::num::ParseIntError| StoreError::Invalid(e.to_string()))?;
            if fresh
                .iter()
                .find(|r| r.account_id == account)
                .map_or(0, |r| r.blocks_authored)
                < count
            {
                return Ok(false);
            }
        }
        recompute(tx.conn()).await?;
        set_meta(tx.conn(), "indexer.authorship.cutover", Some("1")).await?;
        tx.commit().await?;
        Ok(true)
    }
}
