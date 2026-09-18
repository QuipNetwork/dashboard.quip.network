CREATE TABLE IF NOT EXISTS dashboard_unavailable (
    domain TEXT NOT NULL,
    generation TEXT NOT NULL,
    height TEXT NOT NULL,
    block_hash TEXT NOT NULL,
    enrichment_hash TEXT NOT NULL,
    reason TEXT NOT NULL,
    observed_at TEXT NOT NULL,
    next_height TEXT,
    PRIMARY KEY (domain, generation, height),
    CHECK (domain IN ('winners', 'difficulty')),
    CHECK (reason IN ('missing_retained_nonce', 'missing_retained_difficulty'))
);
CREATE INDEX IF NOT EXISTS idx_unavailable_height ON dashboard_unavailable(domain, generation, length(height), height);
CREATE INDEX IF NOT EXISTS idx_unavailable_next ON dashboard_unavailable(domain, generation, length(next_height), next_height);
