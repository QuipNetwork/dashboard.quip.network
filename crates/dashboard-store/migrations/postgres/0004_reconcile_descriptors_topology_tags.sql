DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='node_descriptors' AND column_name='block_hash') THEN DROP TABLE IF EXISTS node_descriptors;
CREATE TABLE IF NOT EXISTS node_descriptors (
  account_id text PRIMARY KEY,
  block_number numeric NOT NULL,
  block_hash text NOT NULL,
  extrinsic_index integer NOT NULL,
  block_timestamp bigint NOT NULL,
  first_block_timestamp bigint NOT NULL,
  descriptor jsonb NOT NULL,
  observed_at timestamptz NOT NULL
); CREATE INDEX idx_node_descriptors_block ON node_descriptors(block_number DESC); CREATE INDEX idx_node_descriptors_name ON node_descriptors((coalesce(descriptor->>'nodeName',account_id))); END IF; END $$;
alter table blocks add column if not exists topology_hash text;
alter table difficulty_history add column if not exists topology_hash text;
