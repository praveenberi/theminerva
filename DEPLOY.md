# Deploying Tablely

This guide takes you from an empty Linux server to a running, HTTPS-protected installation, and covers updates, backups and what to watch.
Everything marked **verified** was run for real (see "What has and hasn't been tested").

## What you get

```
Internet ──443──▶ Caddy ──▶ web (nginx) ──┬── static files (the React app)
                (HTTPS,                   └── /api ──▶ api (Node) ──▶ PostgreSQL
              auto certificates)
```

- **Caddy** gets and renews a free Let's Encrypt certificate for your domain and is the only thing exposed to the internet (ports 80 and 443).
- **web** serves the app with strict security headers (CSP, nosniff, frame denial…) and forwards `/api` to the API. One domain for everything, so cookies and CORS stay simple.
- **api** runs as an unprivileged user with a read-only filesystem and all Linux capabilities dropped. It drains in-flight requests on shutdown, so a deploy does not cut off a customer mid-order.
- **migrate** is a one-off job that applies database migrations before the API starts. If it fails, the API is never started on a half-migrated database.
- **db** is PostgreSQL, reachable only inside the compose network.

## Before you start

| Need | Notes |
|---|---|
| A Linux server | 2 vCPU / 2–4 GB RAM / 20 GB disk is plenty to start. Any provider. Ubuntu 22.04+ is what the commands assume. |
| Docker Engine + Compose plugin | `curl -fsSL https://get.docker.com | sh`, then log out and in. |
| A domain name | An `A` (and `AAAA`) record for e.g. `app.example.com` pointing at the server **before** you start, or certificate issuance fails. |
| Ports 80 and 443 open | And nothing else. Block everything else at the provider firewall; keep SSH restricted to your IP if you can. |
| An email provider | **Required.** Password reset and email confirmation cannot work without it. Create a [Resend](https://resend.com) account, verify your sending domain (add the SPF, DKIM and DMARC records it shows) and create an API key. |
| (Later) payment providers | Only if you will charge subscriptions: a Stripe or Razorpay account for the *platform*. Restaurants add their own keys in Settings. |

## First-time setup

```bash
# 1. get the code onto the server
sudo mkdir -p /opt/tablely && sudo chown "$USER" /opt/tablely
git clone <your-repo-url> /opt/tablely && cd /opt/tablely

# 2. configure
cp deploy/.env.production.example .env.production
chmod 600 .env.production
nano .env.production          # fill in every value (see the table below)

# 3. start everything (first run builds the images, ~2 minutes)
docker compose --env-file .env.production -f docker-compose.prod.yml up -d --build

# 4. check it
docker compose --env-file .env.production -f docker-compose.prod.yml ps     # all "healthy"
curl -s https://app.example.com/api/ready                                    # {"ok":true}

# 5. create the first platform admin (a long passphrase; it is read from the environment, not stored in shell history if you use a prompt)
read -rsp "Admin password: " P; echo
docker compose --env-file .env.production -f docker-compose.prod.yml run --rm \
  -e ADMIN_EMAIL=you@example.com -e ADMIN_PASSWORD="$P" api node dist/scripts/createAdmin.js; unset P
```

Then open `https://app.example.com/login`, sign in as the admin and **set up two-step verification first**: in production the admin account can do nothing else until it has it. Save the recovery codes somewhere safe.

The database starts with four **placeholder plans** (Starter, Growth, Pro, Enterprise at ₹499–₹4,999/month). Edit them in the admin page before inviting customers.

### Settings (`.env.production`)

| Variable | Required | What it is |
|---|---|---|
| `DOMAIN` | yes | Public hostname. Caddy requests a certificate for it. |
| `WEB_ORIGIN`, `PUBLIC_API_URL` | yes | `https://` + the domain (same value for both in this layout). Used for CORS/CSRF checks, and in email links and webhook URLs. |
| `TRUST_PROXY` | yes | `2` for this layout (Caddy + nginx in front of the API). A wrong number lets clients fake their IP and dodge rate limits (**verified**: with `2`, spoofed `X-Forwarded-For` does not help). |
| `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB` | yes | Use a random hex password (`openssl rand -hex 24`). Not the development `tablely` password: the API refuses to start with it. |
| `JWT_SECRET` | yes | 48+ random characters. Signing key for sign-in tokens. Changing it signs everyone out. |
| `SECRETS_KEY` | yes | 32+ random characters. Encrypts restaurants' payment-provider keys. **Back it up separately from the database**: if it is lost, restaurants must re-enter their keys. There is no rotation yet. |
| `RESEND_API_KEY`, `EMAIL_FROM` | yes | Email delivery (see above). |
| `PAYMENT_PROVIDER`, `STRIPE_*` / `RAZORPAY_*` | for subscriptions | The **platform's** account, used only to bill restaurants for plans. In Stripe/Razorpay, add the webhook `https://<domain>/api/payments/webhook/stripe` (or `/razorpay`) and paste its signing secret. |
| `WHATSAPP_*` | optional | Marketing messages over WhatsApp Cloud API (needs an approved message template). |
| `DEFAULT_PLAN_CODE` | optional | Plan trialled by new sign-ups. |
| `HTTP_PORT`, `HTTPS_PORT` | optional | Leave at 80/443 in production. |

The API **refuses to start** in production if any of these are missing or look like development values (placeholder `JWT_SECRET`, no `SECRETS_KEY`, `http://` origins, the dev database password, no email provider, test providers switched on). Read its first log lines if it exits at start: it lists every problem.

## Updating

**By hand** on the server:

```bash
cd /opt/tablely && git pull
docker compose --env-file .env.production -f docker-compose.prod.yml up -d --build
```

**Automatically from GitHub** (recommended). The repository ships two workflows in `.github/workflows/`:

- `ci.yml` runs on every push and pull request: applies all migrations to an empty database, checks the migrations reproduce `schema.prisma` exactly, type-checks, runs the full test suite, builds the web app, audits dependencies (fails on *critical* advisories) and builds both Docker images.
- `deploy.yml` runs when you push a tag like `v1.2.0` (or run it manually): builds and publishes images to GitHub Container Registry, then SSHes to the server and runs `deploy/remote-deploy.sh`, which pulls the new images, **applies migrations first (aborting before anything changes if they fail)**, restarts, waits for the API to be healthy and **rolls back to the previous images automatically if it is not** (**verified** with a deliberately crashing release).

One-time setup for the automatic route:

1. Put this repository on GitHub (`git init`, commit, push).
2. On the server, in `.env.production` add `API_IMAGE_REPO=ghcr.io/<owner>/tablely-api` and `WEB_IMAGE_REPO=ghcr.io/<owner>/tablely-web` (lowercase), and run `docker login ghcr.io` with a personal access token that has `read:packages`.
3. Create a deploy user on the server that may run Docker and write `/opt/tablely`, and an SSH key pair for it.
4. In GitHub → Settings → Secrets: `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_SSH_KEY` (private key), `DEPLOY_KNOWN_HOSTS` (output of `ssh-keyscan your-server`).
5. In GitHub → Settings → Environments, create **production** and add yourself as a required reviewer, so every deploy waits for your approval.

**Migrations only move forward.** Write them so the *previous* version of the app still works on the new schema (add columns/tables first, remove old ones in a later release). Otherwise the automatic rollback restores old code onto a schema it can't use.

## Backups and disaster recovery

```bash
deploy/backup/backup.sh            # writes backups/tablely-<timestamp>.dump (compressed, verified readable, mode 600)
deploy/backup/restore.sh backups/tablely-<timestamp>.dump     # restores into a SCRATCH database "restore_check" and prints row counts
```

Both verified: a dump is read back before it is kept, and a restore reproduces the live data. The restore script refuses to overwrite the live database and rejects unsafe database names.

1. **Schedule it**: `crontab -e` → `15 3 * * * cd /opt/tablely && deploy/backup/backup.sh >> /var/log/tablely-backup.log 2>&1` (keeps 14 days by default; `KEEP_DAYS=30` to change).
2. **Copy the dumps off the server** every day (object storage, another machine). A backup on the same disk dies with the server.
3. **Back up `.env.production`** (especially `SECRETS_KEY` and `JWT_SECRET`) in a password manager or secrets vault, separately from the dumps.
4. **Do a restore drill** every few months: run `restore.sh` on a recent dump and check the counts.

**If the server is lost**: provision a new one, repeat "First-time setup" with the same `.env.production`, but before step 3 start only the database (`up -d db`), restore the newest dump into the live database name with `pg_restore` (stop the API first), then `up -d`. Test this once; you do not want to learn the steps during an outage.

## Watching it run

- **Health**: `GET /api/health` (alive) and `GET /api/ready` (can reach the database). Point an uptime monitor (UptimeRobot, Better Stack…) at `https://<domain>/api/ready`. Compose and the deploy script already use the same check.
- **Logs**: `docker compose --env-file .env.production -f docker-compose.prod.yml logs -f api`. They are one JSON object per line, rotated at 10 MB × 5 files. Every request line has an `id`; the same id is returned to the browser as `X-Request-Id`, so a customer's error report can be traced to one line. Tokens inside URLs are redacted.
- **Alert on these events** (each is a JSON line with an `event` field): `auth.account_locked`, `auth.refresh_reuse`, `payment.amount_mismatch`, `subscription.payment_for_closed_invoice`, `mail.failed`, `mail.not_configured`, `unhandled_error`, `billing.run_failed`. A log shipper (Loki, Datadog, CloudWatch) can match on them.
- **Not included**: error tracking (Sentry), metrics/dashboards, tracing. Add them before you depend on this commercially.

## Scaling and other platforms

The stack above is one server. To run **several API instances** (or on ECS, Kubernetes, Fly, Render…) the same images and settings apply: run `prisma migrate deploy` (the `migrate` command) once per release as a one-off task, health-check `/api/ready`, set `TRUST_PROXY` to the number of proxies in front, and use a managed PostgreSQL. Know these limits first:

- Rate limiting and the login-state cache are **per process**; limits multiply with the number of instances and a permission change can take up to 10 s (`AUTH_CACHE_MS`) to reach all of them. Move limits to a shared store (Redis) before scaling out.
- The hourly background jobs (billing renewals, birthday vouchers) run in **every** instance. They are idempotent so this is safe, just redundant.
- Campaign sending runs inside the API process (no queue): a restart mid-send leaves messages waiting.
- Menu images are plain URLs; there is no object storage or CDN. Add one before restaurants upload photos.

The ECS/Kubernetes route is **not tested**; only the compose stack was run.

## Hardening checklist for the server

- Provider firewall: allow 80/443 (and SSH from your IP only). Nothing else; the database is not published.
- SSH keys only, no root login, `unattended-upgrades` on, a non-root user for Docker.
- `.env.production` mode 600, owned by the deploy user, never committed (`.gitignore` already excludes it).
- Scan images regularly (`docker scout cves tablely-api:…` or Trivy) and rebuild monthly to pick up base-image fixes.
- Pin GitHub Actions to commit SHAs and enable Dependabot for npm, Docker and Actions.
- Review [SECURITY.md](SECURITY.md): open items there (e.g. dependency advisories, optional MFA for owners) apply to production.

## What has and hasn't been tested

**Verified in a local dry run** (images built, full stack started with `docker-compose.prod.yml`): empty-database migration chain; migrations match `schema.prisma` (no drift); all services healthy; HTTPS through Caddy; security headers and caching; SPA deep links; the API's own checks (`/api/health`, `/api/ready`); secure cookie flags; cross-site refresh refused; rate limit not bypassable via `X-Forwarded-For`; admin creation command (including refusal of weak passwords and idempotence); production MFA enforcement for the admin; graceful shutdown (1 s, exit 0); backup, verified restore and the restore script's refusals; the deploy script's success path and its automatic rollback on a crashing release; the full test suite run the way CI runs it (no `.env`); the two GitHub workflows linted with `actionlint` and the shell scripts with ShellCheck.

**Not tested**: the GitHub workflows themselves (they need a GitHub repository), pulling images from GHCR, certificate issuance from Let's Encrypt (the dry run used Caddy's local CA on `localhost`), real email delivery, real Stripe/Razorpay calls, running on ECS or Kubernetes, and behaviour under real load. In the dry run the HTTP→HTTPS redirect dropped the non-standard port; on 80/443 that does not arise.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `api` exits at start | Read `docker compose … logs api`: production config problems are listed one per line. |
| `migrate` fails | The database is unreachable or a migration conflicts with existing data; read its log. The API is not started. |
| Browser shows a certificate warning | DNS not pointing at the server yet, ports 80/443 blocked, or `DOMAIN` is `localhost`. Check `docker compose … logs caddy`. |
| Everyone gets `429 Too many requests` | `TRUST_PROXY` is wrong, so all visitors look like one IP. It should be `2` in this layout. |
| "Cross-site request refused" at login/refresh | `WEB_ORIGIN` does not exactly match the address in the browser (scheme, host, port). |
| No password-reset or confirmation emails | `mail.failed` / `mail.not_configured` in the API logs; check the Resend key, the verified sender domain and spam folders. |
| Restaurants' online payments fail after a restore on a new server | `SECRETS_KEY` differs from the original, so stored provider keys cannot be decrypted. Restore the original key. |
