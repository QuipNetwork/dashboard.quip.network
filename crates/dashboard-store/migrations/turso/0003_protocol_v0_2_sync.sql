alter table blocks add column qblock_id TEXT not null default 0;
alter table chain_head add column current_qblock_id TEXT;
alter table chain_head add column current_qblock_participants integer;
