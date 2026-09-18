create index if not exists idx_chain_miners_rewards on chain_miners(rewards_earned desc);
create index if not exists idx_miner_hardware_observed on miner_hardware(observed_at desc);
create index if not exists idx_node_descriptors_name on node_descriptors((coalesce(descriptor->>'nodeName', account_id)));
create index if not exists idx_mining_submissions_attempts on mining_submissions(miner_id) where attempt_count > 0;
