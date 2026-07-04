-- HMS Phase 1 schema (mileage core)
-- Ledger-based balances, multi-tenant by family_id.

CREATE SCHEMA IF NOT EXISTS hms;
SET search_path TO hms;

CREATE TABLE IF NOT EXISTS family (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS app_user (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  family_id     BIGINT NOT NULL REFERENCES family(id),
  login_id      TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('parent','child','super_admin')),
  secret_hash   TEXT NOT NULL,
  balance_cache INTEGER NOT NULL DEFAULT 0,
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_app_user_family ON app_user(family_id);

CREATE TABLE IF NOT EXISTS telegram_link (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  family_id      BIGINT NOT NULL REFERENCES family(id),
  parent_user_id BIGINT REFERENCES app_user(id),
  chat_id        TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_telegram_link_family ON telegram_link(family_id);

CREATE TABLE IF NOT EXISTS earn_catalog (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  family_id      BIGINT NOT NULL REFERENCES family(id),
  name           TEXT NOT NULL,
  points         INTEGER NOT NULL CHECK (points > 0),
  proof_required BOOLEAN NOT NULL DEFAULT FALSE,
  active         BOOLEAN NOT NULL DEFAULT TRUE,
  sort           INTEGER NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_earn_catalog_family ON earn_catalog(family_id);

CREATE TABLE IF NOT EXISTS spend_catalog (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  family_id    BIGINT NOT NULL REFERENCES family(id),
  name         TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('time_voucher','cash')),
  unit_minutes INTEGER CHECK (unit_minutes IS NULL OR unit_minutes > 0),
  unit_label   TEXT,
  price_points INTEGER NOT NULL CHECK (price_points > 0),
  active       BOOLEAN NOT NULL DEFAULT TRUE,
  sort         INTEGER NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (kind <> 'time_voucher' OR unit_minutes IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_spend_catalog_family ON spend_catalog(family_id);

CREATE TABLE IF NOT EXISTS earn_request (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  family_id   BIGINT NOT NULL REFERENCES family(id),
  user_id     BIGINT NOT NULL REFERENCES app_user(id),
  catalog_id  BIGINT NOT NULL REFERENCES earn_catalog(id),
  points      INTEGER NOT NULL CHECK (points > 0),
  comment     TEXT,
  proof_path  TEXT,
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  decided_by  BIGINT REFERENCES app_user(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_earn_request_family_status ON earn_request(family_id, status);
CREATE INDEX IF NOT EXISTS idx_earn_request_user ON earn_request(user_id);

CREATE TABLE IF NOT EXISTS spend_order (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  family_id    BIGINT NOT NULL REFERENCES family(id),
  user_id      BIGINT NOT NULL REFERENCES app_user(id),
  catalog_id   BIGINT NOT NULL REFERENCES spend_catalog(id),
  kind         TEXT NOT NULL CHECK (kind IN ('time_voucher','cash')),
  qty          INTEGER NOT NULL CHECK (qty > 0),
  total_points INTEGER NOT NULL CHECK (total_points > 0),
  status       TEXT NOT NULL CHECK (status IN ('fulfilled','payout_pending','settled')),
  settled_by   BIGINT REFERENCES app_user(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  settled_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_spend_order_family_status ON spend_order(family_id, status);
CREATE INDEX IF NOT EXISTS idx_spend_order_user ON spend_order(user_id);

CREATE TABLE IF NOT EXISTS voucher (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  family_id         BIGINT NOT NULL REFERENCES family(id),
  order_id          BIGINT NOT NULL REFERENCES spend_order(id),
  user_id           BIGINT NOT NULL REFERENCES app_user(id),
  catalog_id        BIGINT NOT NULL REFERENCES spend_catalog(id),
  label             TEXT NOT NULL,
  total_minutes     INTEGER NOT NULL CHECK (total_minutes > 0),
  remaining_minutes INTEGER NOT NULL CHECK (remaining_minutes >= 0),
  status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','consumed','expired')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_voucher_user_status ON voucher(user_id, status);

CREATE TABLE IF NOT EXISTS voucher_usage (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  voucher_id   BIGINT NOT NULL REFERENCES voucher(id),
  used_minutes INTEGER NOT NULL CHECK (used_minutes > 0),
  used_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_voucher_usage_voucher ON voucher_usage(voucher_id);

CREATE TABLE IF NOT EXISTS ledger_entry (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  family_id   BIGINT NOT NULL REFERENCES family(id),
  user_id     BIGINT NOT NULL REFERENCES app_user(id),
  amount      INTEGER NOT NULL CHECK (amount <> 0),
  source_type TEXT NOT NULL CHECK (source_type IN ('earn','spend','adjust')),
  source_id   BIGINT,
  memo        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ledger_user ON ledger_entry(user_id, created_at DESC);
