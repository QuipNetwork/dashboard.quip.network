use super::{
    BabeDigest, BlockHash, ChainError, ChainReader, DifficultyInfo, Header, WorkClass,
    decode::{self, field, sequence},
    invalid, make_room,
    metadata::decode_value,
    unhex,
};
use scale_value::Value;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{collections::BTreeMap, sync::Arc};
use subxt_core::dynamic;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
/// Snapshot-bound continuation for a hashed storage map.
pub struct WinnerCursor {
    /// Finalized snapshot hash that pins every read in this operation.
    pub at: BlockHash,
    /// Raw SCALE storage key for exclusive continuation.
    pub key: Vec<u8>,
}
#[derive(Clone, Debug)]
/// Bounded winner enumeration page with explicit exhaustion.
pub struct WinnerPage {
    /// Finalized snapshot hash that pins every read in this operation.
    pub at: BlockHash,
    /// Storage keys in hash order, not numeric height order.
    pub keys: Vec<Vec<u8>>,
    /// Heights decoded from map keys, without implying range completion.
    pub heights: Vec<u64>,
    /// Exclusive cursor for the same snapshot, absent after exhaustion.
    pub continuation: Option<WinnerCursor>,
    /// True only when the server returned fewer rows than requested.
    pub exhausted: bool,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
/// Participation continuation bound to a snapshot and qblock.
pub struct ParticipantCursor {
    /// Finalized snapshot hash that pins every read in this operation.
    pub at: BlockHash,
    /// Monotonic winning solution identifier, distinct from substrate height.
    pub qblock_id: u64,
    /// Raw account identifier for targeted storage reads.
    pub account: Vec<u8>,
}
#[derive(Clone, Debug)]
/// One participation declaration with original chain provenance.
pub struct QBlockParticipant {
    /// Raw account identifier for targeted storage reads.
    pub account: String,
    /// Miner category or runtime miner-kind variant.
    pub kind: String,
    /// Optional declared participation budget in seconds.
    pub budget_seconds: Option<u32>,
    /// Substrate height as an exact integer.
    pub block_number: u64,
}
#[derive(Clone, Debug)]
/// Bounded participation results and continuation.
pub struct ParticipantPage {
    /// Finalized snapshot hash that pins every read in this operation.
    pub at: BlockHash,
    /// Decoded participation rows from this page.
    pub participants: Vec<QBlockParticipant>,
    /// Exclusive cursor for the same snapshot, absent after exhaustion.
    pub continuation: Option<ParticipantCursor>,
    /// True only when the server returned fewer rows than requested.
    pub exhausted: bool,
}
#[derive(Clone, Debug)]
/// BABE epoch and ordered session account snapshot.
pub struct BabeEpochInfo {
    /// Epoch index returned by BABE.
    pub epoch_index: u64,
    /// Observed slot at the selected block state.
    pub current_slot: u64,
    /// Actual epoch start returned by BABE, including skipped epochs.
    pub epoch_start_slot: u64,
    /// Configured epoch duration in slots.
    pub slots_per_epoch: u64,
    /// Session validator account identifiers in authority order.
    pub authorities: Vec<String>,
}
#[derive(Clone, Debug)]
/// Bounded miner registry records and continuation.
pub struct MinerPage {
    /// Finalized snapshot hash that pins every read in this operation.
    pub at: BlockHash,
    /// Decoded miner registry records.
    pub miners: Vec<ChainMinerInfo>,
    /// Exclusive cursor for the same snapshot, absent after exhaustion.
    pub continuation: Option<WinnerCursor>,
    /// True only when the server returned fewer rows than requested.
    pub exhausted: bool,
}
#[derive(Clone, Debug)]
/// Current on-chain miner counters with exact balances.
pub struct ChainMinerInfo {
    /// SS58 account identifier used by dashboard records.
    pub account_id: String,
    /// Reserved deposit as an exact decimal string.
    pub deposit: String,
    /// Exact lifetime submitted proof count.
    pub proofs_submitted: u64,
    /// Exact lifetime winning proof count.
    pub proofs_won: u64,
    /// Exact lifetime rewards as a decimal string.
    pub rewards_earned: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
/// Persistable topology scalar projection without graph vectors.
pub struct TopologySummary {
    /// Identity of the topology associated with this record.
    pub topology_hash: BlockHash,
    /// Number of topology nodes without retaining their values.
    pub node_count: u32,
    /// Number of topology edges without retaining their values.
    pub edge_count: u32,
    /// Optional scalar energy-curve constant.
    pub curve_constant: Option<f64>,
}
#[derive(Clone, Debug)]
/// Static topology scalars with dynamic per-head difficulty.
pub struct MineableTopologyInfo {
    /// Cached static topology scalars.
    pub topology: TopologySummary,
    /// Whether this topology is the default at the selected state.
    pub is_default: bool,
    /// Difficulty gates at the queried state or winning proof.
    pub difficulty: Option<DifficultyInfo>,
}
#[derive(Clone, Debug)]
/// Normalized descriptor with original update provenance.
pub struct DescriptorEntry {
    /// Raw account identifier for targeted reads and first-seen reconstruction.
    pub account: [u8; 32],
    /// SS58 account identifier used by dashboard records.
    pub account_id: String,
    /// Descriptor update height from chain storage.
    pub updated_at: u64,
    /// Hash of the descriptor update block.
    pub block_hash: BlockHash,
    /// Unix timestamp in seconds.
    pub timestamp: u64,
    /// Existing dashboard descriptor JSON projection.
    pub descriptor: serde_json::Value,
    /// Decoded metadata fields, retained for consumers needing typed chain data.
    pub fields: Value<u32>,
}

fn page_limit(limit: u32) -> Result<(), ChainError> {
    if limit == 0 || limit > 1000 {
        Err(ChainError::Invalid(
            "page limit must be 1 through 1000".into(),
        ))
    } else {
        Ok(())
    }
}
impl ChainReader {
    /// Enumerates a bounded page of hashed `QBlock` keys at one snapshot.
    ///
    /// # Errors
    /// Returns typed RPC, pruning, capability, or malformed-data errors.
    pub async fn winner_page(
        &self,
        at: BlockHash,
        cursor: Option<WinnerCursor>,
        limit: u32,
    ) -> Result<WinnerPage, ChainError> {
        page_limit(limit)?;
        if cursor.as_ref().is_some_and(|c| c.at != at) {
            return Err(ChainError::Invalid(
                "winner cursor belongs to another snapshot".into(),
            ));
        }
        let start = cursor.map(|c| c.key);
        let keys = self
            .key_page(
                at,
                "QuantumPow",
                "QBlocks",
                start.as_deref(),
                limit,
                WorkClass::Backfill,
            )
            .await?;
        let context = self.runtime_context(at, WorkClass::Backfill).await?;
        let (_, entry) = subxt_core::storage::lookup_storage_entry_details(
            "QuantumPow",
            "QBlocks",
            &context.metadata,
        )?;
        let subxt_metadata::StorageEntryType::Map {
            key_ty, hashers, ..
        } = entry.entry_type()
        else {
            return Err(ChainError::Unsupported("QBlocks is not a map".into()));
        };
        if !blake_concat(hashers) {
            return Err(ChainError::Unsupported(
                "QBlocks requires Blake2_128Concat keys".into(),
            ));
        }
        let mut heights = Vec::with_capacity(keys.len());
        for key in &keys {
            let suffix = key
                .get(48..)
                .ok_or_else(|| ChainError::Invalid("short QBlocks key".into()))?;
            let value = decode_value(suffix, *key_ty, &context.metadata)?;
            // Re-encode to validate the hash prefix instead of trusting unverified suffix bytes.
            let expected = subxt_core::storage::get_address_bytes(
                &dynamic::storage(
                    "QuantumPow",
                    "QBlocks",
                    vec![value.clone().remove_context()],
                ),
                &context.metadata,
            )?;
            if expected != *key {
                return Err(ChainError::Invalid("QBlocks key hash mismatch".into()));
            }
            heights.push(decode::unsigned(&value)?);
        }
        let exhausted = keys.len() < limit as usize;
        let continuation = if exhausted {
            None
        } else {
            keys.last().cloned().map(|key| WinnerCursor { at, key })
        };
        // These heights are hash-key ordered. They do not prove any numeric height interval complete.
        Ok(WinnerPage {
            at,
            keys,
            heights,
            continuation,
            exhausted,
        })
    }
    async fn key_page(
        &self,
        at: BlockHash,
        pallet: &str,
        entry: &str,
        start: Option<&[u8]>,
        limit: u32,
        class: WorkClass,
    ) -> Result<Vec<Vec<u8>>, ChainError> {
        let context = self.runtime_context(at, class).await?;
        let _ = subxt_core::storage::lookup_storage_entry_details(pallet, entry, &context.metadata)
            .map_err(|_| ChainError::Unsupported(format!("{pallet}.{entry}")))?;
        let prefix = subxt_core::storage::get_address_root_bytes(&dynamic::storage(
            pallet,
            entry,
            Vec::<Value>::new(),
        ));
        if start.is_some_and(|k| !k.starts_with(&prefix)) {
            return Err(ChainError::Invalid(
                "cursor has incorrect storage prefix".into(),
            ));
        }
        let response = self
            .transport
            .shared(
                "state_getKeysPaged",
                json!([
                    format!("0x{}", hex::encode(&prefix)),
                    limit,
                    start.map(|k| format!("0x{}", hex::encode(k))),
                    at
                ]),
                class,
            )
            .await?;
        let values = response
            .as_array()
            .ok_or_else(|| ChainError::Invalid("key page is not an array".into()))?;
        if values.len() > limit as usize {
            return Err(ChainError::Invalid(
                "RPC exceeded requested key limit".into(),
            ));
        }
        let mut keys = Vec::with_capacity(values.len());
        let mut previous = start;
        for value in values {
            let key = unhex(
                value
                    .as_str()
                    .ok_or_else(|| ChainError::Invalid("storage key is not hex".into()))?,
            )?;
            if !key.starts_with(&prefix) || previous.is_some_and(|p| key.as_slice() <= p) {
                return Err(ChainError::Invalid(
                    "storage page is unordered or failed to advance".into(),
                ));
            }
            keys.push(key);
            previous = keys.last().map(Vec::as_slice);
        }
        Ok(keys)
    }
    /// Reads the narrow participation count for a qblock.
    ///
    /// # Errors
    /// Returns typed RPC, pruning, capability, or malformed-data errors.
    pub async fn participant_count(
        &self,
        at: BlockHash,
        qblock_id: u64,
        class: WorkClass,
    ) -> Result<u32, ChainError> {
        let value = self
            .runtime_call(
                at,
                "MinerRegistryApi",
                "participant_count_by_qblock",
                vec![Value::u128(u128::from(qblock_id))],
                class,
            )
            .await?;
        u32::try_from(decode::unsigned(&value)?).map_err(invalid)
    }
    /// Reads a bounded, ordered participation page at a pinned snapshot.
    ///
    /// # Errors
    /// Returns typed RPC, pruning, capability, or malformed-data errors.
    pub async fn participant_page(
        &self,
        at: BlockHash,
        qblock_id: u64,
        cursor: Option<ParticipantCursor>,
        limit: u32,
        class: WorkClass,
    ) -> Result<ParticipantPage, ChainError> {
        page_limit(limit)?;
        if cursor
            .as_ref()
            .is_some_and(|c| c.at != at || c.qblock_id != qblock_id || c.account.len() != 32)
        {
            return Err(ChainError::Invalid(
                "participant cursor belongs to another snapshot or qblock".into(),
            ));
        }
        let start = cursor.as_ref().map_or_else(
            || Value::unnamed_variant("None", Vec::<Value>::new()),
            |c| Value::unnamed_variant("Some", [Value::from_bytes(&c.account)]),
        );
        let value = self
            .runtime_call(
                at,
                "MinerRegistryApi",
                "participants_by_qblock",
                vec![
                    Value::u128(u128::from(qblock_id)),
                    start,
                    Value::u128(u128::from(limit)),
                ],
                class,
            )
            .await?;
        let rows = sequence(&value)?;
        if rows.len() > limit as usize {
            return Err(ChainError::Invalid(
                "participant page exceeded limit".into(),
            ));
        }
        let exhausted = rows.len() < limit as usize;
        let mut previous = cursor.map(|c| c.account);
        let mut participants = Vec::with_capacity(rows.len());
        for row in rows {
            let pair = sequence(row)?;
            let [account_value, record] = pair.as_slice() else {
                return Err(ChainError::Invalid("participant row is not a pair".into()));
            };
            let account = decode::bytes(account_value)?;
            if previous.as_ref().is_some_and(|p| account <= *p) {
                return Err(ChainError::Invalid(
                    "participant page did not advance".into(),
                ));
            }
            if decode::unsigned(field(record, "qblock_id")?)? != qblock_id {
                return Err(ChainError::Invalid("participant qblock mismatch".into()));
            }
            let kind = field(record, "kind")?;
            let scale_value::ValueDef::Variant(kind) = &kind.value else {
                return Err(ChainError::Invalid("miner kind is not an enum".into()));
            };
            let budget = decode::option(field(record, "budget_seconds")?)?
                .map(|v| u32::try_from(decode::unsigned(v)?).map_err(invalid))
                .transpose()?;
            participants.push(QBlockParticipant {
                account: decode::account_bytes(&account)?,
                kind: kind.name.clone(),
                budget_seconds: budget,
                block_number: decode::unsigned(field(record, "updated_at")?)?,
            });
            previous = Some(account);
        }
        let continuation = if exhausted {
            None
        } else {
            previous.map(|account| ParticipantCursor {
                at,
                qblock_id,
                account,
            })
        };
        Ok(ParticipantPage {
            at,
            participants,
            continuation,
            exhausted,
        })
    }
    /// Reads the dynamic difficulty gates at the required head.
    ///
    /// # Errors
    /// Returns typed RPC, pruning, capability, or malformed-data errors.
    pub async fn difficulty(
        &self,
        at: BlockHash,
        class: WorkClass,
    ) -> Result<DifficultyInfo, ChainError> {
        decode::difficulty(
            &self
                .runtime_call(at, "QuantumPowApi", "current_difficulty", vec![], class)
                .await?,
        )
    }
    /// Reads the optional default topology identity at a selected state.
    ///
    /// # Errors
    /// Returns typed RPC, pruning, capability, or malformed-data errors.
    pub async fn default_topology(
        &self,
        at: BlockHash,
        class: WorkClass,
    ) -> Result<Option<BlockHash>, ChainError> {
        self.optional_storage(at, "QuantumPow", "DefaultTopology", vec![], class)
            .await?
            .as_ref()
            .map(decode::hash)
            .transpose()
    }
    /// Reads session account identifiers in BABE authority order.
    ///
    /// # Errors
    /// Returns typed RPC, pruning, capability, or malformed-data errors.
    pub async fn authorities(
        &self,
        at: BlockHash,
        class: WorkClass,
    ) -> Result<Vec<String>, ChainError> {
        let value = self
            .storage(at, "Session", "Validators", vec![], class)
            .await?;
        sequence(&value)?.into_iter().map(decode::account).collect()
    }
    pub(super) async fn author(
        &self,
        at: BlockHash,
        header: &Header,
        class: WorkClass,
    ) -> Result<Option<String>, ChainError> {
        let Some(digest) = BabeDigest::from_logs(&header.digest.logs)? else {
            return Ok(None);
        };
        // Session rotates during on_initialize, so B's post-state validators contain
        // B's author set, including first blocks after skipped BABE epochs.
        let authorities = self.authorities(at, class).await?;
        authorities
            .get(digest.authority_index as usize)
            .cloned()
            .map(Some)
            .ok_or_else(|| ChainError::Invalid("BABE authority index is out of range".into()))
    }
    /// Reads the actual BABE epoch start and current slot.
    ///
    /// # Errors
    /// Returns typed RPC, pruning, capability, or malformed-data errors.
    pub async fn babe_epoch(
        &self,
        at: BlockHash,
        class: WorkClass,
    ) -> Result<BabeEpochInfo, ChainError> {
        let epoch = self
            .runtime_call(at, "BabeApi", "current_epoch", vec![], class)
            .await?;
        let current_slot = decode::unsigned(
            &self
                .storage(at, "Babe", "CurrentSlot", vec![], class)
                .await?,
        )?;
        Ok(BabeEpochInfo {
            epoch_index: decode::unsigned(field(&epoch, "epoch_index")?)?,
            current_slot,
            epoch_start_slot: decode::unsigned(field(&epoch, "start_slot")?)?,
            slots_per_epoch: decode::unsigned(field(&epoch, "duration")?)?,
            authorities: self.authorities(at, class).await?,
        })
    }
    /// Restores validated scalar topology records for this chain.
    ///
    /// # Errors
    /// Returns typed RPC, pruning, capability, or malformed-data errors.
    pub async fn import_topologies(
        &self,
        genesis: BlockHash,
        values: Vec<TopologySummary>,
    ) -> Result<(), ChainError> {
        if genesis != self.genesis {
            return Err(ChainError::GenesisMismatch {
                expected: self.genesis,
                actual: genesis,
            });
        }
        let mut cache = self.topologies.lock().await;
        for value in values {
            if value
                .curve_constant
                .is_some_and(|k| !k.is_finite() || k < 0.0)
            {
                return Err(ChainError::Invalid("invalid cached curve constant".into()));
            }
            let key = (genesis, value.topology_hash);
            if !cache.contains_key(&key) {
                make_room(&mut cache, 128, |c| c.get().is_some())?;
            }
            let _ = cache.insert(key, Arc::new(tokio::sync::OnceCell::new_with(Some(value))));
        }
        Ok(())
    }
    /// Returns completed topology scalars for persistence.
    pub async fn topology_records(&self) -> Vec<TopologySummary> {
        self.topologies
            .lock()
            .await
            .values()
            .filter_map(|c| c.get().cloned())
            .collect()
    }
    /// Counts topology vectors once per identity without retaining graph values.
    ///
    /// # Errors
    /// Returns typed RPC, pruning, capability, or malformed-data errors.
    pub async fn topology_summary(
        &self,
        at: BlockHash,
        hash: BlockHash,
        class: WorkClass,
    ) -> Result<TopologySummary, ChainError> {
        let key = (self.genesis, hash);
        let cell = {
            let mut cache = self.topologies.lock().await;
            if !cache.contains_key(&key) {
                make_room(&mut cache, 128, |c| Arc::strong_count(c) == 1)?;
            }
            cache.entry(key).or_default().clone()
        };
        cell.get_or_try_init(|| async {
            let (bytes, ty, metadata) = self
                .runtime_bytes(
                    at,
                    "QuantumPowApi",
                    "topology_meta",
                    vec![Value::from_bytes(hash.0)],
                    class,
                )
                .await?;
            let (nodes, edges, h, j) = topology_scalars(&bytes, ty, &metadata)?;
            let node_count = nodes;
            let edge_count = edges;
            let degree = if nodes > 0 {
                2.0 * f64::from(edge_count) / f64::from(node_count)
            } else {
                0.0
            };
            let curve_constant = if degree > 0.0 {
                h.zip(j).map(|(h, j)| {
                    j * degree.sqrt() * f64::from(node_count)
                        + 0.88 * h * f64::from(node_count) / degree.sqrt()
                })
            } else {
                None
            };
            Ok(TopologySummary {
                topology_hash: hash,
                node_count,
                edge_count,
                curve_constant: curve_constant.filter(|k| *k > 0.0),
            })
        })
        .await
        .cloned()
    }
    /// Combines cached topology scalars with fresh per-head difficulty.
    ///
    /// # Errors
    /// Returns typed RPC, pruning, capability, or malformed-data errors.
    pub async fn mineable_topologies(
        &self,
        at: BlockHash,
        class: WorkClass,
    ) -> Result<Vec<MineableTopologyInfo>, ChainError> {
        let raw = self
            .runtime_call(at, "QuantumPowApi", "mineable_topologies", vec![], class)
            .await?;
        let hashes = sequence(&raw)?;
        if hashes.len() > 128 {
            return Err(ChainError::Oversized(
                "mineable topology count exceeds 128".into(),
            ));
        }
        let default = self.default_topology(at, class).await?;
        let mut result = Vec::with_capacity(hashes.len());
        for value in hashes {
            let hash = decode::hash(value)?;
            let raw = self
                .runtime_call(
                    at,
                    "QuantumPowApi",
                    "difficulty_for",
                    vec![Value::from_bytes(hash.0)],
                    class,
                )
                .await?;
            let difficulty = decode::option(&raw)?.map(decode::difficulty).transpose()?;
            result.push(MineableTopologyInfo {
                topology: self.topology_summary(at, hash, class).await?,
                is_default: default == Some(hash),
                difficulty,
            });
        }
        Ok(result)
    }
    async fn map_page(
        &self,
        at: BlockHash,
        pallet: &str,
        entry: &str,
        cursor: Option<&[u8]>,
        limit: u32,
        class: WorkClass,
    ) -> Result<Vec<(Vec<u8>, Value<u32>)>, ChainError> {
        let context = self.runtime_context(at, class).await?;
        let keys = self
            .key_page(at, pallet, entry, cursor, limit, class)
            .await?;
        let (_, definition) =
            subxt_core::storage::lookup_storage_entry_details(pallet, entry, &context.metadata)?;
        let subxt_metadata::StorageEntryType::Map {
            value_ty, hashers, ..
        } = definition.entry_type()
        else {
            return Err(ChainError::Unsupported(format!(
                "{pallet}.{entry} is not a map"
            )));
        };
        if !blake_concat(hashers) {
            return Err(ChainError::Unsupported(
                "registry map requires Blake2_128Concat".into(),
            ));
        }
        let mut rows = Vec::with_capacity(keys.len());
        for key in keys {
            if key.len() != 80 {
                return Err(ChainError::Unsupported(
                    "registry map key is not an AccountId32".into(),
                ));
            }
            let expected = subxt_core::storage::get_address_bytes(
                &dynamic::storage(
                    pallet,
                    entry,
                    vec![Value::from_bytes(key.get(48..).ok_or_else(|| {
                        ChainError::Invalid("short registry key".into())
                    })?)],
                ),
                &context.metadata,
            )?;
            if expected != key {
                return Err(ChainError::Invalid("registry map key hash mismatch".into()));
            }
            let raw = self
                .transport
                .shared(
                    "state_getStorage",
                    json!([format!("0x{}", hex::encode(&key)), at]),
                    class,
                )
                .await?;
            let bytes =
                unhex(raw.as_str().ok_or_else(|| {
                    ChainError::Invalid("enumerated map value disappeared".into())
                })?)?;
            rows.push((key, decode_value(&bytes, *value_ty, &context.metadata)?));
        }
        Ok(rows)
    }
    /// Reads a bounded, snapshot-bound miner registry page.
    ///
    /// # Errors
    /// Returns typed RPC, pruning, capability, or malformed-data errors.
    pub async fn miner_page(
        &self,
        at: BlockHash,
        cursor: Option<WinnerCursor>,
        limit: u32,
        class: WorkClass,
    ) -> Result<MinerPage, ChainError> {
        page_limit(limit)?;
        if cursor.as_ref().is_some_and(|c| c.at != at) {
            return Err(ChainError::Invalid(
                "miner cursor belongs to another snapshot".into(),
            ));
        }
        let rows = self
            .map_page(
                at,
                "QuantumPow",
                "Miners",
                cursor.as_ref().map(|c| c.key.as_slice()),
                limit,
                class,
            )
            .await?;
        let exhausted = rows.len() < limit as usize;
        let continuation = if exhausted {
            None
        } else {
            rows.last().map(|(key, _)| WinnerCursor {
                at,
                key: key.clone(),
            })
        };
        let miners = rows
            .into_iter()
            .map(|(key, value)| {
                miner_info(
                    key.get(48..)
                        .ok_or_else(|| ChainError::Invalid("short registry key".into()))?,
                    &value,
                )
            })
            .collect::<Result<_, _>>()?;
        Ok(MinerPage {
            at,
            miners,
            continuation,
            exhausted,
        })
    }
    /// Reads one miner account at a selected snapshot.
    ///
    /// # Errors
    /// Returns typed RPC, pruning, capability, or malformed-data errors.
    pub async fn miner_at(
        &self,
        at: BlockHash,
        account: [u8; 32],
        class: WorkClass,
    ) -> Result<Option<ChainMinerInfo>, ChainError> {
        self.optional_storage(
            at,
            "QuantumPow",
            "Miners",
            vec![Value::from_bytes(account)],
            class,
        )
        .await?
        .as_ref()
        .map(|v| miner_info(&account, v))
        .transpose()
    }
    /// Tests descriptor presence without fetching update-block provenance.
    ///
    /// # Errors
    /// Returns typed RPC, pruning, capability, or malformed-data errors.
    pub async fn descriptor_present(
        &self,
        at: BlockHash,
        account: [u8; 32],
        class: WorkClass,
    ) -> Result<bool, ChainError> {
        Ok(self
            .optional_storage(
                at,
                "MinerRegistry",
                "NodeDescriptors",
                vec![Value::from_bytes(account)],
                class,
            )
            .await?
            .is_some())
    }
    /// Reads one descriptor with its original update provenance.
    ///
    /// # Errors
    /// Returns typed RPC, pruning, capability, or malformed-data errors.
    pub async fn descriptor_at(
        &self,
        at: BlockHash,
        account: [u8; 32],
        class: WorkClass,
    ) -> Result<Option<DescriptorEntry>, ChainError> {
        let Some(value) = self
            .optional_storage(
                at,
                "MinerRegistry",
                "NodeDescriptors",
                vec![Value::from_bytes(account)],
                class,
            )
            .await?
        else {
            return Ok(None);
        };
        let updated_at = decode::unsigned(field(&value, "updated_at")?)?;
        let block_hash = self
            .block_hash(updated_at, class)
            .await?
            .ok_or_else(|| ChainError::Invalid("descriptor update block missing".into()))?;
        Ok(Some(DescriptorEntry {
            account,
            account_id: decode::account_bytes(&account)?,
            updated_at,
            block_hash,
            timestamp: self.timestamp(block_hash, class).await?,
            descriptor: descriptor_json(&value)?,
            fields: value,
        }))
    }
    /// Reads one descriptor page and its original update provenance.
    ///
    /// # Errors
    /// Returns typed RPC, pruning, capability, or malformed-data errors.
    pub async fn descriptor_page(
        &self,
        at: BlockHash,
        cursor: Option<WinnerCursor>,
        class: WorkClass,
    ) -> Result<(Vec<DescriptorEntry>, Option<WinnerCursor>), ChainError> {
        if cursor.as_ref().is_some_and(|c| c.at != at) {
            return Err(ChainError::Invalid(
                "descriptor cursor belongs to another snapshot".into(),
            ));
        }
        let rows = self
            .map_page(
                at,
                "MinerRegistry",
                "NodeDescriptors",
                cursor.as_ref().map(|c| c.key.as_slice()),
                1000,
                class,
            )
            .await?;
        let continuation = if rows.len() < 1000 {
            None
        } else {
            rows.last().map(|(key, _)| WinnerCursor {
                at,
                key: key.clone(),
            })
        };
        let mut result = Vec::with_capacity(rows.len());
        let mut provenance = BTreeMap::new();
        for (key, value) in rows {
            let value = &value;
            let updated_at = decode::unsigned(field(value, "updated_at")?)?;
            let (block_hash, timestamp) = if let Some(cached) = provenance.get(&updated_at) {
                *cached
            } else {
                let block_hash = self
                    .block_hash(updated_at, class)
                    .await?
                    .ok_or_else(|| ChainError::Invalid("descriptor update block missing".into()))?;
                let timestamp = self.timestamp(block_hash, class).await?;
                let _ = provenance.insert(updated_at, (block_hash, timestamp));
                (block_hash, timestamp)
            };
            result.push(DescriptorEntry {
                account: key
                    .get(48..)
                    .ok_or_else(|| ChainError::Invalid("short descriptor key".into()))?
                    .try_into()
                    .map_err(invalid)?,
                account_id: decode::account_bytes(
                    key.get(48..)
                        .ok_or_else(|| ChainError::Invalid("short registry key".into()))?,
                )?,
                updated_at,
                block_hash,
                timestamp,
                descriptor: descriptor_json(value)?,
                fields: value.clone(),
            });
        }
        Ok((result, continuation))
    }
}
fn mean_abs(value: &Value<u32>) -> Result<Option<f64>, ChainError> {
    let scale_value::ValueDef::Variant(variant) = &decode::unwrap(value).value else {
        return Err(ChainError::Invalid(
            "allowed value spec is not an enum".into(),
        ));
    };
    let values = variant.values.values().collect::<Vec<_>>();
    if variant.name == "Set" {
        let Some(value) = values.first() else {
            return Err(ChainError::Invalid("empty Set payload".into()));
        };
        let values = sequence(value)?;
        if values.is_empty() {
            return Ok(None);
        }
        let mut sum = 0.0;
        for value in &values {
            sum +=
                f64::from(i32::try_from(decode::signed(value)?).map_err(invalid)?).abs() / 1000.0;
        }
        return Ok(Some(
            sum / f64::from(u32::try_from(values.len()).map_err(invalid)?),
        ));
    }
    let composite = Value {
        value: scale_value::ValueDef::Composite(variant.values.clone()),
        context: 0,
    };
    let min =
        f64::from(i32::try_from(decode::signed(field(&composite, "min")?)?).map_err(invalid)?);
    let max =
        f64::from(i32::try_from(decode::signed(field(&composite, "max")?)?).map_err(invalid)?);
    if max < min {
        return Err(ChainError::Invalid(
            "allowed value range is reversed".into(),
        ));
    }
    if variant.name == "ContinuousRange" || variant.name == "IntegerRange" {
        let tri = |n: f64| if n <= 0.0 { 0.0 } else { n * (n + 1.0) / 2.0 };
        let sum = if min >= 0.0 {
            tri(max) - tri(min - 1.0)
        } else if max <= 0.0 {
            tri(-min) - tri(-max - 1.0)
        } else {
            tri(-min) + tri(max)
        };
        let mean = sum / (max - min + 1.0);
        return Ok(Some(if variant.name == "ContinuousRange" {
            mean / 1000.0
        } else {
            mean
        }));
    }
    Err(ChainError::Unsupported(format!(
        "allowed value variant {}",
        variant.name
    )))
}

#[expect(
    clippy::match_like_matches_macro,
    reason = "Explicit pattern matching documents the supported storage hasher."
)]
fn blake_concat(hashers: &[subxt_metadata::StorageHasher]) -> bool {
    if let [subxt_metadata::StorageHasher::Blake2_128Concat] = hashers {
        true
    } else {
        false
    }
}

#[expect(
    clippy::too_many_lines,
    reason = "One metadata cursor validates and skips the topology fields in wire order."
)]
fn topology_scalars(
    bytes: &[u8],
    ty: u32,
    metadata: &subxt_core::Metadata,
) -> Result<(u32, u32, Option<f64>, Option<f64>), ChainError> {
    use parity_scale_codec::{Compact, Decode};
    use scale_info::TypeDef;
    let mut input = bytes;
    let index = u8::decode(&mut input).map_err(invalid)?;
    let option = metadata
        .types()
        .resolve(ty)
        .ok_or_else(|| ChainError::Invalid("missing topology Option type".into()))?;
    let TypeDef::Variant(variants) = &option.type_def else {
        return Err(ChainError::Invalid(
            "topology return type is not an Option".into(),
        ));
    };
    let variant = variants
        .variants
        .iter()
        .find(|v| v.index == index)
        .ok_or_else(|| ChainError::Invalid("unknown topology Option variant".into()))?;
    if variant.name != "Some" {
        return Err(ChainError::Invalid(
            "mineable topology metadata is absent".into(),
        ));
    }
    let [some] = variant.fields.as_slice() else {
        return Err(ChainError::Invalid("malformed topology Option".into()));
    };
    let ty = metadata
        .types()
        .resolve(some.ty.id)
        .ok_or_else(|| ChainError::Invalid("missing topology type".into()))?;
    let TypeDef::Composite(composite) = &ty.type_def else {
        return Err(ChainError::Invalid("topology is not a struct".into()));
    };
    let mut nodes = None;
    let mut edges = None;
    let mut h = None;
    let mut j = None;
    for field in &composite.fields {
        let name = field.name.as_deref();
        if name == Some("nodes") || name == Some("edges") {
            let mut id = field.ty.id;
            loop {
                let ty = metadata
                    .types()
                    .resolve(id)
                    .ok_or_else(|| ChainError::Invalid("missing topology vector type".into()))?;
                match &ty.type_def {
                    TypeDef::Sequence(_) => break,
                    TypeDef::Composite(c) if c.fields.len() == 1 => {
                        id = c
                            .fields
                            .first()
                            .ok_or_else(|| {
                                ChainError::Invalid("missing vector wrapper field".into())
                            })?
                            .ty
                            .id;
                    }
                    _ => {
                        return Err(ChainError::Unsupported(
                            "topology graph field is not a vector".into(),
                        ));
                    }
                }
            }
            let count = Compact::<u32>::decode(&mut &*input).map_err(invalid)?.0;
            // The metadata visitor validates and skips each element without allocating graph nodes.
            subxt_core::ext::scale_decode::visitor::decode_with_visitor(
                &mut input,
                field.ty.id,
                metadata.types(),
                subxt_core::ext::scale_decode::visitor::IgnoreVisitor::new(),
            )
            .map_err(invalid)?;
            if name == Some("nodes") {
                nodes = Some(count);
            } else {
                edges = Some(count);
            }
        } else if name == Some("allowed_h_values") || name == Some("allowed_j_values") {
            let value =
                scale_value::scale::decode_as_type(&mut input, field.ty.id, metadata.types())
                    .map_err(invalid)?;
            let value = super::metadata::normalize_value(value, metadata);
            if name == Some("allowed_h_values") {
                h = Some(mean_abs(&value)?);
            } else {
                j = Some(mean_abs(&value)?);
            }
        } else {
            subxt_core::ext::scale_decode::visitor::decode_with_visitor(
                &mut input,
                field.ty.id,
                metadata.types(),
                subxt_core::ext::scale_decode::visitor::IgnoreVisitor::new(),
            )
            .map_err(invalid)?;
        }
    }
    if !input.is_empty() {
        return Err(ChainError::Invalid("trailing topology bytes".into()));
    }
    Ok((
        nodes.ok_or_else(|| ChainError::Invalid("topology lacks nodes".into()))?,
        edges.ok_or_else(|| ChainError::Invalid("topology lacks edges".into()))?,
        h.ok_or_else(|| ChainError::Invalid("topology lacks h spec".into()))?,
        j.ok_or_else(|| ChainError::Invalid("topology lacks j spec".into()))?,
    ))
}

fn miner_info(account: &[u8], value: &Value<u32>) -> Result<ChainMinerInfo, ChainError> {
    Ok(ChainMinerInfo {
        account_id: decode::account_bytes(account)?,
        deposit: decode::decimal(field(value, "deposit")?)?,
        proofs_submitted: decode::unsigned(field(value, "proofs_submitted")?)?,
        proofs_won: decode::unsigned(field(value, "proofs_won")?)?,
        rewards_earned: decode::decimal(field(value, "rewards_earned")?)?,
    })
}
#[expect(
    clippy::too_many_lines,
    reason = "The complete existing descriptor projection is kept together for field parity review."
)]
fn descriptor_json(value: &Value<u32>) -> Result<serde_json::Value, ChainError> {
    let schema = decode::u32_field(value, "schema_version")?;
    if schema != 1 && schema != 2 {
        return Err(ChainError::Unsupported(format!(
            "descriptor schema {schema}"
        )));
    }
    let mut object = serde_json::Map::new();
    let _ = object.insert("schema".into(), json!("quip.node_descriptor.v1"));
    let _ = object.insert("descriptorVersion".into(), json!(1));
    let name = text_value(field(value, "node_name")?)?
        .ok_or_else(|| ChainError::Invalid("empty descriptor node name".into()))?;
    let _ = object.insert("nodeName".into(), json!(name));
    strings(&mut object, value, &[("public_host", "publicHost")])?;
    numbers(&mut object, value, &[("public_port", "publicPort")])?;
    let endpoints = sequence(field(value, "rpc_endpoints")?)?
        .into_iter()
        .map(|v| text_value(v)?.ok_or_else(|| ChainError::Invalid("empty RPC endpoint".into())))
        .collect::<Result<Vec<_>, _>>()?;
    let _ = object.insert("rpcEndpoints".into(), json!(endpoints));
    let log = variant_name(field(value, "log_level")?)?;
    let _ = object.insert("logLevel".into(), json!(log));
    let mut miners = serde_json::Map::new();
    for (index, miner) in sequence(field(value, "miners")?)?.into_iter().enumerate() {
        let kind = variant_name(field(miner, "kind")?)?;
        let category = match kind {
            "Cpu" => "CPU",
            "Gpu" => "GPU",
            "QpuDwave" | "QpuIbm" | "QpuIonq" | "QpuPasqal" => "QPU",
            _ => "OTHER",
        };
        let label = text_value(field(miner, "label")?)?
            .unwrap_or_else(|| format!("{}-{}", category.to_lowercase(), index + 1));
        let device = text_value(field(miner, "device_id")?)?.unwrap_or_else(|| label.clone());
        let mut row = serde_json::Map::new();
        let _ = row.insert("kind".into(), json!(category));
        let _ = row.insert("minerId".into(), json!(device));
        if let Some(backend) = text_value(field(miner, "backend")?)? {
            if category == "GPU" {
                let _ = row.insert("backend".into(), json!(backend));
            } else if category == "QPU" {
                let _ = row.insert("provider".into(), json!(backend));
            }
        }
        let _ = miners.insert(label, serde_json::Value::Object(row));
    }
    if !miners.is_empty() {
        let _ = object.insert("miners".into(), serde_json::Value::Object(miners));
    }
    if let Some(runtime) = optional_field(value, "runtime")? {
        let mut row = serde_json::Map::new();
        strings(
            &mut row,
            runtime,
            &[
                ("python", "python"),
                ("quip_version", "quipVersion"),
                ("docker_image", "dockerImage"),
            ],
        )?;
        numbers(
            &mut row,
            runtime,
            &[("protocol_version", "protocolVersion")],
        )?;
        if let Some(value) = decode::maybe_field(runtime, "in_docker") {
            let _ = row.insert(
                "inDocker".into(),
                json!(
                    decode::unwrap(value)
                        .as_bool()
                        .ok_or_else(|| ChainError::Invalid("in_docker is not boolean".into()))?
                ),
            );
        }
        if !row.is_empty() {
            let _ = object.insert("runtime".into(), serde_json::Value::Object(row));
        }
    }
    if let Some(system) = optional_field(value, "system_info")? {
        let mut row = serde_json::Map::new();
        let os = field(system, "os")?;
        let mut os_row = serde_json::Map::new();
        strings(
            &mut os_row,
            os,
            &[
                ("system", "system"),
                ("release", "release"),
                ("machine", "machine"),
            ],
        )?;
        if !os_row.is_empty() {
            let _ = row.insert("os".into(), serde_json::Value::Object(os_row));
        }
        let cpu = field(system, "cpu")?;
        let mut cpu_row = serde_json::Map::new();
        strings(&mut cpu_row, cpu, &[("brand", "brand"), ("arch", "arch")])?;
        numbers(
            &mut cpu_row,
            cpu,
            &[
                ("logical_cores", "logicalCores"),
                ("physical_cores", "physicalCores"),
            ],
        )?;
        if !cpu_row.is_empty() {
            let _ = row.insert("cpu".into(), serde_json::Value::Object(cpu_row));
        }
        numbers(&mut row, system, &[("memory_mb", "memoryMb")])?;
        let mut gpus = Vec::new();
        for gpu in sequence(field(system, "gpus")?)? {
            let mut gpu_row = serde_json::Map::new();
            strings(&mut gpu_row, gpu, &[("vendor", "vendor"), ("name", "name")])?;
            numbers(
                &mut gpu_row,
                gpu,
                &[
                    ("index", "index"),
                    ("memory_mb", "memoryMb"),
                    ("utilization_pct", "observedUtilizationPct"),
                ],
            )?;
            if !gpu_row.is_empty() {
                gpus.push(serde_json::Value::Object(gpu_row));
            }
        }
        if !gpus.is_empty() {
            let _ = row.insert("gpus".into(), json!(gpus));
        }
        if !row.is_empty() {
            let _ = object.insert("systemInfo".into(), serde_json::Value::Object(row));
        }
    }
    Ok(serde_json::Value::Object(object))
}
fn optional_field<'a>(
    value: &'a Value<u32>,
    name: &str,
) -> Result<Option<&'a Value<u32>>, ChainError> {
    let Some(value) = decode::maybe_field(value, name) else {
        return Ok(None);
    };
    optional_value(value)
}
fn optional_value(value: &Value<u32>) -> Result<Option<&Value<u32>>, ChainError> {
    if let scale_value::ValueDef::Variant(v) = &decode::unwrap(value).value
        && (v.name == "Some" || v.name == "None")
    {
        return decode::option(value);
    }
    Ok(Some(value))
}
fn text_value(value: &Value<u32>) -> Result<Option<String>, ChainError> {
    let Some(value) = optional_value(value)? else {
        return Ok(None);
    };
    let bytes = decode::bytes(value)?;
    if bytes.is_empty() {
        return Ok(None);
    }
    String::from_utf8(bytes).map(Some).map_err(invalid)
}
fn variant_name(value: &Value<u32>) -> Result<&str, ChainError> {
    if let scale_value::ValueDef::Variant(v) = &decode::unwrap(value).value {
        Ok(&v.name)
    } else {
        Err(ChainError::Invalid("expected enum variant".into()))
    }
}
fn strings(
    object: &mut serde_json::Map<String, serde_json::Value>,
    value: &Value<u32>,
    fields: &[(&str, &str)],
) -> Result<(), ChainError> {
    for (source, target) in fields {
        if let Some(value) = decode::maybe_field(value, source)
            && let Some(value) = text_value(value)?
        {
            let _ = object.insert((*target).into(), json!(value));
        }
    }
    Ok(())
}
fn numbers(
    object: &mut serde_json::Map<String, serde_json::Value>,
    value: &Value<u32>,
    fields: &[(&str, &str)],
) -> Result<(), ChainError> {
    for (source, target) in fields {
        if let Some(value) = optional_field(value, source)? {
            let _ = object.insert((*target).into(), json!(decode::unsigned(value)?));
        }
    }
    Ok(())
}
