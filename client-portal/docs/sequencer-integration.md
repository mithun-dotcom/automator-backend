# Connecting Mithmill Google Workspace mailboxes to customers' sequencers

Status: **design, HARD STOP reached**. No code from this document is live yet.
Docs read on 2026-11-09. Every vendor claim below cites the page it comes from;
anything not in the docs is marked **(not documented)** or **(my knowledge, verify)**.

## 0. Result of the hard stop

The question: does any vendor expressly support connecting a Google Workspace
mailbox that Mithmill controls (super-admin tenant) **with no human Google
sign-in/consent and no browser automation**?

| Vendor | Documented mailbox-connect mechanism | Unattended, no browser automation? |
|---|---|---|
| PlusVibe (partner API) | `POST /webhook/partner-google-oauth-url` returns a Google consent URL. The page says: "***Infrastructure provider is required to have its own browser automation***" ([source](https://developer.plusvibe.ai/initiate-google-oauth-login-flow-40641116e0.md)) | **No.** The documented partner path *is* browser automation, which this project forbids. |
| Instantly | `POST /api/v2/oauth/google/init` returns `auth_url`; "Open that URL in a new browser tab and connect the account." ([guide](https://developer.instantly.ai/guides/oauth-connection-flow)) | **No.** A person completes Google consent. |
| Smartlead | `POST /email-accounts/save-oauth` takes tokens "after obtaining OAuth tokens from the respective provider"; needs `refresh_token` ([source](https://api.smartlead.ai/api-reference/email-accounts/add-oauth)) | **Not stated.** It accepts tokens we obtain ourselves, but a person must still consent once per mailbox to issue a refresh token (see §3.3). |
| ReachInbox | Dashboard only: admin trusts the app once, then each user clicks "Login with Google … approve access" ([source](https://help.reachinbox.ai/en/articles/9910663-connect-mailboxes-to-reachinbox-ai-using-google-oauth)). No public "add mailbox" API found. | **No.** |
| ManyReach | No documentation found. | **Unknown.** Ask them. |
| Google | Domain-wide delegation (DWD) lets *our own* service account act as users "without their direct consent" ([source](https://developers.google.com/identity/protocols/oauth2/service-account#delegatingauthority)) | Yes, but **only for our own app**. No sequencer documents accepting DWD or service-account credentials. |

**Missing capability (all vendors):** an API that accepts a mailbox from an
email-infrastructure partner using the *partner's* Google authorization (a
DWD service account, or a refresh token minted by the partner's own trusted
OAuth client), without the vendor's own user-consent screen.

**Consequence for the current code:** the client portal's "Connect" button
(`signin.js` + `sequencers.js` + `connector.js`) signs in to Google/Microsoft
with the mailbox password in a headless browser. That is the password-login
automation this project forbids. It must be switched off and replaced by the
consent-based flow in §3. (The owner decides when; see §8.)

## 1. Support questions to send

### PlusVibe (support@plusvibe.ai; they offer a private partner Slack per the [Email Infra Provider Guide](https://developer.plusvibe.ai/email-infra-provider-guide-2268692m0))

> We are an email-infrastructure provider (provider_id ______) and own the Google
> Workspace tenants our mailboxes live in, with super-admin access.
> 1. Besides `partner-google-oauth-url` (which your docs say requires our own
>    browser automation), do you support adding a Google Workspace mailbox
>    **without anyone completing your Google consent screen**? For example: (a) we
>    authorize your Google OAuth client ID `550255402234-v3e4mu3ugkvrl2ngaai0nnsv5nll1nm7.apps.googleusercontent.com`
>    for domain-wide delegation in our tenant; or (b) we pass you a refresh
>    token from our own OAuth client; or (c) app passwords / SMTP-IMAP for Workspace.
> 2. If not, is a human completing the `redirect_url` in a normal browser
>    (no automation) the supported partner path? How long is the URL/state valid?
> 3. Which endpoint confirms a specific mailbox is connected and healthy (account
>    list filtered by `email`? which status values mean connected)? Is there a
>    webhook for "connected", or only `SYSTEM_ALERT` → `EMAIL_ACCOUNT_DISCONNECTED`?
> 4. The guide says base URL `https://api.plusvibe.ai/v1`; endpoint specs say
>    `https://api.plusvibe.ai/api/v1`. Which is correct?
> 5. Error codes and rate limits for partner endpoints (getting-started says 10 req/s).

### Instantly / Smartlead / ReachInbox / ManyReach (same core question)

> We provide Google Workspace mailboxes from tenants we administer and want to
> add them to our customers' workspaces in your product via API. Is there a
> documented way to do this **without a person completing a Google consent
> screen**: domain-wide delegation of your OAuth client, accepting a refresh
> token from our own trusted OAuth client, or a partner/reseller program? If
> yes, please send the endpoint, auth, request/response and how we verify the
> mailbox is connected. (Smartlead: does `save-oauth` with
> `use_whitelabel_credentials` accept tokens issued to *our* Google OAuth client,
> and what client secret do you need to refresh them?)
> (ReachInbox / ManyReach: is there a public API to add a mailbox at all?)

## 2. Google side (what we can and should set up now)

Distinguish three different things:

1. **DWD (service account → impersonate users).** Our own Cloud project's
   service account calls Google APIs as a user, with no consent. A super admin
   authorizes the service account's client ID and scopes under Security → Access
   and data control → API controls → Manage Domain Wide Delegation ([source](https://developers.google.com/identity/protocols/oauth2/service-account#delegatingauthority)); it
   "might take up to 24 hours to propagate". **No sequencer can use these
   credentials** (§0), so DWD does not connect mailboxes to sequencers.
2. **Third-party OAuth app trust.** In Admin console → API controls → Manage
   App Access, the super admin adds the *vendor's* OAuth client ID and marks it
   **Trusted** for the org (ReachInbox documents exactly this, [source](https://help.reachinbox.ai/en/articles/9910663-connect-mailboxes-to-reachinbox-ai-using-google-oauth)).
   This stops Google blocking the vendor app; a person still signs in and approves.
3. **The vendor's own token requirements.** PlusVibe's consent URL asks for
   `profile email https://mail.google.com` with `access_type=offline` ([source](https://developer.plusvibe.ai/initiate-google-oauth-login-flow-40641116e0.md)).
   Smartlead requires the `https://mail.google.com/` scope and a `refresh_token` ([source](https://api.smartlead.ai/api-reference/email-accounts/add-oauth)).
   `https://mail.google.com/` is a **Restricted** scope ([source](https://developers.google.com/gmail/api/auth/scopes)).

**Recommendation (least privilege):** create one Cloud project
`mithmill-mailbox-ops` with one service account, and give it DWD for
**read-only directory** only, `https://www.googleapis.com/auth/admin.directory.user.readonly`
**(my knowledge, verify)**. We use it to check that a selected mailbox exists,
is active and is in our tenant. Do **not** grant any Gmail scope via DWD: we
never read or send mail, so it would be unneeded risk.

Console steps:
1. Cloud console → new project → enable Admin SDK API.
2. IAM → Service accounts → create `mailbox-ops@…`; no key download if Workload
   Identity is available, otherwise create one JSON key and store it encrypted
   (same AES-GCM `DATA_ENCRYPTION_KEY` scheme as other secrets).
3. Copy the service account's **OAuth client ID** (numeric "Unique ID").
4. In **each tenant**, a super admin authorizes that client ID with only the
   directory scope (steps quoted above). Wait up to 24 h.
5. Safe test: impersonate a super admin (`sub`) and call
   `GET https://admin.googleapis.com/admin/directory/v1/users/{mailbox}` on a
   known mailbox. Expect 200 with `suspended:false`. No mailbox data is touched.
6. Per vendor, in each tenant: add the vendor's OAuth client ID under Manage App
   Access → **Trusted** (PlusVibe's ID is in its consent URL above; ask each
   vendor for theirs).

## 3. The supported consent-based flow

A person (the customer, or a Mithmill operator **by hand in a normal browser**)
opens the vendor's Google consent URL, signs in as the mailbox and clicks Allow.
Everything else is automated. Nothing is shown as "Connected" until the vendor's
API confirms it.

### 3.1 PlusVibe (partner API)

1. Customer invites Mithmill's PlusVibe login to their workspace (guide's best
   practice), so we call partner endpoints with our own credentials.
2. `POST {base}/webhook/partner-list-workspace` body `{ "flow": "app_user", "provider_id": "<ours>" }`,
   header `x-api-key: <our key>` → `data[]` of `{org_id, workspace_id, workspace_name, workspace_status}`
   ([source](https://developer.plusvibe.ai/list-workspaces-40641113e0.md)). Customer picks one.
3. Pre-check each mailbox: `GET {base}/webhook/partner-check-email-account?workspace_id=…&provider_id=…&email=…`
   → `{"code":1,"data":{"existed_in_other_ws":false,"current":12,"max_allowed":50}}`
   ([source](https://developer.plusvibe.ai/check-if-an-email-exists-in-another-workspace-40641115e0.md)).
   Stop if `existed_in_other_ws` is true or `current >= max_allowed`.
4. `POST {base}/webhook/partner-google-oauth-url` body
   `{ "flow":"app_user", "workspace_id":"…", "provider_id":"…", "daily_limit":30, "enable_warmup":"…" }`
   → `{"code":1,"data":{"redirect_url":"https://accounts.google.com/o/oauth2/v2/auth?…prompt=consent…","client_id":"550255402234-…"}}`
   ([source](https://developer.plusvibe.ai/initiate-google-oauth-login-flow-40641116e0.md)).
5. Show `redirect_url` to the person as a button ("Open Google sign-in for
   anna@…"). **We never open it in a headless browser.**
6. Verify: poll the account list filtered by `email` ([source](https://developer.plusvibe.ai/list-all-email-accounts-in-the-workspace-38494498e0.md))
   every 10 s for 15 min; mark connected only when the account is present and
   healthy (**which status value means healthy: not documented, ask**, Q3).
7. Subscribe to `SYSTEM_ALERT`; on `EMAIL_ACCOUNT_DISCONNECTED` set our state to
   `disconnected` with `reason` (e.g. `invalid_grant`); verify the optional HMAC
   signature `hex(HMAC_SHA256(secret, raw_body))` ([source](https://developer.plusvibe.ai/webhooks-overview-2268181m0.md)).

Base URL: use the endpoint specs' `https://api.plusvibe.ai/api/v1` until
PlusVibe answers Q4 (the guide says `/v1`). Rate limit: 10 req/s ([source](https://developer.plusvibe.ai/getting-started-2268178m0.md)).

### 3.2 Instantly

1. Customer creates an API key with scopes `accounts:create` and `accounts:read`
   ([guide](https://developer.instantly.ai/guides/oauth-connection-flow)); we validate it with `GET /api/v2/accounts?limit=1`.
2. Per mailbox: `POST https://api.instantly.ai/api/v2/oauth/google/init` (no body)
   → `{session_id, auth_url, expires_at}` (10 minutes) ([source](https://developer.instantly.ai/api-reference/oauth/initialize-google-oauth)).
3. Person opens `auth_url` and approves.
4. Poll `GET /api/v2/oauth/session/status/{session_id}` every 5 s
   ([source](https://developer.instantly.ai/api-reference/oauth/get-oauth-session-status)): `pending` → keep polling;
   `success` → `{email, account_id}`; `error` (e.g. `account_exists`); `expired`.
   "Successful or error sessions are deleted after the first status retrieval",
   so store the result on first read.
5. Confirm with `GET /api/v2/accounts/{email}`: `status` 1 = Active; -1/-2/-3 are errors ([source](https://developer.instantly.ai/api-reference/account/get-account)).
6. Limits: init 75/min per workspace and 150/min per IP, with escalating IP blocks;
   honour `Retry-After` on 429.

### 3.3 Smartlead (tokens from our own OAuth client)

1. Mithmill creates its own Google OAuth client in `mithmill-mailbox-ops`
   (Internal app in our tenant), redirect to our portal. Each tenant trusts it.
2. Person approves once per mailbox; we exchange the code for an access +
   refresh token with scope `https://mail.google.com/`.
3. `POST https://server.smartlead.ai/api/v1/email-accounts/save-oauth?api_key=…`
   with `{from_name, from_email, username, type:"GMAIL", token:{scope, token_type:"Bearer", access_token, refresh_token, expiry_date}, warmup_enabled, use_whitelabel_credentials}`
   → `{"ok":true,"data":{"id":123,"is_smtp_success":true,"is_imap_success":true}}`
   ([source](https://api.smartlead.ai/api-reference/email-accounts/add-oauth)).
4. Connected only when `is_smtp_success && is_imap_success`, re-checked with `GET /email-accounts/{id}/`.
5. **Blocker until Smartlead confirms:** how Smartlead refreshes a token issued to
   *our* client (it would need our client secret, or `use_whitelabel_credentials`
   with our client registered in their "private infrastructure OAuth", [help 296](https://helpcenter.smartlead.ai/en/articles/296-how-to-set-up-private-infrastructure-oauth-in-smartlead-for-google-and-microsoft)).
   Restricted scope: internal apps may avoid Google's security assessment
   **(my knowledge, verify)**.

### 3.4 ReachInbox, ManyReach

No public add-mailbox API found. Until they answer §1: show the customer the
vendor's own "Login with Google" steps, with the tenant already trusting the
vendor's app. Mithmill tracks state from the customer's confirmation only, and
the UI says "Not verified by ReachInbox/ManyReach" rather than "Connected".

## 4. Data model (migration)

```sql
-- Customer's sequencer credentials (existing: sequencer_accounts; add)
ALTER TABLE sequencer_accounts ADD COLUMN IF NOT EXISTS auth_mode TEXT NOT NULL DEFAULT 'api_key'; -- api_key | partner
ALTER TABLE sequencer_accounts ADD COLUMN IF NOT EXISTS workspace_id TEXT;      -- PlusVibe workspace chosen
ALTER TABLE sequencer_accounts ADD COLUMN IF NOT EXISTS validated_at TIMESTAMPTZ;
ALTER TABLE sequencer_accounts ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ;

-- One connection attempt per mailbox per sequencer (replaces connect_jobs)
CREATE TABLE IF NOT EXISTS mailbox_link_jobs (
  id              BIGSERIAL PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,          -- sha256(sequencer_id|mailbox_id|attempt_no)
  sequencer_id    INT NOT NULL REFERENCES sequencer_accounts(id) ON DELETE CASCADE,
  mailbox_id      INT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  state           TEXT NOT NULL CHECK (state IN ('precheck','awaiting_consent','verifying','connected','failed','cancelled','expired','revoked')),
  vendor_session  TEXT,                          -- Instantly session_id / PlusVibe state
  consent_url_enc BYTEA,                         -- encrypted; never logged
  consent_expires TIMESTAMPTZ,
  vendor_account  TEXT,                          -- vendor's account id once verified
  attempts        INT NOT NULL DEFAULT 0,
  next_check_at   TIMESTAMPTZ,
  last_error      TEXT NOT NULL DEFAULT '',
  created_by      INT REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS one_open_link_per_mailbox
  ON mailbox_link_jobs (sequencer_id, mailbox_id) WHERE state IN ('precheck','awaiting_consent','verifying');

CREATE TABLE IF NOT EXISTS mailbox_link_events (       -- audit trail
  id BIGSERIAL PRIMARY KEY, job_id BIGINT REFERENCES mailbox_link_jobs(id) ON DELETE CASCADE,
  at TIMESTAMPTZ NOT NULL DEFAULT now(), actor INT, event TEXT NOT NULL, detail JSONB NOT NULL DEFAULT '{}'
);
```

`mailbox_connections.status` stays the customer-facing state and is only set to
`connected` from the `verifying → connected` transition.

## 5. Backend pseudocode

```
connectSelected(customer, sequencer, mailboxIds):
  assert 1 <= len(mailboxIds) <= batchLimit           # 3 in phase 1
  for m in mailboxIds:
    assert directory.userActive(m.email)               # DWD read-only check
    job = upsert link job (idempotency_key) state='precheck'
    enqueue(job)

worker(job):                                            # per-mailbox queue, 1 vendor call at a time per sequencer
  switch job.state:
    precheck:
      vendor.precheck(job)   # PlusVibe partner-check-email-account; Instantly: none
      url, session, expires = vendor.startConsent(job)  # partner-google-oauth-url / oauth/google/init
      save encrypted url; state='awaiting_consent'; notify person (portal button + email)
    awaiting_consent | verifying:
      r = vendor.verify(job)  # PlusVibe list by email; Instantly session status then accounts/{email}
      if r.connected: state='connected'; mailbox_connections.status='connected'
      elif r.error:   state='failed', last_error=r.error  (account_exists, max accounts…)
      elif now > consent_expires: state='expired'       # person can press "New link"
      else: state='verifying' if r.started else same; next_check_at = now + backoff(5s→30s)
  on 429/503: retry with Retry-After / exponential backoff (max 6), never re-run startConsent for the same idempotency key
  every transition → mailbox_link_events

cancel(job):   if state in open states → 'cancelled' (vendor session just expires)
revoke(seq):   mark sequencer revoked_at, stop jobs, delete stored keys; the customer removes
               accounts in the vendor UI (no documented delete-by-partner API: ask)
webhook(plusvibe SYSTEM_ALERT): verify HMAC; for each account → mailbox_connections 'disconnected' + reason
```

Secrets: API keys, partner key, OAuth refresh tokens (Smartlead path) and
consent URLs are encrypted with the existing AES-256-GCM key; never logged; only
the last 4 characters are shown.

## 6. Test plan

1. Unit: vendor adapters against recorded doc examples (requests/responses in §3).
2. Contract: one sandbox workspace per vendor; a test mailbox in our tenant.
3. Negative: invalid key (401), unknown `provider_id`, `existed_in_other_ws`,
   `MAX_ALLOWED_ACCOUNTS_REACHED`, Instantly `account_exists`, expired session,
   429 with `Retry-After`, webhook with bad signature.
4. Idempotency: double-click "Connect" → one job; worker restart mid-verify → resumes.
5. Never-connected guard: a job whose consent is never completed must end
   `expired`, and the mailbox must never show "Connected".

## 7. Rollout

| Phase | Mailboxes | Gate to next phase |
|---|---|---|
| 1 | 3 (one customer, one vendor) | 3/3 verified by vendor API; no manual DB edits |
| 2 | 30 (3–5 customers, PlusVibe + Instantly) | ≥95% verified within 15 min of consent; no 429 blocks; disconnect webhook seen and handled |
| 3 | 300 | Batching (queue concurrency per vendor limits), on-call alerting on failed/expired jobs, support answers received for §1 |

## 8. Decisions needed from the owner

1. When to switch off the current password-automation connector (now, or when
   phase 1 of §3 is live).
2. Send the §1 questions (PlusVibe first: we already have a provider ID).
3. Who clicks the consent link: the customer, or a Mithmill operator by hand.
