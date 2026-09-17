// SPDX-License-Identifier: AGPL-3.0-or-later

//! Node descriptor and live-identity records.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::decimal::DecimalString;
use crate::hash::BlockHash;
use crate::miner::MinerCategory;

/// CPU identity from a node descriptor.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeSystemCpu {
    /// Logical core count.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub logical_cores: Option<u32>,
    /// Physical core count.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub physical_cores: Option<u32>,
    /// CPU brand string.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub brand: Option<String>,
    /// CPU architecture.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub arch: Option<String>,
}

/// Operating-system identity from a node descriptor.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeSystemOs {
    /// OS name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub system: Option<String>,
    /// OS release.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub release: Option<String>,
    /// Machine architecture.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub machine: Option<String>,
}

/// GPU identity from a node descriptor.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeSystemGpu {
    /// GPU index.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub index: Option<u32>,
    /// Vendor name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vendor: Option<String>,
    /// Device name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// Memory in mebibytes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub memory_mb: Option<u64>,
    /// Observed utilization percent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub observed_utilization_pct: Option<f64>,
}

/// System inventory from a node descriptor.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeSystemInfo {
    /// Operating system.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub os: Option<NodeSystemOs>,
    /// CPU.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cpu: Option<NodeSystemCpu>,
    /// System memory in mebibytes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub memory_mb: Option<u64>,
    /// GPUs.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gpus: Option<Vec<NodeSystemGpu>>,
}

/// Runtime identity from a node descriptor.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeRuntime {
    /// Python version.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub python: Option<String>,
    /// Quip software version.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quip_version: Option<String>,
    /// Protocol version.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub protocol_version: Option<u32>,
    /// Whether the node reported running in Docker.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub in_docker: Option<bool>,
    /// Docker image name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub docker_image: Option<String>,
}

/// One miner entry inside a descriptor `miners` map.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeMinerEntry {
    /// Miner category.
    pub kind: MinerCategory,
    /// Miner identifier.
    pub miner_id: String,
    /// CPU worker count.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub num_cpus: Option<u32>,
    /// GPU backend name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub backend: Option<String>,
    /// GPU device index.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device_index: Option<u32>,
    /// GPU utilization.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub utilization: Option<f64>,
    /// QPU provider.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    /// QPU solver.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub solver: Option<String>,
    /// Daily budget text.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub daily_budget: Option<String>,
}

/// Geo-IP enrichment for a node's public host.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeLocation {
    /// ISO-3166 alpha-2 country code, or `??`.
    pub country: String,
    /// City name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub city: Option<String>,
    /// Latitude.
    pub lat: f64,
    /// Longitude.
    pub lng: f64,
}

/// Dashboard projection of one node.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeInfo {
    /// Node address.
    pub address: String,
    /// Status string.
    pub status: String,
    /// First-seen unix seconds.
    pub first_seen: u64,
    /// Last-seen unix seconds.
    pub last_seen: u64,
    /// Last heartbeat unix seconds.
    pub last_heartbeat: Option<u64>,
    /// ECDSA public key hex.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ecdsa_public_key_hex: Option<String>,
    /// Operator-published node name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub node_name: Option<String>,
    /// Public host.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub public_host: Option<String>,
    /// Public port.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub public_port: Option<u16>,
    /// Log level.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub log_level: Option<String>,
    /// Runtime identity.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime: Option<NodeRuntime>,
    /// Miner entries keyed by miner id.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub miners: Option<BTreeMap<String, NodeMinerEntry>>,
    /// System inventory.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub system_info: Option<NodeSystemInfo>,
    /// Geo-IP enrichment of `publicHost`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub location: Option<NodeLocation>,
}

/// Snapshot of network nodes projected from descriptors.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodesSnapshot {
    /// ISO 8601 snapshot time.
    pub updated_at: String,
    /// Number of known nodes.
    pub node_count: u32,
    /// Number of active nodes.
    pub active_count: u32,
    /// Nodes keyed by address.
    pub nodes: BTreeMap<String, NodeInfo>,
}

/// Schema identifier for a runtime-validated descriptor.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum NodeDescriptorSchema {
    /// Compact `quip.node_descriptor.v1` schema.
    #[serde(rename = "quip.node_descriptor.v1")]
    V1,
}

/// Runtime-validated descriptor emitted via `quip-miner identify`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeDescriptor {
    /// Schema identifier.
    pub schema: NodeDescriptorSchema,
    /// Descriptor version. Must be `1` for v1.
    pub descriptor_version: u8,
    /// Operator-published node name.
    pub node_name: String,
    /// Public host.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub public_host: Option<String>,
    /// Public port.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub public_port: Option<u16>,
    /// RPC endpoints.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rpc_endpoints: Option<Vec<String>>,
    /// Log level.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub log_level: Option<String>,
    /// Runtime identity.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime: Option<NodeRuntime>,
    /// Miner entries keyed by miner id.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub miners: Option<BTreeMap<String, NodeMinerEntry>>,
    /// System inventory.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub system_info: Option<NodeSystemInfo>,
}

/// Indexed descriptor row, one per chain account.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeDescriptorRecord {
    /// SS58 account id.
    pub account_id: String,
    /// Substrate block number as decimal.
    pub block_number: DecimalString,
    /// Block hash of the descriptor extrinsic.
    pub block_hash: BlockHash,
    /// Extrinsic index used by the upsert tie-breaker.
    pub extrinsic_index: u32,
    /// Block timestamp of the most recent descriptor.
    pub block_timestamp: u64,
    /// Block timestamp of the first observed descriptor.
    pub first_block_timestamp: u64,
    /// Validated descriptor payload.
    pub descriptor: NodeDescriptor,
    /// ISO 8601 time the indexer wrote the row.
    pub observed_at: String,
}
