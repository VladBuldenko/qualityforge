# QualityForge

QualityForge is a personal Quality Engineering portfolio project.

## Project Goals

- Build a maintainable Playwright automation framework.
- Implement UI and REST API testing.
- Validate authentication, authorization, and tenant isolation.
- Practice database and integration testing.
- Explore load and stress testing with k6.
- Explore security testing with OWASP ZAP.
- Integrate automated checks into GitHub Actions.
- Document test strategies, test plans, and defects.

## Technology Stack

Planned technologies:

- TypeScript
- Playwright
- React
- Node.js
- PostgreSQL
- Docker
- GitHub Actions
- k6
- OWASP ZAP

## Project Status

Initial repository setup.

The application and automated tests are not implemented yet.

## Purpose

This project demonstrates practical software testing,
test automation, risk-based testing, and quality engineering.
## WalletShop (demo application under test)

A demo FinTech + e-commerce app (EUR/USD demo wallets, Stripe test mode, catalog, cart, checkout). No real funds are used.
Lives in `apps/web` (React + TypeScript + Vite) and `apps/api` (Express + TypeScript + Prisma + PostgreSQL).

**Status:** foundation + authentication (register, login, logout, profile, protected dashboard). Sessions are HttpOnly cookies stored in PostgreSQL; the API container applies Prisma migrations on start.

API smoke tests (need the DB running and `apps/api/.env`): `cd apps/api && npm test`.
Set `SESSION_SECRET` (see `.env.example`) for anything beyond local dev; Compose uses a dev-only fallback.

### Run with Docker

```bash
docker compose up --build
```

- Web: http://localhost:5173
- API health: http://localhost:4000/health
- Postgres: localhost:5433 (user/password/db: `walletshop`)

### Run without Docker (needs a local Postgres)

```bash
cp .env.example apps/api/.env   # adjust DATABASE_URL
cd apps/api && npm install && npm run dev
cd apps/web && npm install && npm run dev
```

### Plan

1. Foundation (done) 2. Auth 3. Catalog and cart 4. Wallet 5. Stripe test top-ups
6. Checkout and orders 7. EUR/USD exchange 8. Integration and UI polish.
Money is stored as integer minor units, mutated in DB transactions, with idempotency keys on payments/checkout.

### Wallet top-ups with Stripe (test mode)

Top-ups use Stripe Checkout in **test mode only**; live keys are rejected at startup. Without keys the app still runs and top-ups report "not configured".

1. Create/sign in to a Stripe account and stay in **test mode**. Copy the secret key (`sk_test_...`) from Developers → API keys.
2. Install the [Stripe CLI](https://docs.stripe.com/stripe-cli) and run `stripe login` (opens your browser).
3. Forward webhooks to the API and note the signing secret it prints (`whsec_...`):
   ```bash
   stripe listen --forward-to http://localhost:4000/api/webhooks/stripe
   ```
4. Put both values in an untracked `.env` at the repo root (Docker Compose reads it; for non-Docker runs use `apps/api/.env`):
   ```
   STRIPE_SECRET_KEY=sk_test_...
   STRIPE_WEBHOOK_SECRET=whsec_...
   ```
5. `docker compose up -d --build`, then Wallet → Top up. Pay with test card `4242 4242 4242 4242`, any future expiry, any CVC.

The wallet is credited only after Stripe confirms payment (signed webhook, or a server-side session lookup when you return to the result page).

### Wallet checkout and orders

Customers pay for the cart from their **EUR demo wallet** (no Stripe session is involved; Stripe is only used to top the wallet up).

- `GET /api/checkout/preview` shows the server-priced cart, wallet balance and blockers (informational only).
- `POST /api/checkout` takes `{ idempotencyKey, shipping? }` and nothing price-related. In **one PostgreSQL transaction** it locks the cart, locks the product rows (by id), re-reads prices and stock, debits the wallet via the existing ledger (`order:<orderId>`), creates the order and item snapshots, decreases physical stock, issues demo digital entitlements and clears the cart. Retrying with the same key returns the original order; reusing a key with different shipping details is rejected (409).
- `GET /api/orders` and `GET /api/orders/:id` are owner-only (other users get 404). There are no order-editing, refund or fulfillment-mutation endpoints.
- Digital items get a clearly marked **demo** code (not a real license). Physical delivery (Processing → Shipped → Delivered) is **simulated** from the order's age, only advanced when the owner reads the order.

Lock order everywhere: cart → products → wallet account. After pulling changes that add Prisma models, rebuild the API image (`docker compose up -d --build api`) so its generated client matches.
