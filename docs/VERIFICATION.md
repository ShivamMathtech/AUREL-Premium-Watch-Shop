# Verification record

Verified on 30 October 2026 in the provided Linux/Node.js 24 environment.

## Completed checks

- **Production build:** `npm run build` passed using Vite 6.4.5. The final browser JavaScript bundle is approximately 343 KB (106 KB gzip); stylesheet approximately 44 KB (10 KB gzip).
- **Automated tests:** `npm test` passed **15 tests**, with zero failures or skipped tests.
- **Dependency audit:** `npm audit` reported zero known vulnerabilities at the time of verification. A flagged validation-library version was upgraded before the final test run.
- **Vercel routing:** the configuration was transformed successfully using the official `@vercel/routing-utils` package, with no validation error. The function entrypoint was exercised over HTTP for the rewritten health route and a nested API route without a database.

## Automated behavior covered

1. SQLite persistence after closing/reopening the database.
2. Idempotent seeding that preserves inventory edits, salted password hashing, password verification.
3. Server-authoritative pricing, discount and shipping calculations; rejection of submitted prices and invalid offers.
4. Concurrent duplicate checkout retries creating one order and one stock decrement.
5. Separate customers competing for the last item without overselling.
6. Complete inventory rollback when any item fails, and rejection of duplicate item entries.
7. Cancellation restocking once; valid COD progression and collected-revenue behavior.
8. Registration, duplicate emails, strict role rejection, session cookies, invalid credentials, logout.
9. Customer order isolation and admin-only access enforcement.
10. Full authenticated COD API workflow, admin catalog editing, stale inventory edit rejection.
11. Cross-site mutation rejection, input validation, API 404s, shared rate-limit counters.
12. Stripe amount/currency validation, repeated paid-event handling, protected card-order cancellation.
13. Expired payment reservation release, duplicate expiry handling and payment/expiry race guard.
14. Valid raw-body webhook signatures and rejection of invalid signatures, using local synthetic events.
15. Vercel entrypoint routing and explicit no-database demo response.

## Browser checks completed

- Desktop storefront appearance, image loading and navigation.
- Category filtering, sorting, product detail pages and adding a watch to the bag.
- Live-mode checkout requires an account.
- Browser demo customer entry, coupon application, sample address checkout, persisted order receipt and cleared bag.
- Sample admin dashboard, viewing the order, changing its status and saving an inventory edit.
- 390-pixel mobile layout, menu navigation and catalog controls. The observed content width matched the viewport width with no horizontal overflow.
- No application console errors were observed on the inspected storefront. An unrelated browser-extension metadata error was excluded.

Browser testing found and corrected a checkout ID compatibility issue on non-secure preview origins. The final code uses cryptographic random bytes when `crypto.randomUUID` is unavailable. The successful sample order was placed after this fix.

## Not executed here

- Publishing to a real Vercel account or testing a custom production domain.
- Connecting the PostgreSQL adapter to an external PostgreSQL server.
- Real Stripe hosted checkout, merchant-account eligibility, network webhook delivery or a live payment.
- Docker image build/compose startup, or execution on a physical Windows computer.
- Email delivery, courier operations, refunds, load testing or an independent security audit.

These require the owner's infrastructure/configuration. The ZIP contains the code, lockfile, templates and instructions; no production credentials or database contents are included. Run the deployment checks in `docs/VERCEL.md` after supplying your own services.
