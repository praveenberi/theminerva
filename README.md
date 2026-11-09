# The Minerva — website, ordering and restaurant management

One restaurant, one database, one backend. No tenants, no marketplace, no platform admin.
`server/` Express + Prisma + PostgreSQL · `web/` React + Vite + Tailwind + Motion · `docs/` guides.

## Run locally (Node 18+; Docker optional)

```bash
cd server && npm install
npm run db:local          # embedded PostgreSQL on :5433 (or use your own / docker compose up db)
npm run db:push           # create tables (production uses `npm run db:deploy` migrations)
npm run db:seed:demo      # demo staff, sample menu, tables (use `db:seed` for a clean production seed)
npm run dev               # API on :4000, docs at /api/docs

cd ../web && npm install && npm run dev    # site on http://localhost:5173, admin at /admin/login
```

Demo logins (password `Minerva@12345`): admin@ / manager@ / kitchen@ / waiter@ / cashier@ / driver@ `theminerva.com`.
**Demo data is placeholder content** — the real address, hours, menu and photos are entered in the dashboard.

## Tests

| Suite | Command | Covers |
|---|---|---|
| API (Vitest + Supertest, isolated `minerva_test` DB) | `cd server && npm test` | auth, RBAC, menu, pricing, orders, inventory, loyalty, reservations (concurrency), payments/webhooks/refunds, reports, privacy |
| Web unit (Vitest + RTL) | `cd web && npm test` | cart, form accessibility, modal, formatting |
| End-to-end (Playwright) | `cd web && npm run e2e` (`PW_CHANNEL=chrome` to use installed Chrome) | guest order → staff accept/prepare/ready/complete → customer sees completion; reservations; role limits; menu editing; mobile |

## Production

`docker compose up --build` (see `docs/DEPLOY.md` for ECS/S3/CloudFront, backups, env vars and every integration's credentials).
CI: `.github/workflows/ci.yml`.

## What is real vs. needs your credentials

Implemented and tested here: everything in the test table. **Adapters written but not exercised against live providers** (no credentials in this environment): Stripe, Razorpay, Resend email, WhatsApp Cloud API, Twilio SMS, Anthropic AI. Until configured they report "not configured"; nothing is simulated (payments are never marked paid without a verified provider webhook; messages are logged SKIPPED/FAILED, never SENT).

## Known gaps (be aware before launch)

- No S3 driver and no BullMQ workers: background jobs run in-process and Redis is unused. Uploads go to Cloudinary when `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY` and `CLOUDINARY_API_SECRET` are set (free tier; unit-tested with a mocked API, not yet run against a real account), otherwise to `server/uploads` on local disk.
- The initial migration SQL was generated from the schema but not applied to a clean database here (tests use `db push`). Docker images and the CI workflow were written but not run here.
- Delivery fees are postal-prefix zones (no distance/maps calculation); no third-party delivery-service adapters.
- Multi-outlet: branches, branch prices/availability, branch-scoped staff, dashboard filter and comparison are built. Not branch-aware yet: inventory stock, coupons/campaigns, reservations and reports other than the dashboard and comparison.
- Split payments are supported by the API (partial payments, bill splitting is display-only); no UPI intent or settlement-provider reconciliation beyond the CSV report.
- Image cropping/optimisation, SMS delivery, scheduled reservation reminders and review import from Google are not built.
- "Order again" skips size selection for dishes with sizes (the checkout will ask for a valid cart).
- No load testing or external security audit has been done.

Docs: `docs/DEPLOY.md`, `docs/ADMIN_GUIDE.md`, `docs/STAFF_GUIDE.md`; API reference at `/api/docs`.
