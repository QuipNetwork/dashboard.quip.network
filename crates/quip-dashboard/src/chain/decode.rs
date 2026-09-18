use super::{BlockHash, ChainError, invalid, unhex};
use blake2::{Blake2b512, Digest};
use parity_scale_codec::{Compact, Decode};
use scale_value::{Composite, Primitive, Value, ValueDef};
use subxt_core::{Metadata, config::SubstrateConfig};

#[derive(Clone, Debug, PartialEq, Eq)]
/// Exact difficulty gates returned by the runtime.
pub struct DifficultyInfo {
    /// Minimum accepted solution count.
    pub min_solutions: u32,
    /// Signed energy ceiling in milli units.
    pub max_energy_milli: i64,
    /// Minimum diversity in milli units.
    pub min_diversity_milli: u32,
}
#[derive(Clone, Debug, PartialEq, Eq)]
/// Named winning-proof fields decoded with execution metadata.
pub struct BlockWinnerEvent {
    /// Monotonic winning solution identifier, distinct from substrate height.
    pub qblock_id: u64,
    /// Substrate height as an exact integer.
    pub block_number: u64,
    /// Winner or proof submitter in SS58 format.
    pub miner: String,
    /// Exact reward in canonical decimal units.
    pub reward: String,
    /// Signed energy in milli units.
    pub energy_milli: i64,
    /// Substrate height when the winning proof was submitted.
    pub submitted_at: u64,
}
#[derive(Clone, Debug, PartialEq, Eq)]
/// Accepted proof fields decoded with execution metadata.
pub struct ProofAcceptedEvent {
    /// Winner or proof submitter in SS58 format.
    pub miner: String,
    /// Signed energy in milli units.
    pub energy_milli: i64,
    /// Proof diversity in milli units.
    pub diversity_milli: u32,
    /// Number of valid submitted solutions.
    pub valid_solution_count: u32,
}
#[derive(Clone, Debug, Default, PartialEq, Eq)]
/// An account affected by a miner registry event.
pub struct RegistryChange {
    /// Runtime event variant name.
    pub event: String,
    /// Raw account identifier for targeted storage reads.
    pub account: [u8; 32],
}
#[derive(Clone, Debug, Default, PartialEq, Eq)]
/// Execution events and optional block enrichment.
pub struct BlockEvents {
    /// Substrate height as an exact integer.
    pub block_number: u64,
    /// SS58 session validator account, absent when the digest has no BABE author.
    pub author: Option<String>,
    /// Unix timestamp in seconds.
    pub timestamp: u64,
    /// Winning proof event, absent on nonwinning blocks.
    pub winner: Option<BlockWinnerEvent>,
    /// All accepted proof events in this block.
    pub proofs: Vec<ProofAcceptedEvent>,
    /// Exact derived nonce in decimal notation.
    pub nonce: Option<String>,
    /// Pallet and event names relevant to snapshot invalidation.
    pub changes: Vec<(String, String)>,
    /// Accounts affected by miner registry events.
    pub registry_changes: Vec<RegistryChange>,
    /// Accounts whose `QuantumPow` registration or proof counters changed.
    pub miner_changes: Vec<[u8; 32]>,
}
#[derive(Clone, Debug, PartialEq, Eq)]
/// Retained winning solution and exact runtime-derived nonce.
pub struct QBlockInfo {
    /// Winner or proof submitter in SS58 format.
    pub miner: String,
    /// Signed energy in milli units.
    pub energy_milli: i64,
    /// Exact reward in canonical decimal units.
    pub reward: String,
    /// Substrate height when the winning proof was submitted.
    pub submitted_at: u64,
    /// Exact derived nonce in decimal notation.
    pub nonce: String,
    /// Difficulty gates at the queried state or winning proof.
    pub difficulty: DifficultyInfo,
    /// Optional miner-reported compute time in microseconds, preserving zero.
    pub device_access_time_us: Option<u64>,
    /// Identity of the topology associated with this record.
    pub topology_hash: Option<BlockHash>,
}
#[derive(Clone, Debug)]
/// Metadata-decoded extrinsic without cryptographic verification.
pub struct DecodedExtrinsic {
    /// Pallet name from the selected runtime metadata.
    pub pallet: String,
    /// Call variant name from the selected runtime metadata.
    pub call: String,
    /// SCALE address bytes for signed extrinsics.
    pub address_bytes: Option<Vec<u8>>,
    /// SCALE signature envelope, absent on bare extrinsics.
    pub signature_bytes: Option<Vec<u8>>,
    /// Decoded metadata fields, retained for consumers needing typed chain data.
    pub fields: Composite<u32>,
}

/// Strictly checks the vector count and consumed bytes because the upstream event iterator
/// accepts a truncated vector prefix as an empty event collection.
///
/// # Errors
/// Returns typed RPC, pruning, capability, or malformed-data errors.
pub fn decode_events(bytes: &[u8], metadata: &Metadata) -> Result<BlockEvents, ChainError> {
    let mut input = bytes;
    let count = Compact::<u32>::decode(&mut input).map_err(invalid)?.0;
    if count > 100_000 {
        return Err(ChainError::Oversized("event count exceeds 100000".into()));
    }
    let mut consumed = bytes.len() - input.len();
    let decoded =
        subxt_core::events::decode_from::<SubstrateConfig>(bytes.to_vec(), metadata.clone());
    let mut seen = 0;
    let mut result = BlockEvents::default();
    for event in decoded.iter() {
        let event = event?;
        seen += 1;
        consumed += event.bytes().len();
        let pallet = event.pallet_name();
        let name = event.variant_name();
        if pallet == "QuantumPow" {
            let fields = Value {
                value: ValueDef::Composite(event.field_values()?),
                context: 0,
            };
            if let Some(who) = maybe_field(&fields, "who").or_else(|| maybe_field(&fields, "miner"))
            {
                let account = self::bytes(who)?.try_into().map_err(|_| {
                    ChainError::Unsupported("miner account is not AccountId32".into())
                })?;
                if !result.miner_changes.contains(&account) {
                    result.miner_changes.push(account);
                }
            }
            if name == "BlockWinner" {
                if result.winner.is_some() {
                    return Err(ChainError::Invalid("multiple BlockWinner events".into()));
                }
                result.winner = Some(BlockWinnerEvent {
                    qblock_id: unsigned(field(&fields, "qblock_id")?)?,
                    block_number: unsigned(field(&fields, "block_number")?)?,
                    miner: account(field(&fields, "miner")?)?,
                    reward: decimal(field(&fields, "reward")?)?,
                    energy_milli: signed(field(&fields, "energy_milli")?)?,
                    submitted_at: unsigned(field(&fields, "submitted_at")?)?,
                });
            } else if name == "ProofAccepted" {
                result.proofs.push(ProofAcceptedEvent {
                    miner: account(field(&fields, "miner")?)?,
                    energy_milli: signed(field(&fields, "energy_milli")?)?,
                    diversity_milli: u32_field(&fields, "diversity_milli")?,
                    valid_solution_count: u32_field(&fields, "valid_solution_count")?,
                });
            }
        }
        if pallet == "MinerRegistry" {
            let fields = Value {
                value: ValueDef::Composite(event.field_values()?),
                context: 0,
            };
            if let Some(who) = maybe_field(&fields, "who") {
                result.registry_changes.push(RegistryChange {
                    event: name.into(),
                    account: self::bytes(who)?.try_into().map_err(|_| {
                        ChainError::Unsupported("registry account is not AccountId32".into())
                    })?,
                });
            }
        }
        if pallet == "MinerRegistry"
            || pallet == "Session"
            || pallet == "Babe"
            || pallet == "QuantumPow"
            || pallet == "System" && name == "CodeUpdated"
        {
            result.changes.push((pallet.into(), name.into()));
        }
    }
    if seen != count || consumed != bytes.len() {
        return Err(ChainError::Invalid(
            "event count or trailing bytes mismatch".into(),
        ));
    }
    Ok(result)
}
///
/// # Errors
/// Returns typed RPC, pruning, capability, or malformed-data errors.
/// Decodes mixed extrinsic versions using the selected execution metadata.
pub fn decode_extrinsics(
    bytes: Vec<Vec<u8>>,
    metadata: &Metadata,
) -> Result<Vec<DecodedExtrinsic>, ChainError> {
    let extrinsics =
        subxt_core::blocks::Extrinsics::<SubstrateConfig>::decode_from(bytes, metadata.clone())?;
    let mut result = Vec::with_capacity(extrinsics.len());
    for item in extrinsics.iter() {
        result.push(DecodedExtrinsic {
            pallet: item.pallet_name()?.into(),
            call: item.variant_name()?.into(),
            address_bytes: item.address_bytes().map(<[u8]>::to_vec),
            signature_bytes: item.signature_bytes().map(<[u8]>::to_vec),
            fields: item.field_values()?,
        });
    }
    Ok(result)
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
/// Fixed BABE pre-runtime fields needed for authorship.
pub struct BabeDigest {
    /// Index into the active session validator list.
    pub authority_index: u32,
    /// Exact BABE slot number.
    pub slot: u64,
}
impl BabeDigest {
    /// Extracts BABE authority index and slot without decoding proof cryptography.
    ///
    /// # Errors
    /// Returns typed RPC, pruning, capability, or malformed-data errors.
    pub fn from_logs(logs: &[String]) -> Result<Option<Self>, ChainError> {
        let mut found = None;
        for log in logs {
            let bytes = unhex(log)?;
            // DigestItem::PreRuntime has discriminant 6; other engines are unrelated.
            if bytes.first() != Some(&6) {
                continue;
            }
            if bytes.get(1..5) != Some(b"BABE") {
                continue;
            }
            let mut input = bytes
                .get(5..)
                .ok_or_else(|| ChainError::Invalid("short BABE digest".into()))?;
            let payload = Vec::<u8>::decode(&mut input).map_err(invalid)?;
            if !input.is_empty() {
                return Err(ChainError::Invalid("trailing BABE digest bytes".into()));
            }
            let mut input = payload.as_slice();
            let variant = u8::decode(&mut input).map_err(invalid)?;
            if !(1..=3).contains(&variant) {
                return Err(ChainError::Unsupported(format!(
                    "BABE pre-digest variant {variant}"
                )));
            }
            let authority_index = u32::decode(&mut input).map_err(invalid)?;
            let slot = u64::decode(&mut input).map_err(invalid)?;
            // Primary/secondary VRF proofs use chain-specific cryptography; metadata does
            // not describe digest payloads. Only the fixed leading index and slot are read.
            if variant == 2 && !input.is_empty() {
                return Err(ChainError::Invalid(
                    "trailing secondary-plain digest bytes".into(),
                ));
            }
            if found
                .replace(Self {
                    authority_index,
                    slot,
                })
                .is_some()
            {
                return Err(ChainError::Invalid(
                    "duplicate BABE pre-runtime digest".into(),
                ));
            }
        }
        Ok(found)
    }
}
pub(super) fn qblock(value: &Value<u32>) -> Result<Option<QBlockInfo>, ChainError> {
    let Some(value) = option(value)? else {
        return Ok(None);
    };
    let solution = field(value, "solution")?;
    Ok(Some(QBlockInfo {
        miner: account(field(solution, "miner")?)?,
        energy_milli: signed(field(solution, "energy_milli")?)?,
        reward: decimal(field(solution, "reward")?)?,
        submitted_at: unsigned(field(solution, "submitted_at")?)?,
        nonce: decimal(field(value, "nonce")?)?,
        difficulty: difficulty(field(solution, "difficulty")?)?,
        device_access_time_us: maybe_field(solution, "device_access_time_us")
            .map(unsigned)
            .transpose()?,
        topology_hash: maybe_field(solution, "topology_hash")
            .map(hash)
            .transpose()?,
    }))
}
pub(super) fn difficulty(value: &Value<u32>) -> Result<DifficultyInfo, ChainError> {
    Ok(DifficultyInfo {
        min_solutions: u32_field(value, "min_solutions")?,
        max_energy_milli: signed(field(value, "max_energy_milli")?)?,
        min_diversity_milli: u32_field(value, "min_diversity_milli")?,
    })
}
pub(super) fn unwrap(value: &Value<u32>) -> &Value<u32> {
    let mut value = value;
    while let ValueDef::Composite(Composite::Unnamed(values)) = &value.value {
        if values.len() != 1 {
            break;
        }
        let [inner] = values.as_slice() else {
            break;
        };
        value = inner;
    }
    value
}
pub(super) fn maybe_field<'a>(value: &'a Value<u32>, name: &str) -> Option<&'a Value<u32>> {
    if let ValueDef::Composite(Composite::Named(fields)) = &unwrap(value).value {
        fields.iter().find(|(key, _)| key == name).map(|(_, v)| v)
    } else {
        None
    }
}
pub(super) fn field<'a>(value: &'a Value<u32>, name: &str) -> Result<&'a Value<u32>, ChainError> {
    maybe_field(value, name).ok_or_else(|| ChainError::Invalid(format!("missing field {name}")))
}
pub(super) fn sequence(value: &Value<u32>) -> Result<Vec<&Value<u32>>, ChainError> {
    // Do not unwrap a one-element vector as a newtype.
    if let ValueDef::Composite(composite) = &value.value {
        Ok(composite.values().collect())
    } else {
        Err(ChainError::Invalid("expected sequence".into()))
    }
}
pub(super) fn option(value: &Value<u32>) -> Result<Option<&Value<u32>>, ChainError> {
    if let ValueDef::Variant(variant) = &unwrap(value).value {
        if variant.name == "None" && variant.values.is_empty() {
            return Ok(None);
        }
        if variant.name == "Some" && variant.values.len() == 1 {
            return Ok(variant.values.values().next());
        }
    }
    Err(ChainError::Invalid("expected SCALE Option".into()))
}
pub(super) fn unsigned(value: &Value<u32>) -> Result<u64, ChainError> {
    u64::try_from(
        unwrap(value)
            .as_u128()
            .ok_or_else(|| ChainError::Invalid("expected unsigned integer".into()))?,
    )
    .map_err(invalid)
}
pub(super) fn signed(value: &Value<u32>) -> Result<i64, ChainError> {
    i64::try_from(
        unwrap(value)
            .as_i128()
            .ok_or_else(|| ChainError::Invalid("expected signed integer".into()))?,
    )
    .map_err(invalid)
}
pub(super) fn u32_field(value: &Value<u32>, name: &str) -> Result<u32, ChainError> {
    u32::try_from(unsigned(field(value, name)?)?).map_err(invalid)
}
pub(super) fn bytes(value: &Value<u32>) -> Result<Vec<u8>, ChainError> {
    let value = unwrap(value);
    if let Some(byte) = value.as_u128() {
        return Ok(vec![u8::try_from(byte).map_err(invalid)?]);
    }
    if let ValueDef::Primitive(Primitive::U256(bytes)) = &value.value {
        return Ok(bytes.to_vec());
    }
    sequence(value)?
        .into_iter()
        .map(|v| u8::try_from(unsigned(v)?).map_err(invalid))
        .collect()
}
pub(super) fn hash(value: &Value<u32>) -> Result<BlockHash, ChainError> {
    Ok(BlockHash(bytes(value)?.try_into().map_err(|_| {
        ChainError::Invalid("expected H256".into())
    })?))
}
pub(super) fn account(value: &Value<u32>) -> Result<String, ChainError> {
    account_bytes(&bytes(value)?)
}
pub(super) fn account_bytes(account: &[u8]) -> Result<String, ChainError> {
    if account.len() != 32 {
        return Err(ChainError::Unsupported(format!(
            "account identifier length {}",
            account.len()
        )));
    }
    let mut payload = vec![42];
    payload.extend_from_slice(account);
    let mut hash = Blake2b512::new();
    hash.update(b"SS58PRE");
    hash.update(&payload);
    let checksum = hash.finalize();
    payload.extend(checksum.iter().take(2));
    Ok(bs58::encode(payload).into_string())
}
pub(super) fn decimal(value: &Value<u32>) -> Result<String, ChainError> {
    let value = unwrap(value);
    if let Some(number) = value.as_u128() {
        return Ok(number.to_string());
    }
    // primitive-types U256 metadata describes four little-endian u64 limbs.
    let raw = match &value.value {
        ValueDef::Primitive(Primitive::U256(bytes)) => bytes.to_vec(),
        ValueDef::Composite(_) => {
            let values = sequence(value)?;
            if values.len() != 4 {
                return Err(ChainError::Invalid("expected four U256 limbs".into()));
            }
            let mut bytes = Vec::with_capacity(32);
            for limb in values {
                bytes.extend(unsigned(limb)?.to_le_bytes());
            }
            bytes
        }
        _ => return Err(ChainError::Invalid("expected nonnegative integer".into())),
    };
    // Decimal multiplication avoids a heavyweight arithmetic dependency and preserves all 256 bits.
    let mut digits = vec![0u8];
    for byte in raw.iter().rev() {
        let mut carry = u16::from(*byte);
        for digit in &mut digits {
            let next = u16::from(*digit) * 256 + carry;
            *digit = u8::try_from(next % 10).map_err(invalid)?;
            carry = next / 10;
        }
        while carry > 0 {
            digits.push(u8::try_from(carry % 10).map_err(invalid)?);
            carry /= 10;
        }
    }
    Ok(digits.iter().rev().map(|d| char::from(b'0' + d)).collect())
}
