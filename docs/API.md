# API quick reference

Base path: `/api`. Responses are JSON. Live mutations require `Content-Type: application/json` and `X-Aurel-Client: storefront`. The browser uses the session cookie automatically. Send requests from the same origin. Stripe webhooks use their signature instead.

Errors use `{ "error": "Human-readable explanation" }` with 400 validation, 401 authentication, 403 permission/CSRF, 404 missing resource, 409 conflict, 429 throttling, or 5xx unavailable.

| Method | Path                | Access                | Purpose                                                   |
| ------ | ------------------- | --------------------- | --------------------------------------------------------- |
| GET    | /health             | Public                | Mode and enabled payment methods                          |
| GET    | /products           | Public/live           | Active catalog with current prices and stock              |
| GET    | /auth/me            | Public/live           | Current user or null                                      |
| POST   | /auth/register      | Public/live           | `{name,email,password}`; customer role only               |
| POST   | /auth/login         | Public/live           | `{email,password}`; issues session cookie                 |
| POST   | /auth/logout        | Public/live           | Revokes current session                                   |
| GET    | /wishlist           | Customer              | Saved product IDs                                         |
| PUT    | /wishlist           | Customer              | Replace saved IDs with `{ids:[...]}`                      |
| POST   | /newsletter         | Public/live           | `{email,consent:true}`                                    |
| GET    | /orders             | Customer              | Own latest 100 orders                                     |
| POST   | /orders             | Customer              | Transactional checkout; idempotency header required       |
| GET    | /orders/:id         | Owner                 | Full owned order snapshot                                 |
| POST   | /orders/:id/resume  | Owner                 | URL of an existing open Stripe session                    |
| POST   | /payments/webhook   | Signed Stripe request | Raw-body payment/expiry event                             |
| GET    | /admin/summary      | Admin                 | Products, latest orders, counts, collected revenue, audit |
| POST   | /admin/products     | Admin                 | Create a product                                          |
| PUT    | /admin/products/:id | Admin                 | Full product update; `If-Stock` header required           |
| PATCH  | /admin/orders/:id   | Admin                 | `{status:"processing"}` etc.; transitions are validated   |

## Checkout example

Send a fresh random `Idempotency-Key` of 16–80 letters/digits/hyphens/underscores. Keep the same key and identical payload when retrying an uncertain response.

```json
{
  "items": [{ "id": "verde-automatic", "quantity": 1 }],
  "address": {
    "name": "Example Customer",
    "phone": "9876543210",
    "line1": "12 Example Road",
    "city": "Dehradun",
    "state": "Uttarakhand",
    "postalCode": "248001"
  },
  "coupon": "AUREL10",
  "paymentMethod": "cod"
}
```

The server calculates subtotal, discount, shipping and total. Do not submit item prices or totals. Use `stripe` only when `/health` reports it enabled; the response additionally contains a hosted `checkoutUrl`.

## Product update fields

`name`, `collection` (Automatic/Dress/Chronograph/Dive), `price` (integer paise), `stock`, `image`, `description`, `color`, `strap`, `movement`, `size`, `water`, `reserve`, `badge`, `featured`, `active`.

The public product ID is a route parameter on update, not a field in the body. Use `If-Stock: <last observed quantity>`. If another order changes stock before the edit, reload the product and retry deliberately.

## Demo separation

When Vercel has no database, health returns demo mode and the remaining live endpoints return 503. Browser demo actions are handled locally by `src/api.js`; they are not public unauthenticated admin endpoints on the server.
