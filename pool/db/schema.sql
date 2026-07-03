PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS workers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    addr TEXT NOT NULL,
    worker_name TEXT NOT NULL DEFAULT 'default',
    full_id TEXT NOT NULL UNIQUE,
    first_seen INTEGER NOT NULL,
    last_share_ts INTEGER,
    total_shares INTEGER NOT NULL DEFAULT 0,
    total_valid INTEGER NOT NULL DEFAULT 0,
    total_invalid INTEGER NOT NULL DEFAULT 0,
    current_diff REAL NOT NULL DEFAULT 1.0,
    is_banned INTEGER NOT NULL DEFAULT 0,
    notes TEXT
);
CREATE INDEX IF NOT EXISTS idx_workers_addr ON workers(addr);
CREATE INDEX IF NOT EXISTS idx_workers_last_share ON workers(last_share_ts);
CREATE TABLE IF NOT EXISTS shares (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    worker_id INTEGER NOT NULL,
    addr TEXT NOT NULL,
    job_id TEXT NOT NULL,
    nonce TEXT NOT NULL,
    extranonce2 TEXT NOT NULL,
    ntime INTEGER NOT NULL,
    share_diff REAL NOT NULL,
    is_valid INTEGER NOT NULL,
    is_block INTEGER NOT NULL DEFAULT 0,
    block_height INTEGER,
    reject_reason TEXT,
    submitted_at INTEGER NOT NULL,
    FOREIGN KEY (worker_id) REFERENCES workers(id)
);
CREATE INDEX IF NOT EXISTS idx_shares_addr_ts ON shares(addr, submitted_at);
CREATE INDEX IF NOT EXISTS idx_shares_valid_ts ON shares(is_valid, submitted_at);
CREATE INDEX IF NOT EXISTS idx_shares_block ON shares(is_block) WHERE is_block = 1;
CREATE INDEX IF NOT EXISTS idx_shares_worker_id ON shares(worker_id);
CREATE TABLE IF NOT EXISTS blocks_found (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    height INTEGER NOT NULL UNIQUE,
    block_hash TEXT NOT NULL,
    found_by_addr TEXT NOT NULL,
    reward_sats INTEGER NOT NULL,
    treasury_sats INTEGER NOT NULL,
    miners_sats INTEGER NOT NULL,
    total_shares_round INTEGER NOT NULL,
    coinbase_txid TEXT,
    is_distributed INTEGER NOT NULL DEFAULT 0,
    found_at INTEGER NOT NULL,
    distributed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_blocks_height ON blocks_found(height);
CREATE INDEX IF NOT EXISTS idx_blocks_distributed ON blocks_found(is_distributed);
CREATE TABLE IF NOT EXISTS pending_payouts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    addr TEXT NOT NULL UNIQUE,
    pending_sats INTEGER NOT NULL DEFAULT 0,
    last_block_credited INTEGER,
    updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pending_addr ON pending_payouts(addr);
CREATE TABLE IF NOT EXISTS paid_blocks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    block_height INTEGER NOT NULL,
    addr TEXT NOT NULL,
    paid_sats INTEGER NOT NULL,
    coinbase_txid TEXT NOT NULL,
    output_index INTEGER NOT NULL,
    paid_at INTEGER NOT NULL,
    FOREIGN KEY (block_height) REFERENCES blocks_found(height)
);
CREATE INDEX IF NOT EXISTS idx_paid_addr ON paid_blocks(addr);
CREATE INDEX IF NOT EXISTS idx_paid_block ON paid_blocks(block_height);
CREATE TABLE IF NOT EXISTS pool_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);
INSERT OR IGNORE INTO pool_meta (key, value, updated_at) VALUES
    ('schema_version','1',strftime('%s','now')),
    ('pool_fee_pct','5',strftime('%s','now')),
    ('pplns_window','2000',strftime('%s','now')),
    ('min_payout_sats','1000000',strftime('%s','now')),
    ('dust_threshold_sats','1000',strftime('%s','now')),
    ('max_outputs_coinbase','1500',strftime('%s','now')),
    ('vardiff_target_sec','20',strftime('%s','now')),
    ('vardiff_min','0.01',strftime('%s','now')),
    ('vardiff_max','1024',strftime('%s','now')),
    ('treasury_addr','bn1qqaqug3zac04c8mpnm8g6glgc4z4v39502xdans',strftime('%s','now'));
