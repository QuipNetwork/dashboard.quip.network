-- SPDX-License-Identifier: AGPL-3.0-or-later
--
-- v4 → v5 forward migration (substrate-derived fields).
-- Targets quip-protocol-rs spec_version 101.
--
-- Idempotent: every statement uses IF NOT EXISTS / IF EXISTS / DO NOTHING
-- so a partial run followed by replay is safe. Run inside a transaction
-- so the schema_version bump and the structural changes commit together.
--
-- This script targets remote Postgres deployments (Supabase) where the
-- adapter's `drop on drift` path is disabled. SQLite users wipe
-- data/telemetry.db and let the adapter rebuild from SCHEMA_STATEMENTS.

BEGIN;

-- Block-level substrate fields (filled later by the substrate worker).
ALTER TABLE blocks ADD COLUMN IF NOT EXISTS substrate_block_number TEXT;
ALTER TABLE blocks ADD COLUMN IF NOT EXISTS substrate_block_hash TEXT;
ALTER TABLE blocks ADD COLUMN IF NOT EXISTS substrate_parent_hash TEXT;
ALTER TABLE blocks ADD COLUMN IF NOT EXISTS extrinsics_root TEXT;
ALTER TABLE blocks ADD COLUMN IF NOT EXISTS state_root TEXT;
ALTER TABLE blocks ADD COLUMN IF NOT EXISTS finalized BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE blocks ADD COLUMN IF NOT EXISTS is_canonical BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE epoch_status ADD COLUMN IF NOT EXISTS chain_anchor TEXT;

CREATE TABLE IF NOT EXISTS chain_head (
  id                      INTEGER PRIMARY KEY CHECK (id = 1),
  best_block_number       NUMERIC NOT NULL,
  best_block_hash         TEXT NOT NULL,
  finalized_block_number  NUMERIC NOT NULL,
  finalized_block_hash    TEXT NOT NULL,
  finality_lag            INTEGER NOT NULL,
  spec_name               TEXT NOT NULL,
  spec_version            INTEGER NOT NULL,
  transaction_version     INTEGER NOT NULL,
  impl_name               TEXT NOT NULL,
  last_runtime_upgrade    NUMERIC,
  updated_at              TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS babe_epochs (
  epoch_index             INTEGER PRIMARY KEY,
  current_slot            NUMERIC NOT NULL,
  epoch_start_slot        NUMERIC NOT NULL,
  slots_per_epoch         INTEGER NOT NULL,
  current_slot_in_epoch   INTEGER NOT NULL,
  authority_count         INTEGER NOT NULL,
  is_current              BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at              TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_babe_epochs_current
  ON babe_epochs(is_current) WHERE is_current;

CREATE TABLE IF NOT EXISTS babe_authorities (
  account_id    TEXT NOT NULL,
  epoch_index   INTEGER NOT NULL,
  display_name  TEXT,
  is_active     BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at    TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (account_id, epoch_index)
);
CREATE INDEX IF NOT EXISTS idx_babe_authorities_active
  ON babe_authorities(epoch_index, is_active);

CREATE TABLE IF NOT EXISTS chain_miners (
  account_id        TEXT PRIMARY KEY,
  deposit           NUMERIC NOT NULL,
  proofs_submitted  NUMERIC NOT NULL,
  proofs_won        NUMERIC NOT NULL,
  rewards_earned    NUMERIC NOT NULL,
  updated_at        TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS difficulty_history (
  observed_at_block  NUMERIC PRIMARY KEY,
  difficulty_energy  DOUBLE PRECISION NOT NULL,
  min_diversity      DOUBLE PRECISION NOT NULL,
  min_solutions      INTEGER NOT NULL,
  observed_at        TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_difficulty_history_observed
  ON difficulty_history(observed_at DESC);

-- Block indexes added in v5. The miner-energy composite supports the
-- substrate worker's BlockWinner-event correlation join.
CREATE INDEX IF NOT EXISTS idx_blocks_canonical_ts ON blocks(is_canonical, timestamp);
CREATE INDEX IF NOT EXISTS idx_blocks_finalized ON blocks(finalized) WHERE finalized;
CREATE INDEX IF NOT EXISTS idx_blocks_substrate_hash ON blocks(substrate_block_hash);
CREATE INDEX IF NOT EXISTS idx_blocks_substrate_number ON blocks(substrate_block_number);
CREATE INDEX IF NOT EXISTS idx_blocks_miner_energy ON blocks(miner_id, energy, timestamp DESC);

-- Backfill: stale_fork epochs that existed before v5 must have their
-- blocks flagged is_canonical=FALSE so default reads (audit fix #5) hide
-- them. New writes get is_canonical=TRUE from the column default.
UPDATE blocks SET is_canonical = FALSE
WHERE epoch IN (SELECT epoch FROM epoch_status WHERE status = 'stale_fork');

-- Sweep the vestigial v4 leftover table.
DROP TABLE IF EXISTS indexer_state CASCADE;

-- Stamp the new version.
INSERT INTO meta (key, value) VALUES ('schema_version', '5')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

COMMIT;
