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
