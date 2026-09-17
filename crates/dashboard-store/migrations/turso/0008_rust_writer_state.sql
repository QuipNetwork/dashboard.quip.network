CREATE TABLE IF NOT EXISTS dashboard_finalized (height TEXT PRIMARY KEY, hash TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS dashboard_scans (id TEXT PRIMARY KEY, genesis TEXT NOT NULL, at_hash TEXT NOT NULL, finalized_height TEXT NOT NULL, domain TEXT NOT NULL, generation TEXT NOT NULL, cursor TEXT, finished INTEGER NOT NULL DEFAULT FALSE);
CREATE TABLE IF NOT EXISTS dashboard_scan_winners (scan_id TEXT NOT NULL, height TEXT NOT NULL, PRIMARY KEY(scan_id,height));
CREATE TABLE IF NOT EXISTS dashboard_metadata (genesis TEXT NOT NULL,state_hash TEXT NOT NULL,spec_version TEXT NOT NULL,metadata_hash TEXT NOT NULL,metadata TEXT NOT NULL,PRIMARY KEY(genesis,state_hash));
CREATE INDEX IF NOT EXISTS idx_scan_winner_height ON dashboard_scan_winners(scan_id,length(height),height);
CREATE INDEX IF NOT EXISTS idx_blocks_qblock ON blocks(length(CAST(qblock_id AS TEXT)),qblock_id);
CREATE INDEX IF NOT EXISTS idx_finalized_height ON dashboard_finalized(length(height),height);
CREATE TABLE IF NOT EXISTS dashboard_poll_difficulty (observed_at_block TEXT PRIMARY KEY, difficulty_energy DOUBLE PRECISION NOT NULL, min_diversity DOUBLE PRECISION NOT NULL,min_solutions INTEGER NOT NULL,observed_at TEXT NOT NULL,topology_hash TEXT,source TEXT NOT NULL DEFAULT 'poll');

ALTER TABLE node_descriptors ADD COLUMN node_name TEXT;
UPDATE node_descriptors SET node_name=descriptor->>'nodeName';
CREATE INDEX IF NOT EXISTS idx_node_descriptors_typed_name ON node_descriptors(coalesce(node_name,account_id),account_id);
