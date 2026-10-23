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

- Analytics (owner only): this month so far against last month, Stripe-style. Payments received, invoiced, new clients, new batches and cancellations are compared with the same days of last month. Active clients, monthly recurring revenue and active mailboxes are compared with where last month ended. It also shows 6- or 12-month charts, outstanding and overdue totals, recurring revenue by mailbox type, top clients, recent payments and a month-by-month table.
- Orders: every setup detail. Setting an order to **Active** turns on the client's mailboxes, creates the first month's invoice and sets the renewal date one month out. You can change the renewal date and keep internal notes.
- Sold by: an admin-only field on invoices and batches for the team member who made the sale (for commission). Clients never see it. A batch's renewal invoices inherit it. Analytics shows payments received per team member this month and last month.
- Clients & invites: invite clients by email (you also get a copy-able link), revoke pending invites, and generate password-reset links. **Edit** changes a client's name and company. Only the owner can change a client's login email; both the old and new address are told. **Delete** (owner only) permanently removes a client with all their batches, invoices, notifications and pricing, after you type their email to confirm.
- Invoices: create and edit fully custom invoices with any number of lines (mailbox type, batch name, description, quantity, unit price), plus issue/due dates, discount and notes. Mark invoices paid, unpaid or void. Clients see each invoice as a printable page (Print / Save PDF). **Send invoice** emails it to the client: every line, the total and due date, your notes (payment details), a request to reply with a payment screenshot, and a link to the invoice once they've joined. The page shows when it was last sent. On an unpaid invoice, **⚠ Urgent reminder** sends a critical alert instead. It says the mailboxes will be deactivated in a number of hours you choose (default 3) unless they pay now, and includes the invoice, Pay buttons and a request for the payment screenshot. Payment links in the notes (Stripe, Wise, bKash, Binance Pay, PayPal, Payoneer and others, or any link on a line that names the method or says "pay") become **Pay buttons** in the invoice email, the new-invoice and renewal emails, and on the invoice page. Bank details and IDs without a link stay as plain notes. A payment link shows **Pay now**. A Stripe subscription link shows **Update payment method**, with a line explaining that the card is charged automatically. That covers a `billing.stripe.com` customer-portal link, or a Stripe link on a line that says renewal, recurring, subscription or update card.
- Pricing: standard prices per inbox type under **Pricing & reminders**, and each client's own prices under **Clients & invites** → Edit pricing (blank = standard price). You can also change the price and mailbox count on an existing order; future renewals follow it.
- Reminders: run the reminder check by hand under **Pricing & reminders**.

## Onboarding CSV

On the order form, clients download a sample CSV (one row per mailbox user: domain name, users per domain, full name, username, preferred password, domain access email/username, domain provider password and login URL, sequencer access email/password/workspace, profile picture Drive link, domain forward), fill it in and upload it. It's checked on upload, fills in the domains, usernames and mailbox count, and is required for orders at or above the threshold set under **Settings** (default 10). The file is stored encrypted, and only admins can download it from the order.

## Renewal reminders

Each active batch renews monthly. Before each renewal date the client gets an in-portal notification, plus an email when SMTP is configured:

| When | Message |
|---|---|
| 7 days before | Your batch will renew in 7 days |
| 3 days before | Your batch will renew in 3 days |
| 1 day before | Your batch will renew in 1 day. Please make the payment if not made. Today is the last day to renew: if payment is not made by today, your accounts will be cancelled tomorrow. |

While the renewal invoice is unpaid, each reminder email also asks the client to confirm their payment by replying with a screenshot, or by sharing it in their WhatsApp or Slack group with you (recommended).

Renewal reminders are emailed even to clients who haven't accepted their invite yet (without the portal link). Other notifications wait until they join.

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
| `ORDER_NOTIFY_EMAILS` | optional | Default recipients of new-order emails (comma-separated). Editable later under Settings. Defaults to `ADMIN_EMAIL`. |
| `DATA_ENCRYPTION_KEY` | recommended | 64 hex characters. Encrypts uploaded onboarding CSVs (they contain passwords). Falls back to a key derived from `SESSION_SECRET`. Don't change it once files are uploaded. |
| `BILLING_TZ` | optional | Defaults to `Asia/Dhaka` |
| `DATABASE_SCHEMA` | optional | Postgres schema for the portal's tables (default `public`). Set it to `client_portal` when you share a database with another app. |
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
