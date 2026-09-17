create table if not exists qblock_participation (
        qblock_id numeric not null,
        account text not null,
        kind text not null,
        budget_seconds integer,
        block_number text not null,
        primary key (qblock_id, account)
      );
create index if not exists idx_qblock_participation_qblock
        on qblock_participation (qblock_id);
