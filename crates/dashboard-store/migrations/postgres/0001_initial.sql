DROP TABLE IF EXISTS epoch_status CASCADE;
DROP TABLE IF EXISTS nodes_snapshot CASCADE;
DROP TABLE IF EXISTS self_address CASCADE;
DROP TABLE IF EXISTS indexer_cursors CASCADE;
DROP TABLE IF EXISTS indexer_etags CASCADE;
DROP TABLE IF EXISTS proof_attempts CASCADE;
DROP TABLE IF EXISTS indexer_state CASCADE;
CREATE TABLE IF NOT EXISTS blocks (
  block_hash text PRIMARY KEY,
  substrate_block_number numeric NOT NULL,
  substrate_block_hash text NOT NULL,
  substrate_parent_hash text NOT NULL,
  timestamp bigint NOT NULL,
  miner_id text NOT NULL,
  energy double precision NOT NULL,
  diversity double precision NOT NULL,
  num_valid_solutions integer NOT NULL,
  mining_time double precision NOT NULL,
  reward numeric NOT NULL,
  nonce numeric NOT NULL,
  num_nodes integer NOT NULL,
  num_edges integer NOT NULL,
  difficulty_energy double precision NOT NULL,
  min_diversity double precision NOT NULL,
  min_solutions integer NOT NULL,
  finalized boolean NOT NULL DEFAULT false
);
CREATE TABLE IF NOT EXISTS miner_hardware (
  account_id text PRIMARY KEY,
  node_id text NOT NULL,
  miners jsonb NOT NULL,
  primary_type text NOT NULL,
  source text NOT NULL,
  observed_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (
  key text PRIMARY KEY,
  value text
);
CREATE TABLE IF NOT EXISTS chain_head (
  id integer PRIMARY KEY CHECK(id=1),
  best_block_number numeric NOT NULL,
  best_block_hash text NOT NULL,
  finalized_block_number numeric NOT NULL,
  finalized_block_hash text NOT NULL,
  finality_lag integer NOT NULL,
  winning_solutions_count bigint,
  spec_name text NOT NULL,
  spec_version integer NOT NULL,
  transaction_version integer NOT NULL,
  impl_name text NOT NULL,
  last_runtime_upgrade numeric,
  updated_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS babe_epochs (
  epoch_index integer PRIMARY KEY,
  current_slot numeric NOT NULL,
  epoch_start_slot numeric NOT NULL,
  slots_per_epoch integer NOT NULL,
  current_slot_in_epoch integer NOT NULL,
  authority_count integer NOT NULL,
  is_current boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS babe_authorities (
  account_id text NOT NULL,
  epoch_index integer NOT NULL,
  display_name text,
  is_active boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (account_id, epoch_index)
);
CREATE TABLE IF NOT EXISTS chain_miners (
  account_id text PRIMARY KEY,
  deposit numeric NOT NULL,
  proofs_submitted numeric NOT NULL,
  proofs_won numeric NOT NULL,
  rewards_earned numeric NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS difficulty_history (
  observed_at_block numeric PRIMARY KEY,
  difficulty_energy double precision NOT NULL,
  min_diversity double precision NOT NULL,
  min_solutions integer NOT NULL,
  observed_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS validator_authorship (
  account_id text PRIMARY KEY,
  blocks_authored bigint NOT NULL DEFAULT 0,
  blocks_authored_with_pow bigint NOT NULL DEFAULT 0,
  last_authored_block numeric NOT NULL,
  last_authored_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS node_descriptors (
  account_id text PRIMARY KEY,
  block_number numeric NOT NULL,
  block_hash text NOT NULL,
  extrinsic_index integer NOT NULL,
  block_timestamp bigint NOT NULL,
  first_block_timestamp bigint NOT NULL,
  descriptor jsonb NOT NULL,
  observed_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS mining_submissions (
  miner_id text NOT NULL,
  solution_number bigint NOT NULL,
  ts_ns numeric NOT NULL,
  energy_milli bigint NOT NULL,
  diversity_milli bigint NOT NULL,
  threshold_milli bigint NOT NULL,
  last_proof_block_hash text NOT NULL,
  extrinsic_hash text,
  chain_block_hash text,
  chain_block_number numeric,
  pow_sequence bigint,
  outcome text NOT NULL,
  attempt_count integer NOT NULL,
  best_energy_milli bigint NOT NULL,
  num_valid integer NOT NULL DEFAULT 0,
  miner_type text NOT NULL DEFAULT '',
  qpu_access_time_us bigint NOT NULL DEFAULT 0,
  observed_at timestamptz NOT NULL,
  PRIMARY KEY (miner_id, solution_number)
);
create index if not exists idx_blocks_substrate_number on blocks(substrate_block_number desc);
create index if not exists idx_blocks_miner_id on blocks(miner_id, substrate_block_number desc);
create index if not exists idx_blocks_timestamp on blocks(timestamp desc);
create index if not exists idx_babe_epochs_current on babe_epochs(is_current) where is_current;
create index if not exists idx_babe_authorities_active on babe_authorities(epoch_index, is_active);
create index if not exists idx_difficulty_history_observed on difficulty_history(observed_at desc);
create index if not exists idx_validator_authorship_authored on validator_authorship(blocks_authored desc);
create index if not exists idx_node_descriptors_block on node_descriptors(block_number desc);
create index if not exists idx_mining_submissions_miner_recent on mining_submissions(miner_id, solution_number desc);
