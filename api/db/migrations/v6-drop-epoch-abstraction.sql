BEGIN;

-- Tables that no longer exist in v6
DROP TABLE IF EXISTS epoch_status;
DROP TABLE IF EXISTS nodes_snapshot;
-- Vestigial from earlier rebuilds; v6 stores self_address in `meta`
DROP TABLE IF EXISTS self_address;
-- Worker-state tables for the deleted tip/backfill cursors + nodes ETag tracking
DROP TABLE IF EXISTS indexer_cursors;
DROP TABLE IF EXISTS indexer_etags;

-- New: per-account hardware identity
CREATE TABLE IF NOT EXISTS miner_hardware (
  account_id    TEXT PRIMARY KEY,
  node_id       TEXT NOT NULL,
  miners        JSONB NOT NULL,
  primary_type  TEXT NOT NULL,
  source        TEXT NOT NULL,
  observed_at   TIMESTAMPTZ NOT NULL
);

-- blocks columns: add what v6 needs first (so the schema is forward-compatible
-- during the application's brief overlap), then drop legacy columns last.
ALTER TABLE blocks ADD COLUMN IF NOT EXISTS quality_milli INTEGER NOT NULL DEFAULT 0;
ALTER TABLE blocks ADD COLUMN IF NOT EXISTS reward NUMERIC NOT NULL DEFAULT 0;

-- v5 had substrate_* columns as nullable text (filled lazily by the substrate
-- worker). v6 makes them NOT NULL since the substrate worker is now the sole
-- writer and always populates them. Backfill any NULL legacy rows with sentinel
-- values so the constraint can be added without truncating history.
UPDATE blocks SET substrate_block_number = 0 WHERE substrate_block_number IS NULL;
UPDATE blocks SET substrate_block_hash = '' WHERE substrate_block_hash IS NULL;
UPDATE blocks SET substrate_parent_hash = '' WHERE substrate_parent_hash IS NULL;
ALTER TABLE blocks ALTER COLUMN substrate_block_number SET NOT NULL;
ALTER TABLE blocks ALTER COLUMN substrate_block_hash SET NOT NULL;
ALTER TABLE blocks ALTER COLUMN substrate_parent_hash SET NOT NULL;

-- Drop legacy columns whose data is no longer used.
ALTER TABLE blocks DROP COLUMN IF EXISTS epoch;
ALTER TABLE blocks DROP COLUMN IF EXISTS block_index;
ALTER TABLE blocks DROP COLUMN IF EXISTS miner_category;
ALTER TABLE blocks DROP COLUMN IF EXISTS ecdsa_public_key;
ALTER TABLE blocks DROP COLUMN IF EXISTS is_canonical;
ALTER TABLE blocks DROP COLUMN IF EXISTS extrinsics_root;
ALTER TABLE blocks DROP COLUMN IF EXISTS state_root;
ALTER TABLE blocks DROP COLUMN IF EXISTS previous_hash;

-- Rebuild PK: was (epoch, block_index); becomes (block_hash).
ALTER TABLE blocks DROP CONSTRAINT IF EXISTS blocks_pkey;
ALTER TABLE blocks ADD PRIMARY KEY (block_hash);

-- Rebuild indexes to match v6.
DROP INDEX IF EXISTS idx_blocks_canonical_ts;
DROP INDEX IF EXISTS idx_blocks_miner_energy;
DROP INDEX IF EXISTS idx_blocks_substrate_hash;
CREATE INDEX IF NOT EXISTS idx_blocks_substrate_number ON blocks(substrate_block_number DESC);
CREATE INDEX IF NOT EXISTS idx_blocks_miner_id ON blocks(miner_id, substrate_block_number DESC);
CREATE INDEX IF NOT EXISTS idx_blocks_timestamp ON blocks(timestamp DESC);

-- Mark migration complete.
UPDATE meta SET value = '6' WHERE key = 'schema_version';

COMMIT;
