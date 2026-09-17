CREATE TABLE IF NOT EXISTS blocks (
  block_hash text PRIMARY KEY,
  substrate_block_number TEXT NOT NULL,
  substrate_block_hash text NOT NULL,
  substrate_parent_hash text NOT NULL,
  timestamp INTEGER NOT NULL,
  miner_id text NOT NULL,
  energy double precision NOT NULL,
  diversity double precision NOT NULL,
  num_valid_solutions integer NOT NULL,
  mining_time double precision NOT NULL,
  reward TEXT NOT NULL,
  nonce TEXT NOT NULL,
  num_nodes integer NOT NULL,
  num_edges integer NOT NULL,
  difficulty_energy double precision NOT NULL,
  min_diversity double precision NOT NULL,
  min_solutions integer NOT NULL,
  finalized INTEGER NOT NULL DEFAULT false
);
CREATE TABLE IF NOT EXISTS miner_hardware (
  account_id text PRIMARY KEY,
  node_id text NOT NULL,
  miners TEXT NOT NULL,
  primary_type text NOT NULL,
  source text NOT NULL,
  observed_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (
  key text PRIMARY KEY,
  value text
);
CREATE TABLE IF NOT EXISTS chain_head (
  id integer PRIMARY KEY CHECK(id=1),
  best_block_number TEXT NOT NULL,
  best_block_hash text NOT NULL,
  finalized_block_number TEXT NOT NULL,
  finalized_block_hash text NOT NULL,
  finality_lag integer NOT NULL,
  winning_solutions_count TEXT,
  spec_name text NOT NULL,
  spec_version integer NOT NULL,
  transaction_version integer NOT NULL,
  impl_name text NOT NULL,
  last_runtime_upgrade TEXT,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS babe_epochs (
  epoch_index integer PRIMARY KEY,
  current_slot TEXT NOT NULL,
  epoch_start_slot TEXT NOT NULL,
  slots_per_epoch integer NOT NULL,
  current_slot_in_epoch integer NOT NULL,
  authority_count integer NOT NULL,
  is_current INTEGER NOT NULL DEFAULT false,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS babe_authorities (
  account_id text NOT NULL,
  epoch_index integer NOT NULL,
  display_name text,
  is_active INTEGER NOT NULL DEFAULT false,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (account_id, epoch_index)
);
CREATE TABLE IF NOT EXISTS chain_miners (
  account_id text PRIMARY KEY,
  deposit TEXT NOT NULL,
  proofs_submitted TEXT NOT NULL,
  proofs_won TEXT NOT NULL,
  rewards_earned TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS difficulty_history (
  observed_at_block TEXT PRIMARY KEY,
  difficulty_energy double precision NOT NULL,
  min_diversity double precision NOT NULL,
  min_solutions integer NOT NULL,
  observed_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS validator_authorship (
  account_id text PRIMARY KEY,
  blocks_authored INTEGER NOT NULL DEFAULT 0,
  blocks_authored_with_pow INTEGER NOT NULL DEFAULT 0,
  last_authored_block TEXT NOT NULL,
  last_authored_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS node_descriptors (
  account_id text PRIMARY KEY,
  block_number TEXT NOT NULL,
  block_hash text NOT NULL,
  extrinsic_index integer NOT NULL,
  block_timestamp INTEGER NOT NULL,
  first_block_timestamp INTEGER NOT NULL,
  descriptor TEXT NOT NULL,
  observed_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS mining_submissions (
  miner_id text NOT NULL,
  solution_number TEXT NOT NULL,
  ts_ns TEXT NOT NULL,
  energy_milli INTEGER NOT NULL,
  diversity_milli INTEGER NOT NULL,
  threshold_milli INTEGER NOT NULL,
  last_proof_block_hash text NOT NULL,
  extrinsic_hash text,
  chain_block_hash text,
  chain_block_number TEXT,
  pow_sequence TEXT,
  outcome text NOT NULL,
  attempt_count integer NOT NULL,
  best_energy_milli INTEGER NOT NULL,
  num_valid integer NOT NULL DEFAULT 0,
  miner_type text NOT NULL DEFAULT '',
  qpu_access_time_us TEXT NOT NULL DEFAULT 0,
  observed_at TEXT NOT NULL,
  PRIMARY KEY (miner_id, solution_number)
);
create index if not exists idx_blocks_substrate_number on blocks(length(substrate_block_number) desc,substrate_block_number desc);
create index if not exists idx_blocks_miner_id on blocks(miner_id, length(substrate_block_number) desc,substrate_block_number desc);
create index if not exists idx_blocks_timestamp on blocks(timestamp desc);
create index if not exists idx_babe_epochs_current on babe_epochs(is_current) where is_current;
create index if not exists idx_babe_authorities_active on babe_authorities(epoch_index, is_active);
create index if not exists idx_difficulty_history_observed on difficulty_history(observed_at desc);
create index if not exists idx_validator_authorship_authored on validator_authorship(blocks_authored desc);
create index if not exists idx_node_descriptors_block on node_descriptors(length(block_number) desc,block_number desc);
create index if not exists idx_mining_submissions_miner_recent on mining_submissions(miner_id, length(solution_number) desc,solution_number desc);
