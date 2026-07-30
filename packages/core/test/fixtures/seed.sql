-- Seed data for query-not's integration tests.
--
-- Shaped to produce the plan pathologies the analyzer claims to detect, so the
-- tests run against real EXPLAIN output rather than hand-written JSON that
-- happens to agree with the parser.
--
--   * skewed `status` (97% 'complete') → selective filter, missing-index shape
--   * correlated (country, currency)   → cardinality misestimate the planner
--                                        cannot see with per-column statistics
--   * wide-ish rows + no index         → sequential scans that discard most reads

DROP TABLE IF EXISTS promotions CASCADE;
DROP TABLE IF EXISTS order_items CASCADE;
DROP TABLE IF EXISTS orders CASCADE;
DROP TABLE IF EXISTS customers CASCADE;

CREATE TABLE customers (
    id           bigserial PRIMARY KEY,
    email        text NOT NULL,
    country      text NOT NULL,
    currency     text NOT NULL,
    signed_up_at timestamptz NOT NULL
);

CREATE TABLE orders (
    id          bigserial PRIMARY KEY,
    customer_id bigint NOT NULL,
    status      text NOT NULL,
    total_cents bigint NOT NULL,
    created_at  timestamptz NOT NULL,
    note        text
);

CREATE TABLE order_items (
    id       bigserial PRIMARY KEY,
    order_id bigint NOT NULL,
    sku      text NOT NULL,
    qty      int NOT NULL
);

-- 50k customers. country and currency are perfectly correlated, which
-- per-column statistics cannot represent — this is what CREATE STATISTICS exists
-- for, and what produces a misestimate when both appear in a predicate.
INSERT INTO customers (email, country, currency, signed_up_at)
SELECT
    'user' || g || '@example.com',
    c.country,
    c.currency,
    now() - (g % 900) * interval '1 day'
FROM generate_series(1, 50000) g
CROSS JOIN LATERAL (
    SELECT
        (ARRAY['US','GB','DE','JP','SG'])[1 + (g % 5)] AS country,
        (ARRAY['USD','GBP','EUR','JPY','SGD'])[1 + (g % 5)] AS currency
) c;

-- 400k orders, status heavily skewed: ~97% 'complete'.
INSERT INTO orders (customer_id, status, total_cents, created_at, note)
SELECT
    1 + (g % 50000),
    CASE
        WHEN g % 1000 < 970 THEN 'complete'
        WHEN g % 1000 < 990 THEN 'pending'
        WHEN g % 1000 < 998 THEN 'refunded'
        ELSE 'disputed'
    END,
    (g * 37) % 500000,
    now() - (g % 720) * interval '1 hour',
    repeat('x', 40)
FROM generate_series(1, 400000) g;

INSERT INTO order_items (order_id, sku, qty)
SELECT
    1 + (g % 400000),
    'SKU-' || (g % 5000),
    1 + (g % 4)
FROM generate_series(1, 800000) g;

-- Deliberately minimal indexing: the point is for the tool to find what's missing.
CREATE INDEX ON order_items (order_id);

-- A table with a genuinely nullable column, so the NOT IN → NOT EXISTS
-- precondition check has something real to refuse: ~2% of order_id is NULL,
-- which is exactly the case where the two forms return different rows.
-- applied_at is NOT NULL and indexed, so the date() range rewrite has an index
-- to win with.
CREATE TABLE promotions (
    id         bigserial PRIMARY KEY,
    order_id   bigint,
    applied_at timestamp NOT NULL
);

INSERT INTO promotions (order_id, applied_at)
SELECT
    CASE WHEN g % 50 = 0 THEN NULL ELSE 1 + (g * 7) % 400000 END,
    now() - (g % 400) * interval '1 day'
FROM generate_series(1, 200000) g;

CREATE INDEX ON promotions (applied_at);

ANALYZE customers;
ANALYZE orders;
ANALYZE order_items;
ANALYZE promotions;
