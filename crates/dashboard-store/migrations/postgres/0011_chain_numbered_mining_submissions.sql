-- The miner files each solution under the last accepted qblock id, one below
-- the chain qblock the solution competes for. Earlier writers stored that
-- miner number; the dashboard now stores chain qblock ids. Shift every row up
-- by one. The first pass moves rows to negative temporaries so no two rows
-- share a key between passes.
UPDATE mining_submissions SET solution_number = -(solution_number + 1);
UPDATE mining_submissions SET solution_number = -solution_number;
