-- Poll snapshots were written once per block. Keep only the rows where the
-- polled difficulty or topology changed from the previous poll row, which is
-- what the poller now writes.
CREATE INDEX IF NOT EXISTS idx_poll_difficulty_observed ON dashboard_poll_difficulty(observed_at);
DELETE FROM difficulty_history
WHERE source = 'poll'
  AND EXISTS (
    SELECT 1 FROM difficulty_history prev
    WHERE prev.observed_at_block = (
        SELECT p.observed_at_block FROM difficulty_history p
        WHERE p.source = 'poll' AND p.observed_at < difficulty_history.observed_at
        ORDER BY p.observed_at DESC LIMIT 1)
      AND prev.difficulty_energy = difficulty_history.difficulty_energy
      AND prev.min_diversity = difficulty_history.min_diversity
      AND prev.min_solutions = difficulty_history.min_solutions
      AND prev.topology_hash IS difficulty_history.topology_hash);
DELETE FROM dashboard_poll_difficulty
WHERE EXISTS (
    SELECT 1 FROM dashboard_poll_difficulty prev
    WHERE prev.observed_at_block = (
        SELECT p.observed_at_block FROM dashboard_poll_difficulty p
        WHERE p.observed_at < dashboard_poll_difficulty.observed_at
        ORDER BY p.observed_at DESC LIMIT 1)
      AND prev.difficulty_energy = dashboard_poll_difficulty.difficulty_energy
      AND prev.min_diversity = dashboard_poll_difficulty.min_diversity
      AND prev.min_solutions = dashboard_poll_difficulty.min_solutions
      AND prev.topology_hash IS dashboard_poll_difficulty.topology_hash);
