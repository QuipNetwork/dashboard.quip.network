// SPDX-License-Identifier: AGPL-3.0-or-later
use crate::{
    DeviceAccessTimeProbe, Store, StoreError,
    backend::{now, text},
    store::{decode, require_bound, upsert},
};
use dashboard_model::{
    BabeAuthorityRecord, BabeEpochState, ChainHead, ChainMinerRecord, IndexerObservability,
    MineableTopologyRecord,
};
use serde_json::{Map, Value, json};

impl Store {
    /// Locally identified miner account.
    ///
    /// # Errors
    /// Returns storage, validation, or network identity errors.
    pub async fn get_self_address(&self) -> Result<Option<String>, StoreError> {
        self.api_meta("self_address").await
    }
    /// Persist local miner identity.
    ///
    /// # Errors
    /// Returns storage, validation, or network identity errors.
    pub async fn set_self_address(&self, address: Option<&str>) -> Result<(), StoreError> {
        self.set_meta("self_address", address).await
    }
    /// Last validated observability projection; malformed legacy rows are unavailable.
    ///
    /// # Errors
    /// Returns storage, validation, or network identity errors.
    pub async fn get_indexer_observability(
        &self,
    ) -> Result<Option<IndexerObservability>, StoreError> {
        Ok(self
            .api_meta("indexer_observability")
            .await?
            .map(|text| {
                crate::backend::check_api_json(&text)?;
                Ok::<_, StoreError>(serde_json::from_str(&text).ok())
            })
            .transpose()?
            .flatten())
    }
    /// Persist the indexer's public observability snapshot.
    ///
    /// # Errors
    /// Returns storage, validation, or network identity errors.
    pub async fn set_indexer_observability(
        &self,
        value: &IndexerObservability,
    ) -> Result<(), StoreError> {
        self.set_meta(
            "indexer_observability",
            Some(&serde_json::to_string(value)?),
        )
        .await
    }
    /// Write the chain head's canonical singleton.
    ///
    /// # Errors
    /// Returns storage, validation, or network identity errors.
    pub async fn upsert_chain_head(&self, head: &ChainHead) -> Result<(), StoreError> {
        let Value::Object(mut object) = serde_json::to_value(head)? else {
            return Err(StoreError::Invalid("chain head object".into()));
        };
        if let Some(Value::Object(runtime)) = object.remove("runtime") {
            object.extend(runtime);
        }
        let count = object.remove("qblockCount").unwrap_or(Value::Null);
        let _ = object.insert("winningSolutionsCount".into(), count);
        let _ = object.insert("id".into(), json!(1));
        self.upsert("chain_head",&object,&["id"],&[],Some("chain_head.best_block_number IS DISTINCT FROM excluded.best_block_number OR chain_head.finalized_block_number IS DISTINCT FROM excluded.finalized_block_number OR chain_head.winning_solutions_count IS DISTINCT FROM excluded.winning_solutions_count OR chain_head.current_qblock_id IS DISTINCT FROM excluded.current_qblock_id OR chain_head.current_qblock_participants IS DISTINCT FROM excluded.current_qblock_participants OR chain_head.spec_version IS DISTINCT FROM excluded.spec_version")).await
    }
    /// Last chain head with original nested runtime shape.
    ///
    /// # Errors
    /// Returns storage, validation, or network identity errors.
    pub async fn get_chain_head(&self) -> Result<Option<ChainHead>, StoreError> {
        let rows = self
            .query_api("SELECT * FROM chain_head WHERE id=1", &[])
            .await?;
        let Some(row) = rows.into_iter().next() else {
            return Ok(None);
        };
        let mut flat: Map<String, Value> = decode(row)?;
        let mut runtime = Map::new();
        for key in [
            "specName",
            "specVersion",
            "transactionVersion",
            "implName",
            "lastRuntimeUpgrade",
        ] {
            let _ = runtime.insert(key.into(), flat.remove(key).unwrap_or(Value::Null));
        }
        let _ = flat.insert("runtime".into(), Value::Object(runtime));
        let count = flat.remove("winningSolutionsCount").unwrap_or(Value::Null);
        let _ = flat.insert("qblockCount".into(), count);
        Ok(Some(serde_json::from_value(Value::Object(flat))?))
    }
    /// Replace the current BABE epoch while retaining prior epochs.
    ///
    /// # Errors
    /// Returns storage, validation, or network identity errors.
    pub async fn upsert_babe_epoch(&self, e: &BabeEpochState) -> Result<(), StoreError> {
        let mut tx = self.write().await?;
        let _ = require_bound(tx.conn()).await?;
        let _ = tx
            .conn()
            .execute(
                "UPDATE babe_epochs SET is_current=FALSE WHERE epoch_index<>CAST(?1 AS BIGINT)",
                &[e.epoch_index.into()],
            )
            .await?;
        let Value::Object(mut v) = serde_json::to_value(e)? else {
            return Err(StoreError::Invalid("epoch object".into()));
        };
        let _ = v.insert("isCurrent".into(), json!(true));
        let _ = v.insert("updatedAt".into(), now().into());
        let _ = upsert(tx.conn(), "babe_epochs", &v, &["epoch_index"], &[], None).await?;
        tx.commit().await
    }
    /// Currently active epoch.
    ///
    /// # Errors
    /// Returns storage, validation, or network identity errors.
    pub async fn get_current_babe_epoch(&self) -> Result<Option<BabeEpochState>, StoreError> {
        self.api_one(
            "SELECT * FROM babe_epochs WHERE is_current=TRUE LIMIT 1",
            &[],
        )
        .await
    }
    /// Replace active membership within an epoch without removing history.
    ///
    /// # Errors
    /// Returns storage, validation, or network identity errors.
    pub async fn upsert_babe_authorities(
        &self,
        epoch: u64,
        authorities: &[BabeAuthorityRecord],
    ) -> Result<(), StoreError> {
        let mut tx = self.write().await?;
        let _ = require_bound(tx.conn()).await?;
        let _ = tx
            .conn()
            .execute(
                "UPDATE babe_authorities SET is_active=FALSE WHERE epoch_index=CAST(?1 AS BIGINT)",
                &[epoch.into()],
            )
            .await?;
        for a in authorities {
            let Value::Object(mut v) = serde_json::to_value(a)? else {
                return Err(StoreError::Invalid("authority object".into()));
            };
            let _ = v.insert("epochIndex".into(), epoch.into());
            let _ = v.insert("isActive".into(), true.into());
            let _ = v.insert("updatedAt".into(), now().into());
            let _ = upsert(
                tx.conn(),
                "babe_authorities",
                &v,
                &["account_id", "epoch_index"],
                &[],
                None,
            )
            .await?;
        }
        tx.commit().await
    }
    /// Active authorities from the selected current epoch only.
    ///
    /// # Errors
    /// Returns storage, validation, or network identity errors.
    pub async fn get_active_babe_authorities(
        &self,
    ) -> Result<Vec<BabeAuthorityRecord>, StoreError> {
        self.api_rows("SELECT account_id,display_name FROM babe_authorities WHERE is_active=TRUE AND epoch_index=(SELECT epoch_index FROM babe_epochs WHERE is_current=TRUE LIMIT 1) ORDER BY account_id",&[]).await
    }
    /// Upsert chain-pure miner counters. Hardware is joined by the API.
    ///
    /// # Errors
    /// Returns storage, validation, or network identity errors.
    pub async fn upsert_chain_miners(&self, miners: &[ChainMinerRecord]) -> Result<(), StoreError> {
        let mut tx = self.write().await?;
        let _ = require_bound(tx.conn()).await?;
        for m in miners {
            let Value::Object(mut v) = serde_json::to_value(m)? else {
                return Err(StoreError::Invalid("chain miner object".into()));
            };
            let _ = v.remove("hardware");
            let _ = v.remove("telemetryNodeAddress");
            let _ = v.insert("updatedAt".into(), now().into());
            let _ = upsert(tx.conn(),"chain_miners",&v,&["account_id"],&[],Some("chain_miners.deposit IS DISTINCT FROM excluded.deposit OR chain_miners.proofs_submitted IS DISTINCT FROM excluded.proofs_submitted OR chain_miners.proofs_won IS DISTINCT FROM excluded.proofs_won OR chain_miners.rewards_earned IS DISTINCT FROM excluded.rewards_earned")).await?;
        }
        tx.commit().await
    }
    /// Miners sorted by exact decimal reward value, with empty API joins.
    ///
    /// # Errors
    /// Returns storage, validation, or network identity errors.
    pub async fn get_chain_miners(&self) -> Result<Vec<ChainMinerRecord>, StoreError> {
        self.api_rows("SELECT *,NULL AS hardware,NULL AS telemetry_node_address FROM chain_miners ORDER BY length(CAST(rewards_earned AS TEXT)) DESC,rewards_earned DESC,account_id",&[]).await
    }
    /// Current mineable topology snapshot.
    ///
    /// # Errors
    /// Returns storage, validation, or network identity errors.
    pub async fn set_mineable_topologies(
        &self,
        records: &[MineableTopologyRecord],
    ) -> Result<(), StoreError> {
        self.set_meta(
            "mineable_topologies",
            Some(&serde_json::to_string(records)?),
        )
        .await
    }
    /// Missing or malformed legacy topology JSON means no known snapshot.
    ///
    /// # Errors
    /// Returns storage, validation, or network identity errors.
    pub async fn get_mineable_topologies(&self) -> Result<Vec<MineableTopologyRecord>, StoreError> {
        Ok(self
            .api_meta("mineable_topologies")
            .await?
            .map(|text| {
                crate::backend::check_api_json(&text)?;
                Ok::<_, StoreError>(serde_json::from_str(&text).ok())
            })
            .transpose()?
            .flatten()
            .unwrap_or_default())
    }
    /// Durable one-time device-access backfill decision.
    ///
    /// # Errors
    /// Returns storage, validation, or network identity errors.
    pub async fn get_device_access_time_backfill_marker(
        &self,
    ) -> Result<Option<String>, StoreError> {
        self.meta("indexer.device_access_time.backfill").await
    }
    /// Persist a supported one-time backfill marker.
    ///
    /// # Errors
    /// Returns storage, validation, or network identity errors.
    pub async fn set_device_access_time_backfill_marker(
        &self,
        value: &str,
    ) -> Result<(), StoreError> {
        if value != "triggered" && value != "not-needed" {
            return Err(StoreError::Invalid("invalid backfill marker".into()));
        }
        self.set_meta("indexer.device_access_time.backfill", Some(value))
            .await
    }
    /// Two bounded existence probes independent of table size.
    ///
    /// # Errors
    /// Returns storage, validation, or network identity errors.
    pub async fn probe_device_access_time_data(&self) -> Result<DeviceAccessTimeProbe, StoreError> {
        let has_blocks = !self
            .query("SELECT 1 AS present FROM blocks LIMIT 1", &[])
            .await?
            .is_empty();
        let has_reported = !self
            .query(
                "SELECT 1 AS present FROM blocks WHERE device_access_time_us IS NOT NULL LIMIT 1",
                &[],
            )
            .await?
            .is_empty();
        Ok(DeviceAccessTimeProbe {
            has_blocks,
            has_reported,
        })
    }
    /// Store raw runtime metadata keyed by verified genesis and exact queried state.
    ///
    /// # Errors
    /// Returns storage, validation, or network identity errors.
    pub async fn put_metadata(
        &self,
        genesis: &dashboard_model::BlockHash,
        state: &dashboard_model::BlockHash,
        spec_version: u32,
        hash: &dashboard_model::BlockHash,
        bytes: &[u8],
    ) -> Result<(), StoreError> {
        self.ensure_writable()?;
        if bytes.len() > 16 * 1024 * 1024 {
            return Err(StoreError::Invalid(
                "metadata exceeds response bound".into(),
            ));
        }
        let mut tx = self.write().await?;
        if require_bound(tx.conn()).await? != genesis.to_string() {
            return Err(StoreError::NetworkIdentity);
        }
        let _ = tx.conn().execute("INSERT INTO dashboard_metadata(genesis,state_hash,spec_version,metadata_hash,metadata) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(genesis,state_hash) DO UPDATE SET spec_version=excluded.spec_version,metadata_hash=excluded.metadata_hash,metadata=excluded.metadata",&[genesis.to_string().into(),state.to_string().into(),spec_version.to_string().into(),hash.to_string().into(),serde_json::to_string(bytes)?.into()]).await?;
        tx.commit().await
    }
    /// Retrieve metadata with its runtime and content identities.
    ///
    /// # Errors
    /// Returns storage, validation, or network identity errors.
    pub async fn get_metadata(
        &self,
        genesis: &dashboard_model::BlockHash,
        state: &dashboard_model::BlockHash,
    ) -> Result<Option<(u32, dashboard_model::BlockHash, Vec<u8>)>, StoreError> {
        let rows=self.query("SELECT spec_version,metadata_hash,metadata FROM dashboard_metadata WHERE genesis=?1 AND state_hash=?2",&[genesis.to_string().into(),state.to_string().into()]).await?;
        rows.first()
            .map(|r| {
                Ok((
                    text(r, "spec_version")?
                        .parse()
                        .map_err(|e: std::num::ParseIntError| StoreError::Invalid(e.to_string()))?,
                    text(r, "metadata_hash")?
                        .parse()
                        .map_err(|_| StoreError::Invalid("invalid cached metadata hash".into()))?,
                    serde_json::from_str(&text(r, "metadata")?)?,
                ))
            })
            .transpose()
    }
}
