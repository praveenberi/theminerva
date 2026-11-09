# Deployment

## Environment variables (server)
Required: `DATABASE_URL`, `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` (32+ random chars each), `WEB_ORIGIN`, `PUBLIC_WEB_URL`, `NODE_ENV=production`.
First run: set `SEED_OWNER_EMAIL`, `SEED_OWNER_PASSWORD`, run `npm run db:seed` (no demo data), then change the password.

| Integration | Variables | Notes |
|---|---|---|
| Stripe (card, PayNow) | `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET` | Webhook URL `https://<domain>/api/payments/webhook`; events `payment_intent.succeeded`, `payment_intent.payment_failed`. Enable PayNow in Stripe for SGD. |
| Razorpay (UPI, cards) | `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` | Same webhook URL; events `payment.captured`, `payment.failed`. |
| Email | `RESEND_API_KEY`, `EMAIL_FROM` | Verified sending domain required. |
| WhatsApp | `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_ID` | Meta Cloud API; approved templates needed outside the 24h window. |
| SMS | `TWILIO_SID`, `TWILIO_TOKEN`, `TWILIO_FROM` | Adapter present; not yet wired to notification events. |
| AI | `ANTHROPIC_API_KEY`, optional `ANTHROPIC_MODEL` | Enables assistant, descriptions, translations, marketing copy. |
| CDN | `CDN_URL` | Prefix for uploaded image URLs. Mount a persistent volume/EFS at `server/uploads`. |

Google Analytics / Meta Pixel / Search Console IDs are entered in the dashboard (Settings → Website & SEO).

## Single host
`cp .env.example .env`, edit, `docker compose up -d --build`. Put TLS (Caddy/ALB/Cloudflare) in front of port 8080. The API runs `prisma migrate deploy` on start — verify the migration on a staging database first.

## AWS (ECS Fargate)
Two services (api, web) behind an ALB: `/api/*`, `/ws`, `/uploads/*`, `/sitemap.xml`, `/robots.txt` → api; everything else → web. RDS PostgreSQL 16 with automated backups and PITR, EFS for uploads, CloudFront in front of the ALB, secrets in Secrets Manager injected as env vars, pino JSON logs to CloudWatch. Run a single API task unless you add Redis pub/sub for WebSockets.

## Backups and recovery
`pg_dump -Fc "$DATABASE_URL" > minerva-$(date +%F).dump` nightly, plus copy `uploads/` offsite. Restore into an empty database with `pg_restore -d "$DATABASE_URL" --clean minerva-YYYY-MM-DD.dump`. Rehearse quarterly.

## Before launch
Replace demo accounts; set strong secrets; force HTTPS; have the policy pages reviewed by a lawyer; set webhook secrets before enabling online payments; restrict database network access.
