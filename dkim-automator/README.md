# DKIM Automator (DKIM automation for google)

Backend + web UI + Chrome extension that turns on Google Workspace DKIM for many domains with no manual clicks.

## How the Google steps run
Google blocks automated sign-ins from datacenter servers with endless CAPTCHAs, so by default the
Google Admin steps run in **your own Chrome** through the bundled extension (`extension/`), where
you are already signed in. The server never needs your Google password.

1. In the dashboard click **Download extension** (`/extension.zip`, pre-configured with the server
   URL and access key), unzip it, then go to `chrome://extensions` → Developer mode → **Load unpacked**.
2. Either give each job the admin password (the extension then signs in by itself: email →
   password → "I understand"/"Not now" screens), or sign in to admin.google.com yourself once.
   If Google asks for a CAPTCHA / code / phone approval, the pinned tab comes to the front and the
   extension waits up to 4 minutes for you, then continues. Use a dedicated Chrome profile and the
   "Sign out after each account" option for many tenants (Chrome allows ~10 signed-in accounts).
   **Bulk mode**: paste `admin email, password, domain` lines; rows are grouped per admin account.
3. The extension polls the server every 30s, does each step in a pinned background tab and reports back.

An older "server browser" mode (headless Chromium on the server with the admin password) is still
available, but Google usually blocks it.

## Pipeline
1. **Generate**: in the Google Admin console (via the extension), opens
   *Apps → Google Workspace → Gmail → Authenticate email*, selects the domain and generates a
   2048-bit key (selector `google` by default). An existing key that is already authenticating is
   kept, not replaced.
2. **Publish**: creates or updates the `google._domainkey.<domain>` TXT record through the Cloudflare
   API. Manual mode shows the record for you to add instead.
3. **Verify**: polls public DNS (1.1.1.1 / 8.8.8.8) until the exact value is visible.
4. **Activate**: clicks *Start authentication* and confirms the status changes to
   "Authenticating email with DKIM".

## Reliability features
- Durable job store (`$DATA_DIR/jobs.json`). Jobs resume after a restart.
- A domain can only be in one active job at a time, so no duplicate key generation.
- Workers (`WORKERS`) run tenants in parallel. A single tenant is processed one browser action at a time.
- Retries with exponential backoff (`MAX_ATTEMPTS`). Google's "wait 24–72h on new tenants" is
  retried hourly for up to `GOOGLE_WAIT_HOURS`.
- Each tenant runs in its own isolated browser context. Session cookies are stored AES-256-GCM
  encrypted and reused. An expired session triggers a fresh sign-in.
- Sign-in challenges (2-Step Verification, "Verify it's you") stop that tenant and mark it
  **Needs action** instead of retrying blindly.
- A screenshot is saved on every browser failure and linked from the UI (`/api/debug/<file>`).
- `/api/stats` and Prometheus-style `/metrics` endpoints.

## Requirements
- The Google Admin account must be a super admin, signed in in the Chrome running the extension.
- Chrome with the extension installed and open while jobs run.
- Cloudflare API token with **Zone → Zone → Read** and **Zone → DNS → Edit** for the zones.

## Run locally
```bash
npm install
CHROME_PATH=/path/to/chrome APP_PASSWORD=secret npm start   # http://localhost:3000
```
Tick **Simulate** in the UI to test the whole pipeline without touching Google or DNS.

## Environment
| Var | Default | |
|---|---|---|
| `APP_PASSWORD` | none | HTTP Basic-auth password for the UI/API (any username) |
| `SECRET_KEY` | random | Encrypts stored credentials and sessions. Set it so jobs survive restarts |
| `WORKERS` | 1 | Parallel browser workers (≈250 MB RAM each) |
| `DATA_DIR` | `./data` | Job store, sessions, debug screenshots |
| `DNS_WAIT_HOURS` | 6 | How long to wait for the TXT record to appear |
| `GOOGLE_WAIT_HOURS` | 72 | How long to keep retrying when Google says to wait |

## API
- Extension: `POST /api/agent/claim`, `POST /api/agent/report`, `GET /api/agent/status`, `GET /extension.zip`
- `POST /api/jobs` `{adminEmail, adminPassword, domains, dnsProvider: "cloudflare"|"manual", cloudflareToken, selector, keyLength, regenerate, simulate}`
- `GET /api/jobs`, `GET /api/jobs/:id`, `POST /api/jobs/:id/retry {domain?, adminPassword?}`,
  `POST /api/jobs/:id/cancel`, `DELETE /api/jobs/:id`, `GET /api/jobs/:id/export.csv`
- `GET /api/dns-check?domain=x.com&selector=google`, `GET /api/stats`, `GET /metrics`, `GET /healthz`
