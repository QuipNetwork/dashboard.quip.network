CREATE TABLE IF NOT EXISTS dashboard_finalized (height TEXT PRIMARY KEY, hash TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS dashboard_scans (id TEXT PRIMARY KEY, genesis TEXT NOT NULL, at_hash TEXT NOT NULL, finalized_height TEXT NOT NULL, domain TEXT NOT NULL, generation TEXT NOT NULL, cursor TEXT, finished BOOLEAN NOT NULL DEFAULT FALSE);
CREATE TABLE IF NOT EXISTS dashboard_scan_winners (scan_id TEXT NOT NULL, height TEXT NOT NULL, PRIMARY KEY(scan_id,height));
CREATE TABLE IF NOT EXISTS dashboard_metadata (genesis TEXT NOT NULL,state_hash TEXT NOT NULL,spec_version TEXT NOT NULL,metadata_hash TEXT NOT NULL,metadata TEXT NOT NULL,PRIMARY KEY(genesis,state_hash));
CREATE INDEX IF NOT EXISTS idx_scan_winner_height ON dashboard_scan_winners(scan_id,length(height),height);
CREATE INDEX IF NOT EXISTS idx_blocks_qblock ON blocks(qblock_id);
CREATE INDEX IF NOT EXISTS idx_finalized_height ON dashboard_finalized(length(height),height);
CREATE TABLE IF NOT EXISTS dashboard_poll_difficulty (observed_at_block NUMERIC PRIMARY KEY, difficulty_energy DOUBLE PRECISION NOT NULL, min_diversity DOUBLE PRECISION NOT NULL,min_solutions INTEGER NOT NULL,observed_at TIMESTAMPTZ NOT NULL,topology_hash TEXT,source TEXT NOT NULL DEFAULT 'poll');

ALTER TABLE blocks ALTER COLUMN device_access_time_us TYPE NUMERIC;
ALTER TABLE mining_submissions ALTER COLUMN solution_number TYPE NUMERIC;
ALTER TABLE mining_submissions ALTER COLUMN pow_sequence TYPE NUMERIC;
ALTER TABLE mining_submissions ALTER COLUMN qpu_access_time_us TYPE NUMERIC;
ALTER TABLE chain_head ALTER COLUMN winning_solutions_count TYPE NUMERIC;

ALTER TABLE node_descriptors ADD COLUMN IF NOT EXISTS node_name TEXT;
UPDATE node_descriptors SET node_name=descriptor->>'nodeName';
CREATE INDEX IF NOT EXISTS idx_node_descriptors_typed_name ON node_descriptors(coalesce(node_name,account_id),account_id);

-- One summary row per winning miner, kept current by the winner writer.
CREATE TABLE IF NOT EXISTS node_summary (miner_id TEXT PRIMARY KEY, wins BIGINT NOT NULL, best_energy DOUBLE PRECISION NOT NULL, avg_mining_time DOUBLE PRECISION NOT NULL, last_won_at BIGINT NOT NULL, last_won_qblock_id NUMERIC NOT NULL, last_won_block_hash TEXT NOT NULL);
INSERT INTO node_summary(miner_id,wins,best_energy,avg_mining_time,last_won_at,last_won_qblock_id,last_won_block_hash)
SELECT a.miner_id,a.wins,a.best_energy,a.avg_mining_time,a.last_won_at,l.qblock_id,l.block_hash
FROM (SELECT miner_id,COUNT(*) AS wins,MIN(energy) AS best_energy,AVG(mining_time) AS avg_mining_time,MAX(timestamp) AS last_won_at FROM blocks GROUP BY miner_id) a
JOIN blocks l ON l.block_hash=(SELECT x.block_hash FROM blocks x WHERE x.miner_id=a.miner_id ORDER BY x.qblock_id DESC,x.block_hash DESC LIMIT 1);
