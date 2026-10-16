# Mithmill Client Portal

A portal where Mithmill clients see their mailboxes and billing and order new mailboxes, and where the Mithmill team manages orders, invoices and pricing.

## What it does

**Clients** (invite-only):

- Dashboard: active mailboxes, mailboxes being set up, monthly billing, outstanding balance, next renewal, and every batch with its status.
- New order in 3 steps:
  1. Inbox type: Google Workspace, Azure, Microsoft 365 (Admin) or Microsoft 365 (Non-Admin).
  2. Details: number of mailboxes, domain names, usernames, domain access (method, registrar, account email) and sequencer access (Instantly, Smartlead, Lemlist, Reply.io and others).
  3. Review and place the order.
- Billing: upcoming renewals and invoices, with the notice that payments are collected under **Mixxbee LLC** (the same company as Mithmill).
- Notifications (bell icon): order updates, invoices and renewal reminders.

**Admin** (`ADMIN_EMAIL`):

- Orders: every setup detail. Setting an order to **Active** turns on the client's mailboxes, creates the first month's invoice and sets the renewal date one month out. You can change the renewal date and keep internal notes.
- Clients & invites: invite clients by email (you also get a copy-able link), revoke pending invites, and generate password-reset links.
- Invoices: create one-off invoices, and mark invoices paid, unpaid or void. Clients are notified in each case.
- Pricing & reminders: set the price per mailbox for each inbox type, and run the reminder check by hand.

## Renewal reminders

Each active batch renews monthly. Before each renewal date the client gets an in-portal notification, plus an email when SMTP is configured:

| When | Message |
|---|---|
| 7 days before | Your batch will renew in 7 days |
| 3 days before | Your batch will renew in 3 days |
| 1 day before | Your batch will renew in 1 day. Please make the payment if not made. |

The renewal invoice is created 7 days before the renewal date. The check runs at startup and then every hour. Each reminder is recorded in the database, so it is never sent twice. If the service was asleep and missed a reminder, the next run sends one catch-up message with the real number of days left. Dates use `BILLING_TZ`, which defaults to `Asia/Dhaka`.

**Free Render plan:** the free web service sleeps after 15 minutes without traffic, and a sleeping service can't send reminders. Set up a free scheduler such as [cron-job.org](https://cron-job.org) to call this URL once or twice a day:

```
https://<your-app>.onrender.com/api/cron/billing?key=<CRON_SECRET>
```

## Environment variables

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | yes | Postgres connection string |
| `SESSION_SECRET` | yes | Long random string used to sign login cookies |
| `ADMIN_EMAIL` | yes | Admin login, e.g. `sales@mithmill.com` |
| `ADMIN_PASSWORD` | first boot | Creates the admin account if it doesn't exist. Change it after logging in (click your email in the top bar). |
| `APP_URL` | recommended | Public URL, used in invite links and emails |
| `CRON_SECRET` | recommended | Protects `/api/cron/billing` |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | optional | Email delivery. Without these, emails are skipped: notifications still appear in the portal, and invite links are shown to the admin to send by hand. |
| `BILLING_TZ` | optional | Defaults to `Asia/Dhaka` |
| `DATABASE_SSL` | optional | `true` when you connect through Render's *external* database URL |
| `NODE_ENV` | optional | `production` makes the login cookie HTTPS-only |

For Google Workspace SMTP, use `SMTP_HOST=smtp.gmail.com`, `SMTP_PORT=465`, and an [app password](https://support.google.com/accounts/answer/185833) for `SMTP_PASS`.

## Running locally

```bash
cd client-portal
npm install
DATABASE_URL=postgresql://localhost/portal SESSION_SECRET=dev \
ADMIN_EMAIL=sales@mithmill.com ADMIN_PASSWORD=changeme123 npm start
# http://localhost:3000
```

The database tables are created automatically on startup (`schema.sql`).

## Deploying on Render

- Web service: Node runtime, build command `cd client-portal && npm install`, start command `cd client-portal && npm start`.
- Postgres: set the web service's `DATABASE_URL` to the database's internal connection string.

## Stack

Node + Express, Postgres (`pg`), and a vanilla JS single-page front end in `public/`, with no build step.
