# Security audit: Tablely

Scope: the code in this repository (API, web app, database schema, seed and Docker files). Method: manual code review of every route and
middleware, a dependency audit (`npm audit`), then **evidence-first fixing**: for each weakness a test was written that failed on the old
code and passes on the new code (`apps/api/test/security.test.ts`, `isolation.test.ts`, `fuzz.test.ts`), plus a smoke test of the
production build in a browser. Tests: 127 passing. The account-recovery work (R-01 below) was added afterwards; see "Account recovery and MFA".

**Not in scope / not verified**: the deployed environment (TLS, firewalls, database hosting, backups, secrets storage), the real Stripe, Razorpay,
Resend and WhatsApp services (adapters have only run against fakes), and anything an attacker could do with access to the server or the database.
This is a thorough review, not a penetration test or a guarantee.

## Fixed

| # | Severity | Weakness | Fix |
|---|---|---|---|
| S-01 | **High** | A **suspended business kept full access**: access tokens stayed valid for 15 minutes and the refresh token could renew them indefinitely. | Every request now re-checks the user and business status (10 s cache, cleared at once on changes); refresh refuses suspended businesses. |
| S-02 | Medium | Deactivated staff, staff moved to another outlet, or a changed role kept their old authority until the token expired. | Same live check; a moved/changed user's old token is rejected so the client re-authenticates. Deactivation also revokes refresh tokens. |
| S-03 | Medium | A replayed (already used) refresh token was just refused; theft went unnoticed. | Reuse revokes **all** of that user's sessions and logs `auth.refresh_reuse` (3 s leeway for two tabs racing). |
| S-04 | Medium | Only a per-IP limit protected logins; response time revealed whether an email exists. | Per-account lockout (8 failures, 15 min), identical answer for wrong password / unknown / locked, constant-time hashing, lockout is logged. |
| S-05 | Medium | Cookie-based endpoints (refresh, logout, switch outlet) accepted requests from other sites' pages. | Origin check on those endpoints (on top of `SameSite=Lax`, httpOnly, secure-in-production). |
| S-06 | Medium | JWT algorithm not pinned; tokens not bound to this service. | HS256 only, issuer and audience required. |
| S-07 | Medium | 8-character minimum; passwords over 72 bytes were silently truncated by bcrypt. | 10 to 72 characters, common/repetitive passwords refused, change-password endpoint and Account page (signs out other devices). |
| S-08 | Medium | Unsubscribe happened on a plain GET, so mail scanners and link previews could opt customers out. | GET shows a confirmation page; only POST unsubscribes. Output HTML-escaped. |
| S-09 | Medium | CSV export could carry spreadsheet formulas (`=HYPERLINK(...)`) typed into menu item names. | Cells starting with `= + - @` are prefixed with `'`. |
| S-10 | Medium | `trust proxy` was hard-coded to 1, so clients could spoof `X-Forwarded-For` and walk around every rate limit; there was no global limit. | `TRUST_PROXY` setting (default 0), global per-IP limit (600/min) besides the tighter ones. |
| S-11 | Medium | Tracking codes, unsubscribe tokens and webhook tokens (bearer secrets in URL paths) were written to request logs. | Paths are redacted before logging. |
| S-12 | **High if deployed** | The seed script created well-known accounts (`admin@tablely.test`, password `Password123!`) in any environment. | Refuses to run in production without `ADMIN_EMAIL` / a 14+ character `ADMIN_PASSWORD`, and then creates only that admin. |
| S-13 | Medium | The development database (password `tablely`) was published on all network interfaces. | Bound to `127.0.0.1`. |
| S-14 | Medium | Nothing stopped a production start with a placeholder `JWT_SECRET`, no `SECRETS_KEY`, http origins or dev DB credentials. | Startup refuses in production with a list of problems. |
| S-15 | Low | A NUL character in any text field or URL crashed the query: an unhandled 500 and a stack trace in the logs (found by fuzzing). | Rejected up front with 400; defensive handler for the database error. |
| S-16 | Low | Kitchen staff could see customers' phone numbers and addresses. | Redacted for the kitchen role. |
| S-17 | Low | Request bodies up to 1 MB (amplifies the zod advisory below). | 100 KB default, 700 KB only for the CSV import, 256 KB for webhooks; oversize gets 413. |
| S-18 | Low | API responses were cacheable although they carry tokens and personal data. | `Cache-Control: no-store` on `/api`. |
| S-19 | Low | Menu image URLs accepted any scheme (`javascript:`, `data:`). | http(s) only. |
| S-20 | Low | The web app had no Content-Security-Policy; the QR print window used `document.write`. | CSP added to the production build (verified: no violations across 10 dashboard pages and the storefront); print page built from escaped HTML. |
| S-21 | Low | Payment redirect used a server-supplied URL without checking its scheme; Razorpay webhook secret could be 6 characters. | Only http(s)/same-site targets; secret must be 16+ characters. |
| S-22 | Functional | The seeded demo business had no subscription, so it would be "inactive" on a fresh database. | Seed creates one. |

## Checked and found sound

- **Tenant and outlet isolation**: an automated sweep attacks 32 id-addressed write endpoints and the read endpoints of one business with another business's token; nothing is returned or changed.
- **SQL injection**: all queries use Prisma or parameterised raw queries; hostile strings (SQL, markup, template syntax, NUL, control characters, huge Unicode, prototype keys, malformed JSON) were fuzzed through search, forms and the public order flow without a server error.
- **XSS**: no `dangerouslySetInnerHTML`; React escapes output; the few HTML strings we build are escaped.
- **Payments**: signatures verified in constant time (Stripe also checks a 5-minute timestamp), events de-duplicated, amounts compared with what was requested, refunds serialised and capped, per-restaurant webhooks cannot touch other restaurants' payments.
- **Secrets**: restaurants' provider keys are AES-256-GCM encrypted and never returned; refresh tokens are stored only as hashes; passwords use bcrypt (cost 12); tracking, voucher, unsubscribe and webhook tokens are random (72 to 192 bits).
- **Privileges**: owner-only actions (staff, settings, billing, payment accounts, outlets) and manager/staff limits are enforced on the server; the dev-only test payment and messaging providers are ignored in production.

## Accepted risks and open items (not fixed)

| # | Priority | Item |
|---|---|---|
| R-01 | Medium | **Password reset, email confirmation and MFA now exist** (see below). What remains: MFA is optional for owners and staff (only the platform admin is forced in production); no passkeys/WebAuthn or SMS; no "new sign-in" alert emails; reset security is only as strong as the user's mailbox, so the sending domain needs SPF/DKIM/DMARC. |
| R-02 | Medium | `zod` 3.x has a high-severity advisory (memory exhaustion on oversized collections). The fix is zod 4 (a breaking upgrade that also needs newer `@hookform/resolvers`). Mitigated by the 100 KB body limit; schedule the upgrade. |
| R-03 | Low | `react-router` 6.x advisory (open redirect via backslash; SSR error deserialisation). Not reachable here: no navigation target comes from users and there is no server rendering. Fixed only in v7; schedule the upgrade. |
| R-04 | Medium | Rate limits and the login/auth cache are **per server process**. With several instances, limits multiply and permission changes take up to 10 s to reach all of them. Use a shared store (Redis) for limits when scaling out. |
| R-05 | Medium | Anyone can place cash orders on a published storefront (30 per minute per IP). A determined abuser can flood a kitchen with fake orders from many IPs. Consider phone OTP, CAPTCHA and per-restaurant throttles. |
| R-06 | Low | Registration still reveals whether an email is taken (409). Email confirmation now limits what an unconfirmed account can do (no campaigns, no payment account), but it does not stop someone registering an address they do not own. |
| R-07 | Low | `SECRETS_KEY` has no rotation procedure; losing it makes stored provider keys unreadable. |
| R-08 | Low | Security events are written to the console (lockouts, refresh reuse, payment anomalies) but there is no audit-log viewer, alerting or retention policy. |
| R-09 | Info | Stripe, Razorpay, Resend and WhatsApp adapters have not been run against the real services. Start with test keys. |
| R-10 | Info | The API and web app should share a registrable domain (e.g. `app.example.com` and `api.example.com`). The refresh cookie is `SameSite=Lax`; a cross-site deployment would require `SameSite=None`, which leans entirely on the Origin check. |

## Deployment hardening checklist

Most of this is now provided by the repository and described in [DEPLOY.md](DEPLOY.md) (TLS via Caddy, headers via nginx, production config guard, admin creation command, backups). What remains is yours to do on the server:

1. Terminate TLS in front of both the API and the web app; send `Strict-Transport-Security` (the API already sets it through helmet).
2. Serve the web app's static files with real response headers, not only the `<meta>` CSP: `Content-Security-Policy` (same value as in `apps/web/vite.config.ts`, plus `frame-ancestors 'none'`), `X-Content-Type-Options: nosniff`, `Referrer-Policy`, `Permissions-Policy`.
3. Set `NODE_ENV=production`, a random `JWT_SECRET` (48+ chars), `SECRETS_KEY` (32+ chars, backed up separately from the database), `WEB_ORIGIN`, `PUBLIC_API_URL` (both `https://`), `TRUST_PROXY=<number of proxies in front>`.
4. Use a managed database with its own credentials, no public network access, encrypted backups and a tested restore. Never reuse the development `tablely` credentials.
5. Create the first admin with `ADMIN_EMAIL` / `ADMIN_PASSWORD` set; change that password in the Account page and remove the variables.
6. Keep `ENABLE_TEST_PAYMENTS`, `ENABLE_TEST_MESSAGING` and `ALLOW_LIVE_PAYMENT_KEYS` unset.
7. Run `npm audit` in CI and update dependencies regularly; add the two upgrades above to the backlog.
8. Alert on the log events `auth.account_locked`, `auth.refresh_reuse`, `payment.amount_mismatch` and `subscription.payment_for_closed_invoice`.

## Reports and exports (added after the audit above)

| Area | What it does |
|---|---|
| Tenant isolation | Every report query is bound to the restaurant id from the verified token. The outlet comparison reads only restaurants of the caller's own tenant and is owner-only. Tested against a second business. |
| SQL | Reports use parameterised raw SQL; dates are validated as real calendar dates and the only interpolated fragments are fixed column names. A query-string injection attempt is tested to return 400. |
| Spreadsheet formula injection | Customer-controlled text (names, item names) that starts with `=`, `+`, `-`, `@`, tab or return is prefixed with an apostrophe in CSV; in Excel it is stored as an inline string, which is never evaluated. |
| Personal data | The repeat-customer report contains names and phone numbers. It is manager/owner only, every export is audit-logged (who, which report, format, period, row count), and the file carries a reminder. Downloads are sent with `Cache-Control: no-store`. |
| Abuse | Exports are rate limited per user, periods are capped at 366 days, and the per-report row caps (500 customers, 1,000 items) bound memory use. PDF/Excel generation happens in the API process; very large installations should move it to a worker. |
| Plan enforcement | Advanced reports and their exports are checked server-side against the subscription, not hidden in the UI only. |

## Account recovery and MFA (added after the audit above)

| Area | What it does |
|---|---|
| Password reset | "Forgot password" always answers the same, whether or not the email has an account. The emailed link is single use, expires in 30 minutes, and only its hash is stored. At most 3 links per account per hour and 10 requests per IP per hour. Using a link signs the user out everywhere, clears any lockout, retires every outstanding link, emails a security notice, and verifies the address. A weak new password does not use up the link. Resetting does **not** switch MFA off. |
| Immediate session cut-off | Password change or reset, turning MFA on/off, an MFA reset and deactivating staff now end the user's **access tokens immediately** (a per-user cut-off checked against a millisecond issue time), not only their refresh tokens. This closes a gap found while testing: previously a stolen access token would survive a reset for up to 15 minutes. |
| Email confirmation | A link is emailed at sign-up; accounts that existed earlier were treated as confirmed. Until confirmed, an owner cannot send campaigns or connect a payment account; everyday use is unaffected. |
| Two-step verification | Standard TOTP (RFC 6238; checked against the RFC test vectors), works with any authenticator app. The secret is encrypted at rest and shown only at enrolment; enrolment needs the password and a working code. 10 single-use recovery codes are stored only as hashes. A correct password with MFA on gives only a 5-minute pass (a different token type that cannot call the API); wrong codes count towards the same lockout as wrong passwords; a code cannot be reused within its window; recovery codes are removed atomically so two tabs cannot both spend one. |
| Platform admin | In production (or with `MFA_REQUIRE_ADMIN=1`) the admin account can do nothing but set up MFA until it has it. |
| Lost phone | Recovery codes, then the owner can reset a staff member's MFA, then the platform admin can reset anyone's (audited, the user is emailed, sessions are ended). **That last path is a social-engineering target**: agree an identity-verification procedure before using it. |
| Email in production | The API now refuses to start in production without an email provider (`RESEND_API_KEY`, `EMAIL_FROM`), because reset and confirmation cannot work without one. In development the message is printed to the API console instead. |

Not done: passkeys/WebAuthn, SMS codes (deliberately: SIM-swap risk), "new device" alerts, tenant-wide "require MFA for all staff", breached-password checks beyond a short common-password list.
