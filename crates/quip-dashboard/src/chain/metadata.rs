use super::{BlockHash, ChainError, ChainReader, Header, WorkClass, invalid, unhex};
use blake2::{Blake2b, Digest, digest::consts::U32};
use parity_scale_codec::Decode;
use scale_value::Value;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{collections::BTreeMap, sync::Arc};
use subxt_core::{Metadata, dynamic};
use tokio::sync::OnceCell;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
/// Runtime version reported at an explicit state hash.
pub struct RuntimeVersionInfo {
    /// Runtime specification name.
    pub spec_name: String,
    /// Runtime specification version.
    pub spec_version: u32,
    /// Runtime transaction version.
    pub transaction_version: u32,
    /// Runtime implementation name.
    pub impl_name: String,
}
#[derive(Clone, Debug)]
/// Chain identity, runtime identity, and historical metadata.
pub struct RuntimeContext {
    payload_charge: Option<Arc<super::budget::Charge>>,
    /// Genesis hash that owns this record.
    pub genesis: BlockHash,
    /// State hash used for this metadata context.
    pub state_hash: BlockHash,
    /// Runtime specification version.
    pub spec_version: u32,
    /// Blake2-256 digest of the complete SCALE metadata.
    pub metadata_hash: BlockHash,
    /// Runtime code identity at the selected state.
    pub code_hash: BlockHash,
    /// Complete runtime version information.
    pub version: RuntimeVersionInfo,
    /// Decoded metadata shared by runtime code identity.
    pub metadata: Metadata,
}
#[derive(Clone, Debug)]
/// Separate execution and post-state runtimes for one block.
pub struct BlockContexts {
    /// Block whose execution and post-state contexts are selected.
    pub block: BlockHash,
    /// Parent state hash for execution decoding.
    pub parent: BlockHash,
    /// Runtime that executed this block.
    pub execution: RuntimeContext,
    /// Runtime installed in the resulting block state.
    pub post_state: RuntimeContext,
}
/// Store these through the database writer, then supply them before connecting.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct MetadataRecord {
    /// Genesis hash that owns this record.
    pub genesis: BlockHash,
    /// State hash used for this metadata context.
    pub state_hash: BlockHash,
    /// Runtime code identity at the selected state.
    pub code_hash: BlockHash,
    /// Blake2-256 digest of the complete SCALE metadata.
    pub metadata_hash: BlockHash,
    /// Complete runtime version information.
    pub version: RuntimeVersionInfo,
    /// Complete SCALE metadata bytes for persistence.
    pub bytes: Vec<u8>,
}
#[derive(Default)]
pub(super) struct MetadataCache {
    codes: BTreeMap<BlockHash, Arc<OnceCell<CachedMetadata>>>,
}
struct CachedMetadata {
    record: MetadataRecord,
    context: RuntimeContext,
}
impl MetadataRecord {
    /// Validates persisted metadata and builds a runtime context.
    ///
    /// # Errors
    /// Returns typed RPC, pruning, capability, or malformed-data errors.
    pub fn context(&self, state_hash: BlockHash) -> Result<RuntimeContext, ChainError> {
        if self.bytes.len() > 16 * 1024 * 1024 {
            return Err(ChainError::Oversized("metadata".into()));
        }
        if metadata_hash(&self.bytes) != self.metadata_hash {
            return Err(ChainError::Invalid("metadata content hash mismatch".into()));
        }
        // Reject unsupported versions before entering the dynamic decoder.
        if self.bytes.get(..4) != Some(b"meta")
            || !self.bytes.get(4).is_some_and(|v| (14..=16).contains(v))
        {
            return Err(ChainError::Unsupported(
                "metadata must be V14, V15, or V16".into(),
            ));
        }
        let mut bytes = self.bytes.as_slice();
        let metadata = Metadata::decode(&mut bytes).map_err(invalid)?;
        if !bytes.is_empty() {
            return Err(ChainError::Invalid("trailing metadata bytes".into()));
        }
        Ok(RuntimeContext {
            payload_charge: None,
            genesis: self.genesis,
            state_hash,
            spec_version: self.version.spec_version,
            metadata_hash: self.metadata_hash,
            code_hash: self.code_hash,
            version: self.version.clone(),
            metadata,
        })
    }
}
pub(super) fn metadata_hash(bytes: &[u8]) -> BlockHash {
    BlockHash(Blake2b::<U32>::digest(bytes).into())
}
impl ChainReader {
    async fn make_metadata_room(&self, cache: &mut MetadataCache) -> Result<(), ChainError> {
        while cache.codes.len() >= 8 {
            if let Some(key) = cache
                .codes
                .iter()
                .find(|(_, entry)| metadata_removable(entry))
                .map(|(key, _)| *key)
            {
                let _ = cache.codes.remove(&key);
            } else {
                let mut blocks = self.blocks.lock().await;
                let key = blocks
                    .iter()
                    .find(|(_, entry)| Arc::strong_count(entry) == 1)
                    .map(|(key, _)| *key)
                    .ok_or(ChainError::Busy)?;
                let _ = blocks.remove(&key);
            }
        }
        Ok(())
    }
    async fn reserve_metadata(
        &self,
        cache: &mut MetadataCache,
        bytes: usize,
    ) -> Result<Arc<super::budget::Charge>, ChainError> {
        if bytes > super::budget::Kind::Metadata.limit() {
            return Err(ChainError::Oversized(
                "persisted metadata exceeds 8 MiB".into(),
            ));
        }
        loop {
            if let Some(charge) = self.budget.reserve(super::budget::Kind::Metadata, bytes) {
                return Ok(Arc::new(charge));
            }
            if let Some(removable) = cache
                .codes
                .iter()
                .find(|(_, entry)| metadata_removable(entry))
                .map(|(key, _)| *key)
            {
                let _ = cache.codes.remove(&removable);
                continue;
            }
            // Completed blocks can retain earlier runtimes after metadata-map eviction.
            // Never evict an in-flight block or remove its metadata reservation.
            let mut blocks = self.blocks.lock().await;
            let removable = blocks
                .iter()
                .find(|(_, entry)| Arc::strong_count(entry) == 1)
                .map(|(key, _)| *key)
                .ok_or(ChainError::Busy)?;
            let _ = blocks.remove(&removable);
        }
    }

    /// Loads validated metadata records through the bounded cache.
    ///
    /// # Errors
    /// Returns typed RPC, pruning, capability, or malformed-data errors.
    pub async fn import_metadata(&self, records: Vec<MetadataRecord>) -> Result<(), ChainError> {
        let mut cache = self.metadata.lock().await;
        for record in records {
            if record.genesis != self.genesis {
                return Err(ChainError::GenesisMismatch {
                    expected: self.genesis,
                    actual: record.genesis,
                });
            }
            let mut context = record.context(record.state_hash)?;
            context.payload_charge = Some(
                self.reserve_metadata(&mut cache, record.bytes.capacity())
                    .await?,
            );
            if !cache.codes.contains_key(&record.code_hash) {
                self.make_metadata_room(&mut cache).await?;
            }
            let _ = cache.codes.insert(
                record.code_hash,
                Arc::new(OnceCell::new_with(Some(CachedMetadata { record, context }))),
            );
        }
        Ok(())
    }
    /// Returns metadata records for the database writer to persist.
    pub async fn metadata_records(&self) -> Vec<MetadataRecord> {
        self.metadata
            .lock()
            .await
            .codes
            .values()
            .filter_map(|v| v.get().map(|c| c.record.clone()))
            .collect()
    }
    /// Selects cached metadata using historical runtime code identity.
    ///
    /// # Errors
    /// Returns typed RPC, pruning, capability, or malformed-data errors.
    pub async fn runtime_context(
        &self,
        at: BlockHash,
        class: WorkClass,
    ) -> Result<RuntimeContext, ChainError> {
        // Runtime code identity catches upgrades even when spec_version was not bumped.
        let code = self
            .transport
            .shared("state_getStorageHash", json!(["0x3a636f6465", at]), class)
            .await?;
        let code_hash: BlockHash =
            serde_json::from_value(code.as_ref().as_ref().clone()).map_err(invalid)?;
        let cell = {
            let mut cache = self.metadata.lock().await;
            if !cache.codes.contains_key(&code_hash) {
                self.make_metadata_room(&mut cache).await?;
            }
            cache.codes.entry(code_hash).or_default().clone()
        };
        let record = cell
            .get_or_try_init(|| async {
                let version: RuntimeVersionInfo = serde_json::from_value(
                    self.transport
                        .request("state_getRuntimeVersion", json!([at]), class)
                        .await?,
                )
                .map_err(invalid)?;
                let bytes = self
                    .transport
                    .request("state_getMetadata", json!([at]), class)
                    .await?;
                let bytes = unhex(
                    bytes
                        .as_str()
                        .ok_or_else(|| ChainError::Invalid("metadata is not hex".into()))?,
                )?;
                let record = MetadataRecord {
                    genesis: self.genesis,
                    state_hash: at,
                    code_hash,
                    metadata_hash: metadata_hash(&bytes),
                    version,
                    bytes,
                };
                let mut context = record.context(at)?;
                let mut cache = self.metadata.lock().await;
                context.payload_charge = Some(
                    self.reserve_metadata(&mut cache, record.bytes.capacity())
                        .await?,
                );
                Ok::<CachedMetadata, ChainError>(CachedMetadata { record, context })
            })
            .await?;
        let mut context = record.context.clone();
        context.state_hash = at;
        Ok(context)
    }
    /// Resolves execution and post-state runtimes, with an explicit genesis path.
    ///
    /// # Errors
    /// Returns typed RPC, pruning, capability, or malformed-data errors.
    pub async fn contexts(
        &self,
        block: BlockHash,
        header: &Header,
        class: WorkClass,
    ) -> Result<BlockContexts, ChainError> {
        let post_state = self.runtime_context(block, class).await?;
        let execution = if header.height()? == 0 {
            post_state.clone()
        } else {
            self.runtime_context(header.parent_hash, class).await?
        };
        Ok(BlockContexts {
            block,
            parent: header.parent_hash,
            execution,
            post_state,
        })
    }
    pub(super) async fn raw_storage(
        &self,
        at: BlockHash,
        context: &RuntimeContext,
        pallet: &str,
        entry: &str,
        keys: Vec<Value>,
        class: WorkClass,
    ) -> Result<Vec<u8>, ChainError> {
        let address = dynamic::storage(pallet, entry, keys);
        let (_, details) =
            subxt_core::storage::lookup_storage_entry_details(pallet, entry, &context.metadata)
                .map_err(|_| ChainError::Unsupported(format!("{pallet}.{entry}")))?;
        let key = subxt_core::storage::get_address_bytes(&address, &context.metadata)?;
        let value = self
            .transport
            .shared(
                "state_getStorage",
                json!([format!("0x{}", hex::encode(key)), at]),
                class,
            )
            .await?;
        match value.as_ref().as_ref() {
            serde_json::Value::Null => Ok(details.default_bytes().to_vec()),
            serde_json::Value::String(s) => unhex(s),
            _ => Err(ChainError::Invalid(
                "storage response is not hex or null".into(),
            )),
        }
    }
    /// Reads optional storage without conflating absence and decode failure.
    ///
    /// # Errors
    /// Returns typed RPC, pruning, capability, or malformed-data errors.
    pub async fn optional_storage(
        &self,
        at: BlockHash,
        pallet: &str,
        entry: &str,
        keys: Vec<Value>,
        class: WorkClass,
    ) -> Result<Option<Value<u32>>, ChainError> {
        let context = self.runtime_context(at, class).await?;
        let address = dynamic::storage(pallet, entry, keys);
        let key = subxt_core::storage::get_address_bytes(&address, &context.metadata)?;
        let response = self
            .transport
            .shared(
                "state_getStorage",
                json!([format!("0x{}", hex::encode(key)), at]),
                class,
            )
            .await?;
        if response.is_null() {
            return Ok(None);
        }
        let bytes = unhex(
            response
                .as_str()
                .ok_or_else(|| ChainError::Invalid("storage response is not hex".into()))?,
        )?;
        let (_, details) =
            subxt_core::storage::lookup_storage_entry_details(pallet, entry, &context.metadata)?;
        let ty = match details.entry_type() {
            subxt_metadata::StorageEntryType::Plain(ty) => *ty,
            subxt_metadata::StorageEntryType::Map { value_ty, .. } => *value_ty,
        };
        decode_value(&bytes, ty, &context.metadata).map(Some)
    }
    /// Reads and decodes storage with its selected post-state metadata.
    ///
    /// # Errors
    /// Returns typed RPC, pruning, capability, or malformed-data errors.
    pub async fn storage(
        &self,
        at: BlockHash,
        pallet: &str,
        entry: &str,
        keys: Vec<Value>,
        class: WorkClass,
    ) -> Result<Value<u32>, ChainError> {
        let context = self.runtime_context(at, class).await?;
        let bytes = self
            .raw_storage(at, &context, pallet, entry, keys, class)
            .await?;
        let (_, details) =
            subxt_core::storage::lookup_storage_entry_details(pallet, entry, &context.metadata)?;
        let ty = match details.entry_type() {
            subxt_metadata::StorageEntryType::Plain(ty) => *ty,
            subxt_metadata::StorageEntryType::Map { value_ty, .. } => *value_ty,
        };
        decode_value(&bytes, ty, &context.metadata)
    }
    /// Encodes arguments and decodes a runtime result using snapshot metadata.
    ///
    /// # Errors
    /// Returns typed RPC, pruning, capability, or malformed-data errors.
    pub async fn runtime_call(
        &self,
        at: BlockHash,
        api: &str,
        method: &str,
        args: Vec<Value>,
        class: WorkClass,
    ) -> Result<Value<u32>, ChainError> {
        let (bytes, ty, metadata) = self.runtime_bytes(at, api, method, args, class).await?;
        decode_value(&bytes, ty, &metadata)
    }
    pub(super) async fn runtime_bytes(
        &self,
        at: BlockHash,
        api: &str,
        method: &str,
        args: Vec<Value>,
        class: WorkClass,
    ) -> Result<(Vec<u8>, u32, Metadata), ChainError> {
        let context = self.runtime_context(at, class).await?;
        let entry = context
            .metadata
            .runtime_api_trait_by_name(api)
            .and_then(|a| a.method_by_name(method))
            .ok_or_else(|| ChainError::Unsupported(format!("{api}_{method}")))?;
        let payload = dynamic::runtime_api_call(api, method, args);
        let args = subxt_core::runtime_api::call_args(&payload, &context.metadata)?;
        let params = json!([
            format!("{api}_{method}"),
            format!("0x{}", hex::encode(args)),
            at
        ]);
        // Winning solutions are cached with decoded blocks. Keeping a raw None
        // response here would prevent explicit reindex from probing it again.
        let response = if api == "QuantumPowApi"
            && (method == "topology_meta" || method == "winning_solution")
        {
            self.transport.request("state_call", params, class).await?
        } else {
            self.transport
                .shared("state_call", params, class)
                .await?
                .as_ref()
                .as_ref()
                .clone()
        };
        let bytes = unhex(
            response
                .as_str()
                .ok_or_else(|| ChainError::Invalid("runtime response is not hex".into()))?,
        )?;
        Ok((bytes, entry.output_ty(), context.metadata.clone()))
    }
}
pub(super) fn decode_value(
    bytes: &[u8],
    ty: u32,
    metadata: &Metadata,
) -> Result<Value<u32>, ChainError> {
    let mut input = bytes;
    let value =
        scale_value::scale::decode_as_type(&mut input, ty, metadata.types()).map_err(invalid)?;
    if !input.is_empty() {
        return Err(ChainError::Invalid("trailing SCALE bytes".into()));
    }
    Ok(normalize_value(value, metadata))
}

pub(super) fn normalize_value(mut value: Value<u32>, metadata: &Metadata) -> Value<u32> {
    // SCALE values retain tuple-struct newtypes. Remove only metadata-declared
    // wrappers, never a one-element Vec or tuple, whose cardinality is meaningful.
    match &mut value.value {
        scale_value::ValueDef::Composite(composite) => normalize_composite(composite, metadata),
        scale_value::ValueDef::Variant(variant) => {
            normalize_composite(&mut variant.values, metadata);
        }
        scale_value::ValueDef::Primitive(_) | scale_value::ValueDef::BitSequence(_) => {}
    }
    let wrapper = metadata.types().resolve(value.context).is_some_and(|ty| {
        if let scale_info::TypeDef::Composite(c) = &ty.type_def {
            c.fields.len() == 1 && c.fields.first().is_some_and(|f| f.name.is_none())
        } else {
            false
        }
    });
    if wrapper
        && let scale_value::ValueDef::Composite(scale_value::Composite::Unnamed(values)) =
            &mut value.value
        && values.len() == 1
        && let Some(inner) = values.pop()
    {
        return inner;
    }
    value
}
fn normalize_composite(composite: &mut scale_value::Composite<u32>, metadata: &Metadata) {
    match composite {
        scale_value::Composite::Named(fields) => {
            for (_, value) in fields {
                let placeholder = Value::u128(0).map_context(|()| 0);
                let old = std::mem::replace(value, placeholder);
                *value = normalize_value(old, metadata);
            }
        }
        scale_value::Composite::Unnamed(values) => {
            for value in values {
                let placeholder = Value::u128(0).map_context(|()| 0);
                let old = std::mem::replace(value, placeholder);
                *value = normalize_value(old, metadata);
            }
        }
    }
}

fn metadata_removable(entry: &Arc<OnceCell<CachedMetadata>>) -> bool {
    Arc::strong_count(entry) == 1
        && entry.get().is_none_or(|value| {
            value
                .context
                .payload_charge
                .as_ref()
                .is_none_or(|charge| Arc::strong_count(charge) == 1)
        })
}
