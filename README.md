# Tablely — restaurant ordering & management (working core)

Multi-tenant restaurant SaaS: React + Vite + Tailwind + Motion frontend, Express + Prisma + PostgreSQL backend.
This is **Phase 1–3 plus parts of 4–5 and 7** of the master spec — see "Status" for exactly what works.

## Run locally

Requires Node 18+, Docker.

```bash
npm install
npm run db:up                      # Postgres on :5433
npm run -w api prisma:migrate      # apply migrations
npm run db:seed                    # demo data
npm run dev:api                    # http://localhost:4000
npm run dev:web                    # http://localhost:5173
```

Config lives in `apps/api/.env` (copy `.env.example`; set a real `JWT_SECRET`).

Seeded logins (password `Password123!`): `owner@demo.test`, `manager@demo.test`, `kitchen@demo.test`,
`waiter@demo.test`, `admin@tablely.test` (super admin). Demo storefront: `/r/the-minerva?table=T1`.

```bash
npm test          # API unit + integration tests (needs the database up)
npm run build     # production builds of api and web
```

## Status

**Working end to end (frontend ↔ API ↔ PostgreSQL, covered by automated tests where noted):**
- Registration, login, refresh-token rotation (httpOnly cookie), logout; owner-created staff accounts (tested)
- Roles OWNER / MANAGER / KITCHEN / WAITER / SUPER_ADMIN enforced server-side; tenant isolation by restaurant id taken from the verified token (tested)
- Restaurant settings, publish toggle, tax / service charge / delivery fee
- Menu: categories (reorder, rename), items, sizes, add-ons, discounted price, dietary/allergens, availability, duplicate, CSV import/export
- Public mobile storefront: search, veg filter, product options, persistent cart, coupons, tip, dine-in / takeaway / delivery checkout
- Server-side pricing (client totals ignored), atomic coupon redemption, per-restaurant order numbers (tested)
- Order workflow NEW→…→COMPLETED with role limits, kanban board (polls every 5 s), customer tracking page, mark-paid (tested)
- Customers created from orders, segments, loyalty points on completion (tested)
- Tables + QR codes (PNG / SVG endpoint, print from UI)
- Reservations with availability slots; double booking prevented by row locking in a transaction (tested with concurrent requests)
- Dashboard computed from real orders: date ranges, revenue/order/peak-hour charts, best sellers (tested)
- Super-admin: list restaurants, suspend/activate, change plan, platform totals
- Inventory: ingredients, suppliers, recipes per menu item, receive stock, wastage, stock-count reconciliation, movement ledger, low-stock alerts (inventory page + dashboard); stock is deducted exactly once when an order completes (tested)
- Kitchen display (`/app/kitchen`, full-screen, optional new-order sound): live tickets, server-clock timers, late alerts against the slowest dish's prep time, per-item ticking, prep-time stats
- Multi-outlet: owners add outlets (limit set per tenant by the super admin), switch between them, copy a menu into a new outlet, assign staff to one outlet, compare outlets side by side, and see one customer profile per phone number across outlets
- Subscriptions: plans, prices, limits and features live in the database (super-admin editable); trials, prorated upgrades, downgrades at renewal, cancellation, renewal invoices with a grace period, expiry; features and limits enforced server-side (tested)
- Loyalty: configurable points, Silver/Gold levels with earn multipliers, points ledger, redeem points into single-use vouchers locked to the customer's phone, referral bonuses with fraud guards, birthday vouchers (tested)
- Promotions: percent, fixed and buy-one-get-one offers, per-category offers, happy-hour windows, customer-specific codes, storefront banner (all priced on the server, tested)
- Marketing: consent-based email/WhatsApp campaigns by segment, one-click unsubscribe, honest sent/failed tracking, order and revenue attribution per campaign
- Delivery: zones (fee, minimum order, ETA) chosen at checkout and priced on the server, riders, assignment required before dispatch, ETA and rider contact on the tracking page (rider shown only once out for delivery)

- Reports and exports: 15 reports (daily and monthly sales, revenue by outlet, category and item, payment methods, order types, customer acquisition, repeat customers, popular items, peak hours, reservations, inventory usage, staff activity, discounts, refunds) computed in SQL from live data, downloadable as CSV, Excel or PDF (tested, including opening the Excel file with an independent library)

**Not built yet (so don't treat these as available):**
- Live Stripe/Razorpay verification (adapters written, never run against the real APIs), UPI intents, split payments, settlement reports
- WebSockets/real-time push (boards and kitchen screen poll every 4–5 s), split bills, waiter calls
- Image upload / S3 / CDN (menu images are URLs), custom domains, multi-language, Google Reviews
- Purchase orders, shifts/attendance, wallet-style cashback
- Customer feedback/reviews, inbound WhatsApp (e.g. STOP replies), scheduled/recurring campaigns, AI features, feature flags, support tickets, scheduled/emailed reports
- Redis/BullMQ, S3/CDN, ECS/Kubernetes manifests (the compose stack is tested; other platforms are not), Swagger docs, Playwright E2E tests, error-tracking/metrics
- Password reset, social login, onboarding wizard (registration + Settings + Menu cover the same steps manually)
- Time zones: reports use each restaurant's fixed UTC offset (Settings), which does not follow daylight saving; reservation availability slots still use the browser's offset

## Layout
```
apps/api   Express + Prisma (src/routes, src/lib/pricing.ts, prisma/schema.prisma, test/)
apps/web   React app (src/pages: public, storefront, dashboard, admin)
```

## Online payments

Flow: checkout with "Pay online now" → order is created as `PENDING_PAYMENT` (invisible to kitchen, excluded from revenue) →
customer is redirected to the provider's hosted page → provider calls `POST /api/payments/webhook/:provider` →
signature verified over the raw body, event id recorded once, amount compared with what we asked for → order becomes `NEW` / `PAID`.
Failed or expired payments cancel the order and release the coupon. Card data never touches this server.

| Provider | Needs | Status |
|---|---|---|
| `stripe` (Checkout Sessions) | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Signature verification tested with synthetic events; **API calls not yet run against Stripe** |
| `razorpay` (Payment Links) | `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` | Same: signature tested, **API calls not yet run against Razorpay** |
| `test` | `ENABLE_TEST_PAYMENTS=1` (ignored in production) | Fake provider + simulated payment page, exercises the real webhook path |

**Customer payments go to each restaurant's own provider account** (see "Restaurant payment accounts" below). The `STRIPE_*` / `RAZORPAY_*` / `PAYMENT_PROVIDER` variables in `.env` are now the **platform's own** account, used only for subscription invoices.
Refunds (full/partial, owner/manager): `POST /api/payments/refund {orderId, amountCents?}`; a ledger row is reserved under a row lock before the provider call, so concurrent requests can't over-refund.
Known gaps: no job that expires abandoned `PENDING_PAYMENT` orders; paid-after-cancel is flagged `PAID` but needs a manual refund; no reconciliation report.

## Inventory

Quantities are `Decimal(12,3)`; every change (purchase, wastage, count, order consumption) writes a `StockMovement` row and updates the balance in one transaction under a row lock.
Completed orders consume `recipe qty × order quantity`; a unique `(order, ingredient, reason)` key guarantees one deduction per order. Cancelled orders consume nothing.
Stock may go negative (an order is never blocked by a miscount) and shows as low. Known gaps: no purchase-order documents (receipts are recorded directly), no per-batch expiry (one expiry date per ingredient), no auto "sold out" when an ingredient runs out, no reversal if a completed order is later refunded.

## Kitchen display & delivery

Kitchen: `/app/kitchen` (roles KITCHEN, MANAGER, OWNER). Tickets are oldest-first; border turns amber at 70 % and red at 100 % of the target time (the slowest item's `prepMinutes`, minimum 10). Ticking items is only allowed while an order is ACCEPTED/PREPARING. Kitchen staff can accept, start and mark ready; completing/serving/dispatching stays with waiters and managers.
Delivery zones are named areas the customer picks (e.g. "Within 3 km"); there is **no geocoding or map distance calculation**, so "distance-based" charging means the zone you define. With no zones, the flat fee/minimum in Settings apply.
Known gaps: no live rider GPS/map tracking, no scheduled delivery slots, no third-party delivery-provider adapters, no auto-dispatch, no push notifications (screens poll), late threshold is not configurable per restaurant.

## Multi-outlet

An **outlet is a restaurant row inside a tenant**. Menu, prices, tables, orders, inventory, coupons, delivery zones and reservations are all scoped by restaurant id, so outlets are isolated from each other by the same mechanism that isolates tenants (tested). Each outlet has its own public URL and QR codes.
- The outlet limit is `Tenant.maxOutlets` (default 1), set by the super admin on the admin page; creation takes a row lock so concurrent requests can't exceed it. Plan tiers do **not** automatically set this limit.
- Owners switch outlet with `POST /api/auth/switch-outlet`; the choice is stored on the refresh token so it survives reloads. Managers, kitchen and waiter staff are pinned to the outlet they were assigned (existing staff were backfilled to their tenant's first outlet) and cannot switch.
- A copied menu is independent (prices/availability per outlet). Recipes, inventory, tables, coupons and delivery zones are **not** copied.
- `GET /api/outlets/compare` and `/api/outlets/customers` (owner only) give per-outlet revenue/orders and merged customer profiles. Loyalty points stay per outlet and are not redeemable across outlets; there is no cross-outlet inventory transfer, shared coupons, or outlet-level manager role that spans several outlets.

## Loyalty & marketing

**Loyalty** (Loyalty page, per outlet). Points = spend after discounts ÷ 100 × `pointsPer100` × level multiplier, credited when an order is COMPLETED; a unique key on (order, customer, reason) means one credit per order. Levels use lifetime points. Redeeming spends points with a conditional update (no double spend under concurrency) and creates a one-use voucher that only validates with the customer's phone number, so a leaked code is useless to others.
Points are redeemed by staff from the customer's profile, not by customers at checkout, because a phone number alone doesn't prove identity and there is no OTP/SMS login yet.
**Referrals**: a customer's code appears on their order tracking page. It only counts for a brand-new customer, never the same phone number (compared by digits), once per friend, and is paid to both only when the friend's first order is completed and spends over the minimum; each referrer has a cap.
**Birthdays**: collected optionally at checkout. A voucher is issued once per customer per year by an hourly in-process job (also "Issue now" on the Loyalty page). It shows on the customer's tracking page; it is *not* messaged automatically.
**Offers**: `PERCENT`, `FIXED`, `BOGO` (cheapest of each pair free), optional category, days/time window in the outlet's clock (Settings → restaurant clock, default UTC+5:30), minimum order, usage limit, single customer. A code that wouldn't discount anything in the cart is rejected rather than consumed.

**Campaigns** (Marketing page). Only customers who ticked the marketing box at checkout *and* haven't opted out receive them; this is re-checked at send time. Staff cannot grant consent, only record an opt-out. Every message carries a one-click unsubscribe link that opts the phone number out at every outlet of the brand. A message is marked sent only after the provider accepts it; rejections are recorded as failed with the reason. Attribution = orders using the campaign's coupon code from customers who were actually messaged, after it went out.
| Channel | Needs | Status |
|---|---|---|
| Email via Resend | `RESEND_API_KEY`, `EMAIL_FROM` | **Written, never run against the real API** |
| WhatsApp Cloud API | `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_ID`, `WHATSAPP_TEMPLATE` (approved template, 2 body variables) | **Written, never run against the real API**; marketing needs a Meta-approved template and opt-in |
| test | `ENABLE_TEST_MESSAGING=1` (ignored in production) | Records messages in memory, contacts nobody |
Known gaps: sending runs in the API process (no queue, so a restart mid-send leaves messages waiting), no retry of failed messages, no STOP-reply handling for WhatsApp, no open/click tracking, no A/B tests, no feedback collection, and consent wording/record-keeping for PDPA/GDPR is a legal task this code does not complete for you (consent is stored as a flag, not a dated audit record).

## Subscriptions

**Data**: `Plan` (price, currency, billing interval, trial days, limits, feature list, active), `Subscription` (one per business), `Invoice`, `SubscriptionPayment`. The four default plans were inserted by a migration with **placeholder prices**; edit or add plans in the admin portal. Nothing in code depends on a price. The public pricing section reads `GET /api/public/plans`.
**Lifecycle**: registration starts a trial (`?plan=PRO` on the sign-up link picks the plan; default `DEFAULT_PLAN_CODE`, Growth). A trial unlocks **every** feature. When it ends the chosen plan is invoiced and the account is `PAST_DUE` (still working) for `BILLING_GRACE_DAYS` (default 7); unpaid after that it becomes `EXPIRED`. Paying an invoice activates the plan.
- **Upgrade** (higher monthly-equivalent price): charged now, prorated for the rest of the paid period; the plan switches only when the payment is confirmed; the period dates don't change.
- **Downgrade**: scheduled; the current plan stays until renewal, then the new plan is invoiced. Changing your mind cancels it.
- **Cancel**: access continues to period end, then `CANCELED` with no further invoice. Can be undone before then.
- **Renewal / trial-end / expiry** is an idempotent job (hourly in the API process, on demand when the owner opens Billing, and "Run billing job now" in admin). A unique key per subscription, kind and period stops duplicate invoices.
- Payments go through the same provider adapters and signed webhook as order payments (including the dev-only `test` provider).
**What is enforced on the server** (HTTP 402 with a clear message): `online_payments` (setting + checkout), `reservations` (staff and storefront), `crm` (customers), `promotions` (coupons, also at checkout), `loyalty` (config, points, redemption, referrals), `inventory`, `marketing` (campaigns), `multi_outlet` (creating a 2nd outlet); limits: staff accounts, menu items per outlet, outlets. When a subscription ends the storefront stops accepting orders and bookings (it can still be browsed), gated features stop, but staff can still see and finish orders and open Billing.
Plan limits for outlets are copied to the tenant's outlet limit when a plan changes (the admin can still override it afterwards).

**Important limitations**
- Subscription invoices are paid to the platform's own provider account (the `.env` keys). Restaurants' customer payments use the restaurants' own accounts (below).
- **No automatic card charging.** Each renewal is an invoice the owner pays through the provider's hosted page; there are no saved cards, retries, dunning emails or reminders (the banner and Billing page are the only prompts).
- No tax/GST on invoices, no invoice PDF or numbering per legal requirements, no refunds or credit notes for subscriptions (handle in the provider dashboard), no coupons for subscriptions, no usage-based billing.
- Plan feature labels `custom_domain`, API access, advanced permissions, priority support and advanced analytics from the spec are **not** plan features here because those capabilities don't exist yet.
- Existing businesses were grandfathered with a year of active service on their previous plan.

## Restaurant payment accounts

Each restaurant connects **its own** Stripe or Razorpay account in Settings → Online payments (owner only), so customer money goes straight to the restaurant and never through the platform's account.
- The owner pastes API keys; the server **checks them with one read-only call to the provider** before saving (Stripe `GET /v1/account`, Razorpay `GET /v1/payments?count=1`). Invalid keys are never stored.
- Secrets are encrypted with AES-256-GCM (`SECRETS_KEY`, required in production, at least 32 characters) and are **never returned by the API**; the UI shows only a hint (last 4 characters / key id). Keep `SECRETS_KEY` backed up and stable: there is no rotation yet, and changing it makes stored keys unreadable.
- Each account gets its own webhook URL `/api/payments/webhook/<provider>/<token>` and the owner pastes that into their provider along with the signing secret. The token chooses whose secret verifies the signature, and an event can only settle payments created through that same account, so one restaurant can never settle or forge another's payments (tested).
- Every payment records the account that created it. If the owner replaces or disconnects credentials, the old account is kept (inactive): refunds use the original account's credentials and late webhooks still work. Only one account is active at a time.
- Outside production only **test** keys are accepted (`ALLOW_LIVE_PAYMENT_KEYS=1` overrides), so a development server cannot take real money by accident.
- Restaurants that used online payments before this change have no connected account, so online payment is switched off for them until they connect one; their old payments remain refundable through the platform keys they were created with.

**Not built**: Stripe Connect / OAuth onboarding (owners paste keys instead), key rotation, automatic payouts/settlement reports and reconciliation against provider statements, and the Stripe and Razorpay calls have still never been run against the real providers (they are covered by tests with a faked HTTP layer).

## Reports and exports

`/app/reports` (owner and manager). Every report is an SQL aggregate over the live tables, not a stored or estimated number.

- **Definitions.** A *sale* is an order that is not cancelled and not waiting for its online payment. Money is summed in minor units (paise/cents). Each report lists its own definitions underneath the table.
- **Time zone.** Days, months and hours follow the restaurant's own clock (a fixed UTC offset set in Settings), so every viewer sees the same numbers for the same day. A restaurant in a daylight-saving region must change the offset twice a year. The outlet comparison applies each outlet's own offset, and refuses to add money across different currencies.
- **Periods.** Today, yesterday, last 7/30 days, this/last month, or two dates, up to 366 days. Empty days are shown as zero rows so charts have no gaps.
- **Exports.** CSV (UTF-8 with a byte-order mark so Excel reads it correctly; text starting with `=`, `+`, `-` or `@` is neutralised against spreadsheet formula injection), Excel (`.xlsx` with real numbers, number formats, bold totals and a frozen header row; text is stored as inline strings, never formulas) and PDF (landscape A4, header repeated on every page, page numbers).
- **Access.** Owner and manager only. *Revenue by outlet* is owner-only. Basic reports are on every plan; the rest need the `advanced_reports` feature (Pro and Enterprise, editable in the admin console; every trial includes it). The server enforces both, and exports are rate limited (`EXPORT_RATE_LIMIT`, default 20 per user per minute) and written to the audit log.
- **Limits you should know.** The PDF uses built-in fonts, so characters outside Western European languages print as "?" (CSV and Excel are fine). Refunds on cash orders are recorded as the full order total because the system only records "refunded" for cash. The staff report counts status changes, not quality. Inventory usage shows today's balance, not the closing balance for the period.

## Security

A full audit was done; see **[SECURITY.md](SECURITY.md)** for what was found and fixed, what was verified, the open items (notably: no password reset, email verification or MFA yet) and a deployment hardening checklist.
Settings that matter when you deploy (all optional in development; the API refuses to start in production without the required ones):
`TRUST_PROXY` (number of proxies in front, default 0), `API_RATE_LIMIT` (per IP per minute, default 600), `MAX_FAILED_LOGINS` / `LOCK_MINUTES` (default 8 / 15), `AUTH_CACHE_MS` (default 10000), `REFRESH_REUSE_LEEWAY_MS` (default 3000), `ADMIN_EMAIL` / `ADMIN_PASSWORD` (first platform admin in production; the demo seed is skipped there).

## Password reset, email confirmation and MFA

Users reset forgotten passwords from the login page (`/forgot-password`); a new business owner gets a confirmation link by email; anyone can turn on two-step verification under Account (authenticator app + 10 recovery codes). The platform admin must use MFA in production.
**Email delivery is required for this to work**: set `RESEND_API_KEY` and `EMAIL_FROM` (a sender verified with Resend; set up SPF/DKIM for the domain). In development with `ENABLE_TEST_MESSAGING=1` nothing is sent; the message, including its link, is printed in the API console as a `dev.email` JSON line. Details and limits: [SECURITY.md](SECURITY.md#account-recovery-and-mfa-added-after-the-audit-above).
Settings: `MFA_REQUIRE_ADMIN` (1 = force for the platform admin even in development; 0 = switch off the production default), `REQUIRE_VERIFIED_EMAIL` (0 disables the confirmation gate), `AUTH_RATE_LIMIT`, `MAIL_RATE_LIMIT`.

## Deploying

See **[DEPLOY.md](DEPLOY.md)**. In short: `docker-compose.prod.yml` runs HTTPS (Caddy) → nginx (app + security headers) → API → PostgreSQL on one server; `.github/workflows` provide CI and tag-triggered deploys with automatic rollback; `deploy/backup` has verified backup and restore scripts. Development stays as described at the top (`docker-compose.yml` is the dev database only).
