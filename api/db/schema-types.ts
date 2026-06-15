// SPDX-License-Identifier: AGPL-3.0-or-later

// Kysely table types for the dashboard schema. Column value types are written
// permissively where the two backends genuinely return different JS shapes
// (BIGINT → string on postgres-js but number on sqlite; TIMESTAMPTZ → Date on
// postgres-js but string on sqlite; JSONB → object on postgres-js but TEXT
// string on sqlite). The shared row mappers normalise these to the domain types.

type Bool = number | boolean;
type Iso = string | Date;
type Json = unknown;
type Big = number | string;

export interface BlocksTable {
  block_hash: string;
  substrate_block_number: string;
  substrate_block_hash: string;
  substrate_parent_hash: string;
  timestamp: number;
  miner_id: string;
  energy: number;
  diversity: number;
  num_valid_solutions: number;
  mining_time: number;
  reward: string;
  nonce: string;
  num_nodes: number;
  num_edges: number;
  difficulty_energy: number;
  min_diversity: number;
  min_solutions: number;
  finalized: Bool;
}

export interface MetaTable {
  key: string;
  value: string | null;
}

export interface MinerHardwareTable {
  account_id: string;
  node_id: string;
  miners: Json;
  primary_type: string;
  source: string;
  observed_at: Iso;
}

export interface ChainHeadTable {
  id: number;
  best_block_number: string;
  best_block_hash: string;
  finalized_block_number: string;
  finalized_block_hash: string;
  finality_lag: number;
  winning_solutions_count: Big | null;
  spec_name: string;
  spec_version: number;
  transaction_version: number;
  impl_name: string;
  last_runtime_upgrade: string | null;
  updated_at: Iso;
}

export interface BabeEpochsTable {
  epoch_index: number;
  current_slot: string;
  epoch_start_slot: string;
  slots_per_epoch: number;
  current_slot_in_epoch: number;
  authority_count: number;
  is_current: Bool;
  updated_at: Iso;
}

export interface BabeAuthoritiesTable {
  account_id: string;
  epoch_index: number;
  display_name: string | null;
  is_active: Bool;
  updated_at: Iso;
}

export interface ChainMinersTable {
  account_id: string;
  deposit: string;
  proofs_submitted: string;
  proofs_won: string;
  rewards_earned: string;
  updated_at: Iso;
}

export interface DifficultyHistoryTable {
  observed_at_block: string;
  difficulty_energy: number;
  min_diversity: number;
  min_solutions: number;
  observed_at: Iso;
}

export interface ValidatorAuthorshipTable {
  account_id: string;
  blocks_authored: Big;
  blocks_authored_with_pow: Big;
  last_authored_block: string;
  last_authored_at: Iso;
}

export interface NodeDescriptorsTable {
  account_id: string;
  block_number: string;
  block_hash: string;
  extrinsic_index: number;
  block_timestamp: Big;
  first_block_timestamp: Big;
  descriptor: Json;
  observed_at: Iso;
}

export interface MiningSubmissionsTable {
  miner_id: string;
  solution_number: Big;
  ts_ns: string;
  energy_milli: Big;
  diversity_milli: Big;
  threshold_milli: Big;
  last_proof_block_hash: string;
  extrinsic_hash: string | null;
  chain_block_hash: string | null;
  chain_block_number: string | null;
  pow_sequence: Big | null;
  outcome: string;
  attempt_count: number;
  best_energy_milli: Big;
  num_valid: number;
  miner_type: string;
  qpu_access_time_us: Big;
  observed_at: Iso;
}

export interface DB {
  blocks: BlocksTable;
  meta: MetaTable;
  miner_hardware: MinerHardwareTable;
  chain_head: ChainHeadTable;
  babe_epochs: BabeEpochsTable;
  babe_authorities: BabeAuthoritiesTable;
  chain_miners: ChainMinersTable;
  difficulty_history: DifficultyHistoryTable;
  validator_authorship: ValidatorAuthorshipTable;
  node_descriptors: NodeDescriptorsTable;
  mining_submissions: MiningSubmissionsTable;
}
