// SPDX-License-Identifier: AGPL-3.0-or-later
//! The public nodes document: stored descriptors projected for the client.

use crate::http::geo::GeoIp;
use dashboard_model::{NodeDescriptorRecord, NodeInfo, NodesSnapshot};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// The client-facing nodes document, written to `nodes/snapshot.json`.
///
/// `nodes` is a projection of `node_descriptors`, so the two travel
/// together in one file and the client fetches once.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodesDocument {
    /// Network nodes projected from descriptors, or `None` when there are none.
    pub nodes: Option<NodesSnapshot>,
    /// The descriptors the projection came from.
    pub node_descriptors: Vec<NodeDescriptorRecord>,
}

/// Project descriptors into the public document, resolving each public host
/// to a location. Returns no snapshot for an empty descriptor set.
async fn project(node_descriptors: Vec<NodeDescriptorRecord>, geo: &GeoIp) -> NodesDocument {
    let mut nodes: BTreeMap<String, NodeInfo> = BTreeMap::new();
    let mut updated_at = String::new();
    for record in &node_descriptors {
        let descriptor = &record.descriptor;
        let location = if let Some(host) = &descriptor.public_host {
            geo.lookup(host).await
        } else {
            None
        };
        let node = NodeInfo {
            address: record.account_id.clone(),
            status: "active".into(),
            first_seen: record.first_block_timestamp,
            last_seen: record.block_timestamp,
            last_heartbeat: None,
            ecdsa_public_key_hex: None,
            node_name: Some(descriptor.node_name.clone()),
            public_host: descriptor.public_host.clone(),
            public_port: descriptor.public_port,
            log_level: descriptor.log_level.clone(),
            runtime: descriptor.runtime.clone(),
            miners: descriptor.miners.clone(),
            system_info: descriptor.system_info.clone(),
            location,
        };
        let _ = nodes.insert(record.account_id.clone(), node);
        if record.observed_at > updated_at {
            updated_at.clone_from(&record.observed_at);
        }
    }
    // The old handler failed the request when the count exceeded u32. A
    // BTreeMap cannot hold that many entries on any supported target, so
    // saturating is equivalent and drops an error path this writer cannot use.
    let count = u32::try_from(nodes.len()).unwrap_or(u32::MAX);
    let snapshot = if nodes.is_empty() {
        None
    } else {
        Some(NodesSnapshot {
            updated_at,
            node_count: count,
            active_count: count,
            nodes,
        })
    };
    NodesDocument {
        nodes: snapshot,
        node_descriptors,
    }
}

/// Read descriptors and project them.
///
/// # Errors
/// Returns the store error from the descriptor read.
pub async fn build_nodes_document(
    store: &dashboard_store::Store,
    geo: &GeoIp,
) -> Result<NodesDocument, dashboard_store::StoreError> {
    Ok(project(store.get_all_node_descriptors().await?, geo).await)
}

/// Write the document to `nodes/snapshot.json`.
///
/// # Errors
/// Returns an I/O or serialization error, leaving no partial file.
pub async fn write_nodes_document(
    writer: &crate::indexer::file_writer::FileWriter,
    doc: &NodesDocument,
) -> std::io::Result<()> {
    let bytes = serde_json::to_vec(doc).map_err(std::io::Error::other)?;
    crate::qblock_path::atomic_write(
        &writer.root,
        std::path::Path::new("nodes/snapshot.json"),
        &bytes,
    )
    .await
}

#[cfg(test)]
mod tests {
    #![expect(
        clippy::unwrap_used,
        reason = "a test fixture asserts its own invariants before unwrapping"
    )]
    use super::*;

    fn descriptor_fixture(account: &str, public_host: Option<&str>) -> NodeDescriptorRecord {
        use dashboard_model::{BlockHash, DecimalString, NodeDescriptor, NodeDescriptorSchema};
        use std::str::FromStr;
        NodeDescriptorRecord {
            account_id: account.to_owned(),
            block_number: DecimalString::from_str("100").unwrap(),
            block_hash: BlockHash::from([1; 32]),
            extrinsic_index: 0,
            block_timestamp: 1_700_000_100,
            first_block_timestamp: 1_700_000_000,
            descriptor: NodeDescriptor {
                schema: NodeDescriptorSchema::V1,
                descriptor_version: 1,
                node_name: format!("node-{account}"),
                public_host: public_host.map(str::to_owned),
                public_port: None,
                rpc_endpoints: None,
                log_level: None,
                runtime: None,
                miners: None,
                system_info: None,
            },
            observed_at: "2026-09-20T00:00:00Z".to_owned(),
        }
    }

    /// A descriptor with no public host still projects a node, with no location.
    #[tokio::test]
    async fn a_descriptor_without_a_host_projects_a_node_without_a_location() {
        let geo = GeoIp::new(None);
        let records = vec![descriptor_fixture("5Grw", None)];
        let doc = project(records, &geo).await;
        let snapshot = doc.nodes.unwrap();
        assert_eq!(snapshot.node_count, 1);
        assert_eq!(snapshot.active_count, 1);
        let node = snapshot.nodes.get("5Grw").unwrap();
        assert!(node.location.is_none());
        assert_eq!(node.status, "active");
        assert_eq!(doc.node_descriptors.len(), 1);
    }

    /// An empty descriptor set yields no snapshot, matching the old handler.
    #[tokio::test]
    async fn no_descriptors_yields_no_snapshot() {
        let geo = GeoIp::new(None);
        let doc = project(Vec::new(), &geo).await;
        assert!(doc.nodes.is_none());
        assert!(doc.node_descriptors.is_empty());
    }

    /// The writer lands on the path telemetry advertises, in camelCase.
    #[tokio::test]
    async fn the_document_lands_at_the_advertised_path_in_camel_case() {
        let root = tempfile::tempdir().unwrap();
        let writer = crate::indexer::file_writer::FileWriter::new(root.path().to_path_buf());
        let geo = GeoIp::new(None);
        let doc = project(vec![descriptor_fixture("5Grw", None)], &geo).await;
        write_nodes_document(&writer, &doc).await.unwrap();
        let written = tokio::fs::read(root.path().join("nodes/snapshot.json"))
            .await
            .unwrap();
        let json: serde_json::Value = serde_json::from_slice(&written).unwrap();
        assert!(json.get("nodeDescriptors").is_some());
        assert_eq!(
            json.pointer("/nodes/nodes/5Grw/address"),
            Some(&serde_json::Value::from("5Grw"))
        );
        let parsed: NodesDocument = serde_json::from_slice(&written).unwrap();
        assert_eq!(parsed, doc);
    }
}
