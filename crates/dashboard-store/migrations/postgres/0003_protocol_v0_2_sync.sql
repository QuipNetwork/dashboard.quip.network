alter table blocks add column if not exists qblock_id numeric not null default 0;
alter table chain_head add column if not exists current_qblock_id numeric;
alter table chain_head add column if not exists current_qblock_participants integer;
