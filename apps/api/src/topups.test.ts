import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { after, before, test } from "node:test";
import type { Server } from "node:http";
import Stripe from "stripe";

// Config is read at import time, so set the (fake, test-mode) webhook secret before loading the app.
const WEBHOOK_SECRET = "whsec_test_secret_for_unit_tests";
process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
process.env.STRIPE_SECRET_KEY = "sk_test_dummy_key_for_unit_tests";
const { app } = await import("./app.js");
const { prisma } = await import("./db.js");
const { deleteTestUsers } = await import("./test-utils.js");
const { setStripeForTests } = await import("./topups.js");

const ORIGIN = process.env.WEB_ORIGIN ?? "http://localhost:5173";
const password = "correct-horse-battery";
const stamp = Date.now();
const emailA = `topup-a-${stamp}@example.test`;
const emailB = `topup-b-${stamp}@example.test`;
let base = "";
let server: Server;
let A = "";
let B = "";
let idA = "";

// Mocked Stripe: real signature verification (offline), fake network calls.
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const sessions = new Map<string, any>();
let counter = 0;
(stripe.checkout.sessions as any).create = async (params: any) => {
  const id = `cs_test_${stamp}_${++counter}`;
  const s = {
    id, object: "checkout.session", livemode: false, status: "open", payment_status: "unpaid", payment_intent: null,
    currency: "eur", amount_total: params.line_items[0].price_data.unit_amount,
    url: `https://checkout.stripe.com/c/pay/${id}`, client_reference_id: params.client_reference_id,
  };
  sessions.set(id, s);
  return s;
};
(stripe.checkout.sessions as any).retrieve = async (id: string) => sessions.get(id);
(stripe.checkout.sessions as any).expire = async (id: string) => {
  const s = sessions.get(id);
  if (s.payment_status === "paid") throw new Error("session already completed");
  s.status = "expired";
  return s;
};

const call = (path: string, method = "GET", body?: unknown, cookie?: string) =>
  fetch(base + path, {
    method,
    headers: { "content-type": "application/json", origin: ORIGIN, ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

async function signUp(email: string) {
  const reg = await call("/api/auth/register", "POST", { name: "TopUp Tester", email, password });
  const { user } = await reg.json();
  const login = await call("/api/auth/login", "POST", { email, password });
  return { id: user.id as string, cookie: (login.headers.get("set-cookie") ?? "").split(";")[0] };
}

const eventFor = (type: string, session: any, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ id: `evt_${stamp}_${++counter}`, object: "event", type, livemode: false, data: { object: session }, ...extra });

// No Origin header on purpose: webhooks are authenticated by signature, not by browser origin.
const sendWebhook = (payload: string, secret = WEBHOOK_SECRET) =>
  fetch(base + "/api/webhooks/stripe", {
    method: "POST",
    headers: { "content-type": "application/json", "stripe-signature": stripe.webhooks.generateTestHeaderString({ payload, secret }) },
    body: payload,
  });

async function startTopUp(cookie: string, amountMinor = 1000) {
  const res = await call("/api/top-ups", "POST", { currency: "EUR", amountMinor }, cookie);
  assert.equal(res.status, 201);
  const { topUp, checkoutUrl } = await res.json();
  const row = await prisma.topUp.findUniqueOrThrow({ where: { id: topUp.id } });
  return { id: topUp.id as string, sessionId: row.stripeCheckoutSessionId!, checkoutUrl: checkoutUrl as string };
}

const paidSession = (sessionId: string, amount = 1000) => ({ ...sessions.get(sessionId), payment_status: "paid", status: "complete", amount_total: amount, payment_intent: `pi_${sessionId}` });
const eurBalance = async (userId: string) => (await prisma.walletAccount.findFirstOrThrow({ where: { userId, currency: "EUR", kind: "USER" } })).balanceMinor;
const credits = (userId: string) => prisma.walletTransaction.count({ where: { userId, type: "CREDIT" } });

before(async () => {
  await new Promise<void>((r) => (server = app.listen(0, r)));
  base = `http://localhost:${(server.address() as { port: number }).port}`;
  setStripeForTests(stripe);
  const a = await signUp(emailA);
  const b = await signUp(emailB);
  A = a.cookie; idA = a.id; B = b.cookie;
});

after(async () => {
  await deleteTestUsers([emailA, emailB]);
  server.close();
  await prisma.$disconnect();
  process.exit(0);
});

test("anonymous top-up creation is rejected", async () => {
  assert.equal((await call("/api/top-ups", "POST", { currency: "EUR", amountMinor: 1000 })).status, 401);
  assert.equal((await call("/api/top-ups/00000000-0000-4000-8000-000000000000")).status, 401);
});

test("invalid amounts and currencies are rejected", async () => {
  for (const body of [
    { currency: "USD", amountMinor: 1000 }, { currency: "EUR", amountMinor: 499 }, { currency: "EUR", amountMinor: 50_001 },
    { currency: "EUR", amountMinor: 10.5 }, { currency: "EUR", amountMinor: -1000 }, { currency: "EUR", amountMinor: "1000" }, { currency: "EUR" },
  ]) {
    assert.equal((await call("/api/top-ups", "POST", body, A)).status, 400, JSON.stringify(body));
  }
  assert.equal(await prisma.topUp.count({ where: { userId: idA } }), 0);
});

test("creating a top-up stores it PENDING, returns a Stripe URL and does not change the balance", async () => {
  const t = await startTopUp(A, 1000);
  assert.match(t.checkoutUrl, /^https:\/\/checkout\.stripe\.com\//);
  const row = await prisma.topUp.findUniqueOrThrow({ where: { id: t.id } });
  assert.equal(row.status, "PENDING");
  assert.equal(row.amountMinor, 1000);
  assert.equal(await eurBalance(idA), 0);
  assert.equal(await credits(idA), 0);
});

test("invalid webhook signatures are rejected", async () => {
  const payload = eventFor("checkout.session.completed", { id: "cs_x", payment_status: "paid" });
  assert.equal((await sendWebhook(payload, "whsec_wrong_secret")).status, 400);
  const noSig = await fetch(base + "/api/webhooks/stripe", { method: "POST", headers: { "content-type": "application/json" }, body: payload });
  assert.equal(noSig.status, 400);
  // body altered after signing
  const header = stripe.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });
  const tampered = await fetch(base + "/api/webhooks/stripe", { method: "POST", headers: { "content-type": "application/json", "stripe-signature": header }, body: payload.replace("cs_x", "cs_y") });
  assert.equal(tampered.status, 400);
});

test("unpaid, expired, mismatched, unknown, live-mode and unrelated events never credit", async () => {
  const t = await startTopUp(A, 2000);
  const base0 = await eurBalance(idA);
  // completed but not paid (delayed payment method)
  await sendWebhook(eventFor("checkout.session.completed", { ...sessions.get(t.sessionId), payment_status: "unpaid" }));
  assert.equal((await prisma.topUp.findUniqueOrThrow({ where: { id: t.id } })).status, "PENDING");
  // amount mismatch -> rejected, FAILED
  const mismatch = await startTopUp(A, 700);
  await sendWebhook(eventFor("checkout.session.completed", paidSession(mismatch.sessionId, 70_000)));
  assert.equal((await prisma.topUp.findUniqueOrThrow({ where: { id: mismatch.id } })).status, "FAILED");
  // unknown session, unrelated event, live-mode event: acknowledged and ignored
  assert.equal((await sendWebhook(eventFor("checkout.session.completed", { id: "cs_unknown", payment_status: "paid", amount_total: 1000, currency: "eur", livemode: false }))).status, 200);
  assert.equal((await sendWebhook(eventFor("customer.created", { id: "cus_1" }))).status, 200);
  assert.equal((await sendWebhook(eventFor("checkout.session.completed", paidSession(t.sessionId, 2000), { livemode: true }))).status, 200);
  assert.equal((await prisma.topUp.findUniqueOrThrow({ where: { id: t.id } })).status, "PENDING");
  // expired -> CANCELED
  await sendWebhook(eventFor("checkout.session.expired", sessions.get(t.sessionId)));
  assert.equal((await prisma.topUp.findUniqueOrThrow({ where: { id: t.id } })).status, "CANCELED");
  assert.equal(await eurBalance(idA), base0);
  assert.equal(await credits(idA), 0);
});

test("a verified paid session credits the correct EUR amount exactly once, even with duplicate and concurrent webhooks", async () => {
  const t = await startTopUp(A, 1000);
  const session = paidSession(t.sessionId, 1000);
  const first = await sendWebhook(eventFor("checkout.session.completed", session));
  assert.equal(first.status, 200);
  assert.equal(await eurBalance(idA), 1000);
  // duplicate delivery, another event type for the same session, and 6 concurrent deliveries
  await sendWebhook(eventFor("checkout.session.completed", session));
  await sendWebhook(eventFor("checkout.session.async_payment_succeeded", session));
  const concurrent = await Promise.all(Array.from({ length: 6 }, () => sendWebhook(eventFor("checkout.session.completed", session))));
  assert.ok(concurrent.every((r) => r.status === 200));
  assert.equal(await eurBalance(idA), 1000);
  assert.equal(await credits(idA), 1);

  const row = await prisma.topUp.findUniqueOrThrow({ where: { id: t.id } });
  assert.equal(row.status, "SUCCEEDED");
  assert.ok(row.walletTransactionId);
  assert.equal(row.stripePaymentIntentId, `pi_${t.sessionId}`);
  const entries = await prisma.ledgerEntry.findMany({ where: { transactionId: row.walletTransactionId! } });
  assert.equal(entries.length, 2);
  assert.equal(entries.reduce((n, e) => n + e.amountMinor, 0), 0);

  const status = await (await call(`/api/top-ups/${t.id}`, "GET", undefined, A)).json();
  assert.equal(status.topUp.status, "SUCCEEDED");
  const history = await (await call("/api/wallet/transactions?currency=EUR", "GET", undefined, A)).json();
  assert.equal(history.items.length, 1);
  assert.equal(history.items[0].amountMinor, 1000);
});

test("a delayed webhook is covered by server-side session lookup (credited once)", async () => {
  const t = await startTopUp(A, 2500);
  Object.assign(sessions.get(t.sessionId), paidSession(t.sessionId, 2500)); // Stripe says paid; webhook never arrived
  const before = await eurBalance(idA);
  const a = await (await call(`/api/top-ups/${t.id}`, "GET", undefined, A)).json();
  const b = await (await call(`/api/top-ups/${t.id}`, "GET", undefined, A)).json();
  assert.equal(a.topUp.status, "SUCCEEDED");
  assert.equal(b.topUp.status, "SUCCEEDED");
  assert.equal(await eurBalance(idA), before + 2500);
  await sendWebhook(eventFor("checkout.session.completed", sessions.get(t.sessionId))); // late webhook is harmless
  assert.equal(await eurBalance(idA), before + 2500);
});

test("canceling an open top-up expires the session and does not credit", async () => {
  const t = await startTopUp(A, 1500);
  const before = await eurBalance(idA);
  const res = await (await call(`/api/top-ups/${t.id}/cancel`, "POST", undefined, A)).json();
  assert.equal(res.topUp.status, "CANCELED");
  assert.equal(sessions.get(t.sessionId).status, "expired");
  assert.equal(await eurBalance(idA), before);
});

test("users cannot access each other's top-ups", async () => {
  const t = await startTopUp(A, 1000);
  assert.equal((await call(`/api/top-ups/${t.id}`, "GET", undefined, B)).status, 404);
  assert.equal((await call(`/api/top-ups/${t.id}/cancel`, "POST", undefined, B)).status, 404);
  assert.equal((await call(`/api/top-ups/${t.id}`, "GET", undefined, A)).status, 200);
  assert.equal((await call("/api/top-ups/not-a-uuid", "GET", undefined, A)).status, 404);
});

test("without Stripe configuration, top-ups report 503 and create nothing", async () => {
  setStripeForTests(null);
  const before = await prisma.topUp.count({ where: { userId: idA } });
  const res = await call("/api/top-ups", "POST", { currency: "EUR", amountMinor: 1000 }, A);
  setStripeForTests(stripe);
  assert.equal(res.status, 503);
  assert.equal(await prisma.topUp.count({ where: { userId: idA } }), before);
});

test("live-mode Stripe keys are rejected at startup", () => {
  assert.throws(() =>
    execFileSync("npx", ["tsx", "-e", 'import("./src/config.ts")'], {
      env: { ...process.env, STRIPE_SECRET_KEY: "sk_live_not_allowed_000" },
      stdio: "pipe",
    }),
  );
});
