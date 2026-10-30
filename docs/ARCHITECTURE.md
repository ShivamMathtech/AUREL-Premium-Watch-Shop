# Architecture and operations

## Runtime modes

React is a Vite single-page application using React Router. The frontend asks `/api/health` once at startup to select the live API or the separately labelled browser demo adapter. A deployment built with `VITE_APP_MODE=demo` does not probe the API. All mutation calls use JSON and a same-origin custom header.

Live mode talks to Express through the same `/api` origin. Vite proxies it to port 3001 locally. Vercel routes it into `api/index.js`. The local production server can serve the built `dist` folder itself with `npm start`.

The demo adapter has sample roles and localStorage persistence. It is deliberately not an authentication system, and never contacts Stripe. Demo and live shopping bags have separate browser-storage keys.

## Persistence

`server/db.js` provides parameterized SQL operations for SQLite and PostgreSQL. SQLite uses Node 24's built-in SQLite module; no native npm compilation is required on Windows. Database access is serialized around transactions so requests cannot interleave on one SQLite connection. SQLite WAL and foreign keys are enabled.

PostgreSQL uses `pg`, a pool of up to five connections per function instance, transaction-scoped connections, row locks, and an advisory lock around initialization. Choose provider pooling for serverless deployment. Connection/TLS settings come from the provider's URL; this project does not set `rejectUnauthorized:false`.

Schema version 1 is created idempotently on initialization. Existing products and users are preserved. `schema_versions` records applied initialization; future schema changes should be added as explicit versioned migrations.

| Table           | Purpose                                                                              |
| --------------- | ------------------------------------------------------------------------------------ |
| users           | Unique normalized email, salted scrypt password, customer/admin role                 |
| sessions        | SHA-256 hash of opaque cookie token and expiry                                       |
| products        | Catalog JSON snapshot, authoritative price, stock, active flag                       |
| orders          | Owner, idempotency key, request hash, frozen item/address/totals snapshot and status |
| wishlist        | User/product relationship                                                            |
| subscribers     | Newsletter email opt-in and timestamp                                                |
| rate_limits     | Expiring counters shared across instances                                            |
| audit_logs      | Administrator product changes and order transitions                                  |
| schema_versions | Schema initialization version                                                        |

## Checkout invariants

- All amounts are integers in paise. The server reads current catalog prices; submitted prices are rejected by strict validation.
- A maximum of five units per product and twenty distinct product lines is accepted per checkout.
- The transaction locks the customer row, then product rows in stable ID order. Stock is decremented with a conditional update requiring sufficient availability.
- If any item fails, all stock changes roll back.
- `UNIQUE(user_id,idempotency_key)` plus a request hash makes retries safe and rejects reuse for a different order.
- Item names, prices and addresses are stored as order snapshots. Editing a catalog product does not rewrite old receipts.
- Admin inventory edits include the observed stock value. An intervening purchase makes a stale update fail with 409 so it cannot silently restore sold inventory.

## Order lifecycle

COD: `confirmed → processing → shipped → delivered`. Payment is recorded as collected only on delivery. A confirmed/processing COD order can be cancelled by an administrator, restoring inventory once.

Stripe: `awaiting_payment → confirmed → processing → shipped → delivered`. Stock is reserved before creating a hosted Checkout session. A verified paid event confirms the order. A verified session-expired event cancels an unpaid reservation and restores inventory. Repeated events are harmless, and a payment that wins the expiry race is not cancelled.

Hosted session creation uses a provider idempotency key derived from the order ID. A timeout leaves the reservation pending; retrying the same browser checkout uses the same local order and provider key. Do not automatically create a fresh order after an uncertain payment request. Linked sessions can be reconciled with `npm run orders:reconcile`. Orders without a linked session need investigation before manual stock release. Stripe's provider-side idempotency retention is finite; do not blindly replay very old ambiguous requests.

Only card payments are configured. Asynchronous payment methods, refunds, chargebacks and automated returns are outside this starter. Paid card orders cannot be cancelled through the admin transition endpoint. Manage refunds with a dedicated, reconciled workflow before adding that feature.

## Authentication and authorization

Passwords use a per-user random salt and Node scrypt. Opaque 256-bit session tokens are stored as hashes, expire after seven days, and are sent as HttpOnly/SameSite=Lax cookies. Hosted production cookies are Secure. A local HTTP development session intentionally does not use Secure cookies.

Every admin API checks the server-side role. Customers can only read their own orders. Order IDs are not authorization credentials. Authentication and newsletter operations are rate-limited in the database, so counters are not isolated to each serverless process. Same-origin checks and a custom JSON header protect state-changing routes from ordinary cross-site requests. No permissive CORS mode is enabled.

The webhook is excluded from browser CSRF rules and instead requires Stripe's cryptographic signature against exact raw bytes. Never put a JSON body parser before that route.

## Local backups and reset

Stop the server before copying the `data` directory; preserve its SQLite database and any WAL/SHM files together if they exist. For hosted PostgreSQL, configure provider backups and validate restoration.

To intentionally reset a disposable local store, stop it, back up `data`, and remove the SQLite database files. Restarting initializes the original catalog. This destroys local accounts/orders, so it is not part of normal setup and no reset command is run automatically.

## Docker

Optional PostgreSQL deployment is included. In `.env`, configure `ADMIN_EMAIL`, `ADMIN_PASSWORD` and a URL-safe `POSTGRES_PASSWORD` (for example a long random alphanumeric value), then:

```bash
docker compose up --build
```

Open http://localhost:3001. Docker compose uses a persistent named PostgreSQL volume and development cookie settings for localhost HTTP. For an internet-facing container, set `NODE_ENV=production`, put it behind HTTPS, and configure the real `APP_URL`. The supplied Docker path was not executed in this build environment.

## Boundaries to extend

The customer API returns the latest 100 orders; administration shows the latest 500 and the latest 30 audit events. Add server-side pagination before using it at larger scale. Product search is currently client-side. There is no distributed inventory cache, courier API, email delivery, background scheduler, product object storage or refund system.

Session cleanup occurs during login; rate-limit cleanup occurs when counters are used. Add scheduled cleanup and an explicit retention policy for a live business. Newsletter opt-ins are stored but no messages are sent by this project.
