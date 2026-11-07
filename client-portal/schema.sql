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

-- Per-client price overrides. A missing row means the client pays the
-- standard price from `pricing`.
CREATE TABLE IF NOT EXISTS client_pricing (
  user_id           INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  inbox_type        TEXT NOT NULL REFERENCES pricing(inbox_type),
  price_per_mailbox NUMERIC(10,2) NOT NULL CHECK (price_per_mailbox >= 0),
  PRIMARY KEY (user_id, inbox_type)
);

-- Fully editable invoices: header fields plus any number of line items.
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS issue_date DATE;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS discount NUMERIC(10,2) NOT NULL DEFAULT 0;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS notes TEXT NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS invoice_items (
  id          SERIAL PRIMARY KEY,
  invoice_id  INT NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  inbox_type  TEXT NOT NULL DEFAULT '',  -- a pricing.inbox_type, 'other', or '' for none
  batch_name  TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  quantity    NUMERIC(10,2) NOT NULL CHECK (quantity > 0),
  unit_price  NUMERIC(10,2) NOT NULL CHECK (unit_price >= 0),
  sort_order  INT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS invoice_items_invoice ON invoice_items (invoice_id);

-- Admin-editable settings (key/value). Missing keys fall back to defaults in code.
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- The onboarding CSV uploaded with an order, AES-256-GCM encrypted (it holds passwords).
CREATE TABLE IF NOT EXISTS order_files (
  order_id   INT PRIMARY KEY REFERENCES orders(id) ON DELETE CASCADE,
  filename   TEXT NOT NULL,
  row_count  INT NOT NULL,
  data       BYTEA NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Clients the admin adds before inviting them (to load existing batches and
-- billing) have no usable password until they accept their invite.
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_set BOOLEAN NOT NULL DEFAULT true;
-- Optional human name for a batch, e.g. "Q4 outreach".
ALTER TABLE orders ADD COLUMN IF NOT EXISTS batch_name TEXT NOT NULL DEFAULT '';

-- Billing cycle in months: 1 = monthly, 12 = yearly, anything else = custom.
-- Prices stay per mailbox per month; each invoice covers the whole cycle.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS billing_months INT NOT NULL DEFAULT 1;

-- "Other" products (anything that isn't a mailbox type). Hidden from client
-- ordering and standard pricing; used for recurring Other invoice lines that
-- become batches.
INSERT INTO pricing (inbox_type, label, price_per_mailbox, sort_order)
VALUES ('other', 'Other', 0, 99) ON CONFLICT (inbox_type) DO NOTHING;
-- An "Other" invoice line marked recurring becomes a batch; unmarked lines are one-off charges.
ALTER TABLE invoice_items ADD COLUMN IF NOT EXISTS recurring BOOLEAN NOT NULL DEFAULT false;

-- Team members ("staff") use the admin panel; the owner ("admin") also manages
-- the team and settings.
-- (Resellers, added later, are allowed here too: this runs on every boot,
-- before the reseller section below, and must accept existing reseller rows.)
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('client', 'admin', 'staff', 'reseller'));
ALTER TABLE invites ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'client';

-- Every admin-panel change: who, what, and the before/after of each field.
CREATE TABLE IF NOT EXISTS audit_log (
  id          SERIAL PRIMARY KEY,
  actor_id    INT,
  actor_name  TEXT NOT NULL DEFAULT '',
  actor_email TEXT NOT NULL DEFAULT '',
  actor_role  TEXT NOT NULL DEFAULT '',
  action      TEXT NOT NULL,
  title       TEXT NOT NULL,
  changes     JSONB NOT NULL DEFAULT '[]',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_log_created ON audit_log (created_at DESC);

-- Admin-managed mailbox types: hidden types stay valid for existing batches
-- but aren't offered to clients; description is shown on the order page.
ALTER TABLE pricing ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE pricing ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT '';
UPDATE pricing SET description = CASE inbox_type
    WHEN 'google_workspace' THEN 'Google Workspace mailboxes set up on your domains.'
    WHEN 'azure' THEN 'Microsoft mailboxes provisioned through an Azure tenant.'
    WHEN 'm365_admin' THEN 'Microsoft 365 mailboxes, with admin access to the tenant.'
    WHEN 'm365_non_admin' THEN 'Microsoft 365 mailboxes, without tenant admin access.'
    ELSE description END
  WHERE description = '';

-- When a batch was cancelled, so Analytics can tell what was active in past
-- months. Batches cancelled before this column existed have no record of the
-- date; they're treated as never having been active.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;
UPDATE orders SET cancelled_at = COALESCE(activated_at, created_at)
  WHERE status = 'cancelled' AND cancelled_at IS NULL;

-- The invoice a batch was created from, so re-saving that invoice updates its
-- recurring "Other" batches instead of adding them again.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS from_invoice_id INT REFERENCES invoices(id) ON DELETE SET NULL;

-- When an admin last emailed the invoice to the client (Send invoice button).
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS sent_at TIMESTAMPTZ;

-- Who made the sale (for commission). Admin-only; never sent to clients.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS sold_by TEXT NOT NULL DEFAULT '';
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS sold_by TEXT NOT NULL DEFAULT '';
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS urgent_sent_at TIMESTAMPTZ;

-- Resellers: partners who manage their own clients' billing in the portal.
-- Their clients are ordinary client rows with reseller_id set; they don't log
-- in. White-label (set by the owner) brands those clients' emails and invoices
-- with the reseller's name, logo, sender and payment details.
ALTER TABLE users ADD COLUMN IF NOT EXISTS reseller_id INT REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS users_reseller ON users (reseller_id);

CREATE TABLE IF NOT EXISTS resellers (
  user_id       INT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  brand_name    TEXT NOT NULL DEFAULT '',
  white_label   BOOLEAN NOT NULL DEFAULT false,
  active        BOOLEAN NOT NULL DEFAULT true,
  logo          BYTEA,
  logo_type     TEXT NOT NULL DEFAULT '',
  logo_version  INT NOT NULL DEFAULT 0,
  website       TEXT NOT NULL DEFAULT '',
  support_email TEXT NOT NULL DEFAULT '',
  payment_note  TEXT NOT NULL DEFAULT '',
  sender_name   TEXT NOT NULL DEFAULT '',
  sender_email  TEXT NOT NULL DEFAULT '',
  reply_to      TEXT NOT NULL DEFAULT '',
  smtp_host     TEXT NOT NULL DEFAULT '',
  smtp_port     INT NOT NULL DEFAULT 465,
  smtp_user     TEXT NOT NULL DEFAULT '',
  smtp_pass     BYTEA,  -- AES-256-GCM, like onboarding CSVs
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Mithmill's own (direct) business, without resellers' clients: used by
-- Analytics so reseller billing doesn't mix into Mithmill's numbers.
DROP VIEW IF EXISTS direct_orders;
CREATE VIEW direct_orders AS SELECT o.* FROM orders o JOIN users u ON u.id = o.user_id WHERE u.reseller_id IS NULL;
DROP VIEW IF EXISTS direct_invoices;
CREATE VIEW direct_invoices AS SELECT i.* FROM invoices i JOIN users u ON u.id = i.user_id WHERE u.reseller_id IS NULL;

-- "Sold by" belongs to the client: the team member who brought them in gets
-- the commission on all their batches and invoices. (Batches and invoices
-- carried it before; their old values are copied over once at boot.)
ALTER TABLE users ADD COLUMN IF NOT EXISTS sold_by TEXT NOT NULL DEFAULT '';
ALTER TABLE invites ADD COLUMN IF NOT EXISTS sold_by TEXT NOT NULL DEFAULT '';

-- Why a batch was cancelled: requested (by the client), no_payment, or other (free text).
ALTER TABLE orders ADD COLUMN IF NOT EXISTS cancel_reason TEXT NOT NULL DEFAULT '';

-- New orders: the client confirms they've invited Mithmill's support address
-- to manage their domains' DNS and to their sequencer.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS domain_invited BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS sequencer_invited BOOLEAN NOT NULL DEFAULT false;

-- Whether clients ordering this type give us their domains (and domain
-- access). Pre-warmed mailboxes come on our own domains, so they don't.
ALTER TABLE pricing ADD COLUMN IF NOT EXISTS needs_domains BOOLEAN NOT NULL DEFAULT true;

-- Reseller prices: what each reseller pays MithMill per mailbox per month, by
-- type (missing = the standard price). A reseller's payout on an invoice is
-- its total minus their cost (reseller_cost, worked out from these prices
-- when the invoice is created or edited, and fixed once it's paid).
CREATE TABLE IF NOT EXISTS reseller_pricing (
  reseller_id       INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  inbox_type        TEXT NOT NULL REFERENCES pricing(inbox_type) ON DELETE CASCADE,
  price_per_mailbox NUMERIC(10,2) NOT NULL CHECK (price_per_mailbox >= 0),
  PRIMARY KEY (reseller_id, inbox_type)
);
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS reseller_cost NUMERIC(10,2);
-- When the owner was alerted that this invoice is unpaid past its limit.
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS overdue_alert_at TIMESTAMPTZ;

-- Separated team members only see the clients they added (users.added_by).
ALTER TABLE users ADD COLUMN IF NOT EXISTS separated BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS added_by INT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE invites ADD COLUMN IF NOT EXISTS separated BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE invites ADD COLUMN IF NOT EXISTS added_by INT REFERENCES users(id) ON DELETE SET NULL;

-- "Block VPN": these people can't accept an invite, log in or use the portal over a VPN or proxy.
ALTER TABLE users ADD COLUMN IF NOT EXISTS block_vpn BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE invites ADD COLUMN IF NOT EXISTS block_vpn BOOLEAN NOT NULL DEFAULT false;
-- Portal access paused by the owner (resellers use resellers.active instead).
ALTER TABLE users ADD COLUMN IF NOT EXISTS access_blocked BOOLEAN NOT NULL DEFAULT false;

-- Payouts the owner has made to a reseller.
CREATE TABLE IF NOT EXISTS reseller_payouts (
  id          SERIAL PRIMARY KEY,
  reseller_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount      NUMERIC(10,2) NOT NULL CHECK (amount > 0),
  paid_on     DATE NOT NULL,
  note        TEXT NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Signed reseller agreements: who signed which version, when, from where,
-- their signature image and the PDF that was emailed. A reseller can't use
-- their dashboard until they've signed the current version.
CREATE TABLE IF NOT EXISTS reseller_agreements (
  id             SERIAL PRIMARY KEY,
  reseller_id    INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  version        TEXT NOT NULL,
  signer_name    TEXT NOT NULL,
  signer_title   TEXT NOT NULL DEFAULT '',
  signature      BYTEA NOT NULL,
  signature_type TEXT NOT NULL,
  ip             TEXT NOT NULL DEFAULT '',
  user_agent     TEXT NOT NULL DEFAULT '',
  pdf            BYTEA NOT NULL,
  signed_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS reseller_agreements_reseller ON reseller_agreements (reseller_id, signed_at DESC);
-- Agreed monthly order commitment (inboxes), shown in the agreement.
ALTER TABLE resellers ADD COLUMN IF NOT EXISTS monthly_commitment INT;

-- Where clients and resellers accept their invite and log in from (approximate,
-- from their IP address), plus their last known location on the user.
CREATE TABLE IF NOT EXISTS login_events (
  id           SERIAL PRIMARY KEY,
  user_id      INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL,           -- invite | login | reset
  ip           TEXT NOT NULL DEFAULT '',
  city         TEXT NOT NULL DEFAULT '',
  region       TEXT NOT NULL DEFAULT '',
  country      TEXT NOT NULL DEFAULT '',
  country_code TEXT NOT NULL DEFAULT '',
  user_agent   TEXT NOT NULL DEFAULT '',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS login_events_user ON login_events (user_id, created_at DESC);
-- The VPN check's answer, for people with "Block VPN" on.
ALTER TABLE login_events ADD COLUMN IF NOT EXISTS vpn BOOLEAN;
ALTER TABLE users ADD COLUMN IF NOT EXISTS city TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS region TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS country TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS country_code TEXT NOT NULL DEFAULT '';

-- Mailbox logins delivered to a client (uploaded as a CSV). Passwords are
-- encrypted like the onboarding CSVs.
CREATE TABLE IF NOT EXISTS mailboxes (
  id         SERIAL PRIMARY KEY,
  user_id    INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  order_id   INT REFERENCES orders(id) ON DELETE SET NULL,
  email      TEXT NOT NULL,
  password   BYTEA NOT NULL,
  is_admin   BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS mailboxes_user_email ON mailboxes (user_id, email);
-- The mailbox type and the date it was created, from the upload.
ALTER TABLE mailboxes ADD COLUMN IF NOT EXISTS inbox_type TEXT;
ALTER TABLE mailboxes ADD COLUMN IF NOT EXISTS created_on DATE;

-- A client's sending domains, the mailbox type each is set up on, and the
-- latest DNS check (MX/SPF/DMARC/DKIM, see dnscheck.js).
CREATE TABLE IF NOT EXISTS domains (
  id             SERIAL PRIMARY KEY,
  user_id        INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  order_id       INT REFERENCES orders(id) ON DELETE SET NULL,
  domain         TEXT NOT NULL,
  inbox_type     TEXT,
  dns            JSONB,
  dns_status     TEXT,
  dns_checked_at TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS domains_user_domain ON domains (user_id, domain);

-- Clients' domain hosts (registrars), connected with their API keys
-- (encrypted), used to point their domains at Mithmill's Cloudflare.
CREATE TABLE IF NOT EXISTS registrar_accounts (
  id          SERIAL PRIMARY KEY,
  user_id     INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider    TEXT NOT NULL,
  label       TEXT NOT NULL DEFAULT '',
  creds       BYTEA NOT NULL,
  hint        TEXT NOT NULL DEFAULT '',
  last_ok_at  TIMESTAMPTZ,
  last_error  TEXT NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Cloudflare: the zone, its status and nameservers, and whether the
-- registrar was switched to them (updated / failed / manual / done).
ALTER TABLE domains ADD COLUMN IF NOT EXISTS registrar_account_id INT REFERENCES registrar_accounts(id) ON DELETE SET NULL;
ALTER TABLE domains ADD COLUMN IF NOT EXISTS cf_zone_id TEXT;
ALTER TABLE domains ADD COLUMN IF NOT EXISTS cf_status TEXT;
ALTER TABLE domains ADD COLUMN IF NOT EXISTS cf_nameservers JSONB;
ALTER TABLE domains ADD COLUMN IF NOT EXISTS cf_error TEXT NOT NULL DEFAULT '';
ALTER TABLE domains ADD COLUMN IF NOT EXISTS cf_checked_at TIMESTAMPTZ;
ALTER TABLE domains ADD COLUMN IF NOT EXISTS ns_status TEXT;
ALTER TABLE domains ADD COLUMN IF NOT EXISTS ns_error TEXT NOT NULL DEFAULT '';
ALTER TABLE domains ADD COLUMN IF NOT EXISTS ns_updated_at TIMESTAMPTZ;
ALTER TABLE domains ADD COLUMN IF NOT EXISTS added_by_client BOOLEAN NOT NULL DEFAULT false;

-- Clients' sequencers (Instantly, Smartlead, …), with API keys / logins
-- (encrypted). Mailboxes are connected by a background queue (connector.js):
-- connect_jobs is each attempt (step, error, on-screen details of a failure),
-- mailbox_connections the current state per mailbox and sequencer.
CREATE TABLE IF NOT EXISTS sequencer_accounts (
  id          SERIAL PRIMARY KEY,
  user_id     INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider    TEXT NOT NULL,
  label       TEXT NOT NULL DEFAULT '',
  creds       BYTEA NOT NULL,
  hint        TEXT NOT NULL DEFAULT '',
  last_ok_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS mailbox_connections (
  mailbox_id   INT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  sequencer_id INT NOT NULL REFERENCES sequencer_accounts(id) ON DELETE CASCADE,
  status       TEXT NOT NULL,
  error        TEXT NOT NULL DEFAULT '',
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (mailbox_id, sequencer_id)
);
CREATE TABLE IF NOT EXISTS connect_jobs (
  id           SERIAL PRIMARY KEY,
  user_id      INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sequencer_id INT NOT NULL REFERENCES sequencer_accounts(id) ON DELETE CASCADE,
  mailbox_id   INT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  status       TEXT NOT NULL DEFAULT 'queued',
  step         TEXT NOT NULL DEFAULT '',
  error        TEXT NOT NULL DEFAULT '',
  diag         JSONB,
  attempts     INT NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at   TIMESTAMPTZ,
  finished_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS connect_jobs_queue ON connect_jobs (status, id);

-- White-label reseller whose clients pay through Mithmill's processor
-- (Mixxbee LLC): their brand and logo, with "Payments powered by Mixxbee".
ALTER TABLE resellers ADD COLUMN IF NOT EXISTS use_mixxbee BOOLEAN NOT NULL DEFAULT false;

-- A reseller's own portal address (e.g. portal.theirbrand.com, a CNAME to
-- this service): opening it shows their brand; their clients' links use it.
ALTER TABLE resellers ADD COLUMN IF NOT EXISTS custom_domain TEXT NOT NULL DEFAULT '';
CREATE UNIQUE INDEX IF NOT EXISTS resellers_custom_domain ON resellers (lower(custom_domain)) WHERE custom_domain <> '';

-- One batch, several mailbox types: the extra types are parts of the main
-- batch (parent_order_id). Only the main batch renews with an invoice and
-- reminders; its invoice has a line per part.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS parent_order_id INT REFERENCES orders(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS orders_parent ON orders (parent_order_id) WHERE parent_order_id IS NOT NULL;

-- Some types are sold per domain, not per mailbox: per_domain is how many
-- inboxes one domain includes (0 = priced per mailbox). Azure: $X per domain
-- of up to 99 inboxes. Set once; the owner can change it under Settings.
ALTER TABLE pricing ADD COLUMN IF NOT EXISTS per_domain INT NOT NULL DEFAULT 0;
UPDATE pricing SET per_domain = 99 WHERE inbox_type = 'azure' AND per_domain = 0
  AND NOT EXISTS (SELECT 1 FROM settings WHERE key = 'azure_per_domain_v1');
INSERT INTO settings (key, value) VALUES ('azure_per_domain_v1', 'done') ON CONFLICT (key) DO NOTHING;

-- Pre-warmed inboxes: Mithmill's own stock of warmed mailboxes, sold to
-- clients. Stages: warming (14 days) -> available -> premium (after 30 days
-- unsold); sold when tagged to a client. status_since is when the current
-- stage began (moved forward by exactly 14 / 30 days on each automatic step).
CREATE TABLE IF NOT EXISTS prewarmed (
  id             SERIAL PRIMARY KEY,
  email          TEXT NOT NULL UNIQUE,
  password       BYTEA NOT NULL,
  domain         TEXT NOT NULL,
  inbox_type     TEXT,
  status         TEXT NOT NULL DEFAULT 'warming' CHECK (status IN ('warming', 'available', 'premium', 'sold')),
  status_since   TIMESTAMPTZ NOT NULL DEFAULT now(),
  warmup_started DATE,
  sold_to        INT REFERENCES users(id) ON DELETE SET NULL,
  sold_at        TIMESTAMPTZ,
  sold_from      TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS prewarmed_status ON prewarmed (status);
CREATE INDEX IF NOT EXISTS prewarmed_domain ON prewarmed (domain);
-- When each domain's registration expires (from RDAP), checked regularly.
CREATE TABLE IF NOT EXISTS domain_expiry (
  domain     TEXT PRIMARY KEY,
  expires_on DATE,
  registrar  TEXT NOT NULL DEFAULT '',
  checked_at TIMESTAMPTZ,
  error      TEXT NOT NULL DEFAULT ''
);
-- Lookups that rdap.org refused (403, before lookups went to the registries directly) are retried.
UPDATE domain_expiry SET checked_at = NULL WHERE expires_on IS NULL AND error LIKE 'Lookup failed (403)%';
-- Domains the .co registry rate-limited (429) are looked up again, now paced.
UPDATE domain_expiry SET checked_at = NULL WHERE expires_on IS NULL AND error LIKE 'Lookup failed (429)%';
