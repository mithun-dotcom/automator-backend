-- Applied on every boot; every statement is idempotent.

CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL DEFAULT '',
  company       TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'client' CHECK (role IN ('client', 'admin')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Invite-only access: an invite link is the only way to create an account
-- (or to reset the password of an existing one).
CREATE TABLE IF NOT EXISTS invites (
  id          SERIAL PRIMARY KEY,
  email       TEXT NOT NULL,
  name        TEXT NOT NULL DEFAULT '',
  company     TEXT NOT NULL DEFAULT '',
  token       TEXT NOT NULL UNIQUE,
  expires_at  TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pricing (
  inbox_type        TEXT PRIMARY KEY,
  label             TEXT NOT NULL,
  price_per_mailbox NUMERIC(10,2) NOT NULL,
  sort_order        INT NOT NULL DEFAULT 0
);

INSERT INTO pricing (inbox_type, label, price_per_mailbox, sort_order) VALUES
  ('google_workspace', 'Google Workspace',          3.00, 1),
  ('azure',            'Azure',                     2.00, 2),
  ('m365_admin',       'Microsoft 365 (Admin)',     3.00, 3),
  ('m365_non_admin',   'Microsoft 365 (Non-Admin)', 2.50, 4)
ON CONFLICT (inbox_type) DO NOTHING;

-- One order = one "batch" of mailboxes, billed monthly.
CREATE TABLE IF NOT EXISTS orders (
  id                   SERIAL PRIMARY KEY,
  user_id              INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  inbox_type           TEXT NOT NULL REFERENCES pricing(inbox_type),
  quantity             INT NOT NULL CHECK (quantity > 0),
  price_per_mailbox    NUMERIC(10,2) NOT NULL,
  domains              TEXT NOT NULL,
  usernames            TEXT NOT NULL,
  domain_access_method TEXT NOT NULL,
  registrar            TEXT NOT NULL DEFAULT '',
  registrar_email      TEXT NOT NULL DEFAULT '',
  domain_access_notes  TEXT NOT NULL DEFAULT '',
  sequencer            TEXT NOT NULL,
  sequencer_workspace  TEXT NOT NULL DEFAULT '',
  sequencer_email      TEXT NOT NULL DEFAULT '',
  sequencer_notes      TEXT NOT NULL DEFAULT '',
  notes                TEXT NOT NULL DEFAULT '',
  admin_notes          TEXT NOT NULL DEFAULT '',
  status               TEXT NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'in_progress', 'active', 'cancelled')),
  activated_at         TIMESTAMPTZ,
  billing_day          INT CHECK (billing_day BETWEEN 1 AND 31),
  next_billing_date    DATE,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS invoices (
  id           SERIAL PRIMARY KEY,
  user_id      INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  order_id     INT REFERENCES orders(id) ON DELETE SET NULL,
  period_start DATE,
  description  TEXT NOT NULL,
  amount       NUMERIC(10,2) NOT NULL,
  due_date     DATE NOT NULL,
  status       TEXT NOT NULL DEFAULT 'unpaid' CHECK (status IN ('unpaid', 'paid', 'void')),
  paid_at      TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- At most one invoice per order per billing period.
CREATE UNIQUE INDEX IF NOT EXISTS invoices_order_period
  ON invoices (order_id, period_start) WHERE order_id IS NOT NULL AND period_start IS NOT NULL;

CREATE TABLE IF NOT EXISTS notifications (
  id         SERIAL PRIMARY KEY,
  user_id    INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title      TEXT NOT NULL,
  body       TEXT NOT NULL,
  read_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Makes the 7/3/1-day renewal reminders idempotent across restarts.
CREATE TABLE IF NOT EXISTS reminders_sent (
  order_id     INT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  billing_date DATE NOT NULL,
  days_before  INT NOT NULL,
  sent_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (order_id, billing_date, days_before)
);
