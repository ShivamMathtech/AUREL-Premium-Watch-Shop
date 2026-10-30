# Deploy AUREL on Vercel

## 1. Import the correct folder

The root must contain `package.json`, `vercel.json`, `index.html`, `api`, `server`, `shared`, `src` and `public`. If your Git repository contains an outer folder, set Vercel's Root Directory to `aurel-watch-shop`.

| Setting          | Value           |
| ---------------- | --------------- |
| Framework        | Vite            |
| Node.js          | 24.x            |
| Install          | `npm ci`        |
| Build            | `npm run build` |
| Output directory | `dist`          |

The API is the root `api/index.js` function. The `server` folder is imported by it; it is not an independently deployed Express application. `app.listen()` exists only in the local `server/index.js` entrypoint.

## 2. Deploy a demo without a database

Leave all variables unset, or set `VITE_APP_MODE=demo`. Deploy the project. No keys, server URL or database are needed. `/account` provides demo customer/admin roles. Sample orders persist only in the current browser and are visibly marked as demos.

Do not upload a local `.env`, database file or `node_modules` to Vercel. The local `SQLITE_PATH` is deliberately ignored on Vercel when there is no PostgreSQL URL.

## 3. Enable the persistent full stack

Create a PostgreSQL database through your preferred provider or Vercel's Marketplace. Use the provider's **pooled PostgreSQL connection string**, with its recommended TLS parameters. The driver uses the connection string as supplied and does not disable certificate verification. The app uses a small connection pool per function instance.

Set these in Vercel → Project → Settings → Environment Variables. Select the intended deployment environment; use a separate database for Preview if you enable live preview deployments.

| Variable         | Example / purpose                                                                             |
| ---------------- | --------------------------------------------------------------------------------------------- |
| `DATABASE_URL`   | Your secret `postgresql://…` pooled connection string                                         |
| `APP_URL`        | Exact deployed HTTPS origin, e.g. `https://your-project.vercel.app`, without a trailing slash |
| `ADMIN_EMAIL`    | Your store administrator email                                                                |
| `ADMIN_PASSWORD` | A unique password of at least 12 characters; never use a public demo credential               |
| `VITE_APP_MODE`  | `live`                                                                                        |

Redeploy. The first API request creates the schema and sample catalog, and creates the administrator only if the email does not exist. Cold starts preserve edited products and orders. Open `/api/health`; it should return `mode: "live"`. Then sign in at `/account` and open `/admin`.

Never prefix secrets with `VITE_`. Vite embeds `VITE_` variables in the public browser bundle. The only public variable used by this project is `VITE_APP_MODE`.

To rotate an existing admin password, configure the same database connection and the new admin password in your private local `.env`, then run `npm run admin:create`. Merely changing `ADMIN_PASSWORD` in Vercel does not overwrite an existing password. The command revokes the administrator's prior sessions.

## 4. Optional Stripe card checkout

Cash on delivery needs no payment keys. To enable the additional card option, add:

```dotenv
STRIPE_SECRET_KEY=your_stripe_secret_key
STRIPE_WEBHOOK_SECRET=your_endpoint_signing_secret
APP_URL=https://your-project.vercel.app
```

Create a Stripe webhook endpoint at `https://your-project.vercel.app/api/payments/webhook`, subscribing to:

- `checkout.session.completed`
- `checkout.session.expired`

Only immediate card payments are enabled. The webhook validates the signature against the raw body and checks the paid amount, currency and linked order. The order is **not** marked paid based on a browser redirect. Use Stripe's test environment first and verify an order progresses from awaiting payment to confirmed/paid.

For local testing, use Stripe CLI forwarding:

```bash
stripe listen --forward-to localhost:3001/api/payments/webhook
```

Use the signing secret printed by that command in your private `.env`, then restart the backend. Stripe availability depends on your merchant account and region. If unavailable, COD remains fully functional.

If a webhook is missed, run `npm run orders:reconcile` using the same database and Stripe secret key. It updates paid/expired linked sessions. Orders without a linked session need a retry with the same checkout key or manual provider reconciliation; stock is not automatically released in an ambiguous payment state. Review the provider before changing such orders.

## 5. Deployment checks

1. Open `/`, `/shop`, a product page, and refresh `/account` directly. They should render.
2. Open `/api/health` and confirm the expected mode.
3. For live mode, register a customer, place a COD order, then verify it appears for the admin.
4. Confirm a customer receives 403 for admin endpoints and cannot see another customer's order.
5. If Stripe is enabled, verify signed webhooks reach the deployed endpoint and update only matching orders.

## Troubleshooting

| Symptom                                                     | Action                                                                                                                                                           |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vite: command not found`                                   | Run `npm ci`; keep Vite in devDependencies and do not omit dev dependencies during the build.                                                                    |
| `EBADPLATFORM` on Windows                                   | Do not copy Linux `node_modules`. Delete the old installation and run `npm ci` from the provided lockfile. Optional platform packages are selected by npm.       |
| Frontend deep-link 404                                      | Keep the supplied `vercel.json`; check the Root Directory.                                                                                                       |
| API returns HTML                                            | Confirm `api/index.js` is in the project root and that the API rewrite precedes the SPA rewrite.                                                                 |
| Store reports missing database in live mode                 | Set `DATABASE_URL`, check environment scope, and redeploy.                                                                                                       |
| Database connection error                                   | Check the pooled URL, TLS requirements, network access and provider availability. Never use local SQLite for Vercel persistence.                                 |
| Login succeeds locally but fails on hosted HTTP             | Production sessions use Secure cookies; deploy behind HTTPS. The supplied local Docker compose intentionally uses development cookie settings on localhost HTTP. |
| Card payment remains pending                                | Check webhook delivery and signature secret. Use reconciliation; a successful return URL alone is insufficient.                                                  |
| Demo still appears after adding database                    | Remove `VITE_APP_MODE=demo`, set `live`, and rebuild.                                                                                                            |
| Admin password changed in settings but old password remains | Use `npm run admin:create`; seeding intentionally preserves existing credentials.                                                                                |
| `npm` downloads time out                                    | Retry on a working connection using the official npm registry. The ZIP intentionally does not include platform-specific `node_modules`.                          |

## Official references used

- [Vite on Vercel](https://vercel.com/docs/frameworks/frontend/vite)
- [Vercel rewrites](https://vercel.com/docs/routing/rewrites)
- [Supported Node.js versions](https://vercel.com/docs/functions/runtimes/node-js/node-js-versions)
- [Stripe Checkout payment events](https://docs.stripe.com/payments/existing-customers?platform=web&ui=stripe-hosted)

The project was built and checked locally. A deployment to your Vercel account, hosted PostgreSQL connection and real payment-provider round trip must be verified after you supply your own configuration.
