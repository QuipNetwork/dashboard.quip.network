CREATE TABLE IF NOT EXISTS validator_authorship_blocks (
  validator text NOT NULL,
  block_number numeric NOT NULL,
  timestamp timestamptz NOT NULL,
  had_winner boolean NOT NULL,
  PRIMARY KEY (validator, block_number)
);
create index if not exists idx_vab_validator_winner
       on validator_authorship_blocks(validator, had_winner);
create index if not exists idx_vab_block
       on validator_authorship_blocks(block_number);
alter table difficulty_history
       add column if not exists source text not null default 'poll';
