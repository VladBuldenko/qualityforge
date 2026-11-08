import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Server } from "node:http";
import { app } from "./app.js";
import { prisma } from "./db.js";
import { computeQuote, setFailAfterDebitForTests } from "./exchange.js";
import { deleteTestUsers } from "./test-utils.js";
import { credit, debit, getBalances } from "./wallet.js";

const ORIGIN = process.env.WEB_ORIGIN ?? "http://localhost:5173";
const password = "correct-horse-battery";
const stamp = Date.now();
const emails = ["a", "b", "c"].map((n) => `ex-${n}-${stamp}@example.test`);
const [emailA, emailB, emailC] = emails;
let base = "";
let server: Server;

const call = (path: string, method = "GET", body?: unknown, cookie?: string) =>
  fetch(base + path, {
    method,
    headers: { "content-type": "application/json", origin: ORIGIN, ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const jar: Record<string, string> = {};
const uid: Record<string, string> = {};
async function signUp(email: string) {
  await call("/api/auth/register", "POST", { name: "Exchange Tester", email, password });
  const res = await call("/api/auth/login", "POST", { email, password });
  jar[email] = (res.headers.get("set-cookie") ?? "").split(";")[0];
  uid[email] = (await prisma.user.findUniqueOrThrow({ where: { email } })).id;
}
let seq = 0;
const fund = (email: string, currency: "EUR" | "USD", cents: number) =>
  credit({ userId: uid[email], currency, amountMinor: cents, operationId: `t008-fund-${stamp}-${seq++}` });
const bal = async (email: string) => {
  const b = await getBalances(uid[email]);
  return { EUR: b.find((x) => x.currency === "EUR")!.balanceMinor, USD: b.find((x) => x.currency === "USD")!.balanceMinor };
};
const key = () => `k-${stamp}-${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
const xchg = (email: string, body: Record<string, unknown>) =>
  call("/api/exchange", "POST", { rateVersion: "demo-v1", idempotencyKey: key(), ...body }, jar[email]);
const eurToUsd = (email: string, amountMinor: number, extra: Record<string, unknown> = {}) =>
  xchg(email, { fromCurrency: "EUR", toCurrency: "USD", amountMinor, ...extra });
const usdToEur = (email: string, amountMinor: number, extra: Record<string, unknown> = {}) =>
  xchg(email, { fromCurrency: "USD", toCurrency: "EUR", amountMinor, ...extra });
const count = (email: string) => prisma.exchange.count({ where: { userId: uid[email] } });
const txCount = (email: string) => prisma.walletTransaction.count({ where: { userId: uid[email] } });

/** Per currency: user ledger sum == balance, and every transaction's entries sum to zero. */
async function assertLedgerBalanced(email: string) {
  const b = await bal(email);
  for (const currency of ["EUR", "USD"] as const) {
    const sum = await prisma.ledgerEntry.aggregate({ _sum: { amountMinor: true }, where: { account: { userId: uid[email], currency } } });
    assert.equal(sum._sum.amountMinor ?? 0, b[currency], `${currency} ledger sum equals balance`);
  }
  const bad = await prisma.$queryRaw<{ id: string }[]>`
    SELECT t.id FROM "WalletTransaction" t JOIN "LedgerEntry" e ON e."transactionId" = t.id
    WHERE t."userId" = ${uid[email]}::uuid GROUP BY t.id HAVING SUM(e."amountMinor") <> 0`;
  assert.equal(bad.length, 0, "every transaction nets to zero");
}

before(async () => {
  await new Promise<void>((r) => (server = app.listen(0, r)));
  base = `http://localhost:${(server.address() as { port: number }).port}`;
  for (const e of emails) await signUp(e);
});
after(async () => {
  await deleteTestUsers(emails);
  server.close();
  await prisma.$disconnect();
  process.exit(0);
});

test("anonymous users cannot quote, exchange or read history", async () => {
  assert.equal((await call("/api/exchange/quote?fromCurrency=EUR&toCurrency=USD&amountMinor=100")).status, 401);
  assert.equal((await call("/api/exchange", "POST", {})).status, 401);
  assert.equal((await call("/api/exchanges")).status, 401);
});

test("exact integer math in both directions, floor rounding, no float errors", () => {
  assert.equal(computeQuote("EUR", "USD", 10000).toAmountMinor, 11000); // €100.00 -> $110.00
  assert.equal(computeQuote("USD", "EUR", 11000).toAmountMinor, 10000); // $110.00 -> €100.00
  assert.equal(computeQuote("EUR", "USD", 1).toAmountMinor, 1); // 1.1 -> 1 (floor)
  assert.equal(computeQuote("USD", "EUR", 11).toAmountMinor, 10);
  assert.equal(computeQuote("USD", "EUR", 12).toAmountMinor, 10); // 10.909 -> 10
  assert.throws(() => computeQuote("USD", "EUR", 1), (e: { code?: string }) => e.code === "AMOUNT_TOO_SMALL"); // 0.909 -> 0
  assert.throws(() => computeQuote("EUR", "USD", 1_999_999_999), (e: { code?: string }) => e.code === "AMOUNT_TOO_LARGE");
  assert.throws(() => computeQuote("EUR", "EUR", 100), (e: { code?: string }) => e.code === "INVALID_PAIR");
});

test("quote endpoint is informative, exact and moves no money", async () => {
  await fund(emailA, "EUR", 20000);
  const before = await bal(emailA);
  const res = await call("/api/exchange/quote?fromCurrency=EUR&toCurrency=USD&amountMinor=10000", "GET", undefined, jar[emailA]);
  assert.equal(res.status, 200);
  const { quote } = await res.json();
  assert.equal(quote.toAmountMinor, 11000);
  assert.equal(quote.rateNumerator, 11);
  assert.equal(quote.rateDenominator, 10);
  assert.equal(quote.rateVersion, "demo-v1");
  assert.equal(quote.availableBalanceMinor, 20000);
  assert.equal(quote.sufficientFunds, true);
  const rich = await (await call("/api/exchange/quote?fromCurrency=EUR&toCurrency=USD&amountMinor=30000", "GET", undefined, jar[emailA])).json();
  assert.equal(rich.quote.sufficientFunds, false);
  assert.deepEqual(await bal(emailA), before);
});

test("invalid currencies, amounts, keys and rate versions are rejected", async () => {
  const q = (s: string) => call("/api/exchange/quote?" + s, "GET", undefined, jar[emailA]);
  assert.equal((await q("fromCurrency=GBP&toCurrency=USD&amountMinor=100")).status, 400);
  assert.equal((await q("fromCurrency=EUR&toCurrency=EUR&amountMinor=100")).status, 400);
  assert.equal((await q("fromCurrency=EUR&toCurrency=USD&amountMinor=1.5")).status, 400);
  assert.equal((await q("fromCurrency=EUR&toCurrency=USD&amountMinor=-5")).status, 400);
  assert.equal((await q("fromCurrency=EUR&toCurrency=USD&amountMinor=0")).status, 400);
  const before = { n: await count(emailA), b: await bal(emailA) };
  for (const bad of [{ amountMinor: 0 }, { amountMinor: -1 }, { amountMinor: 1.5 }, { amountMinor: "100" }, { fromCurrency: "GBP" }, { toCurrency: "EUR" }, { idempotencyKey: "short" }]) {
    assert.equal((await eurToUsd(emailA, 1000, bad)).status, 400, JSON.stringify(bad));
  }
  assert.equal((await usdToEur(emailA, 1)).status, 400); // would receive 0
  const stale = await eurToUsd(emailA, 1000, { rateVersion: "demo-v0" });
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).code, "STALE_RATE");
  assert.equal(await count(emailA), before.n);
  assert.deepEqual(await bal(emailA), before.b);
});

test("insufficient funds are rejected with no side effects", async () => {
  const before = { n: await txCount(emailA), b: await bal(emailA) };
  const res = await eurToUsd(emailA, 25000);
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.code, "INSUFFICIENT_FUNDS");
  assert.equal(body.shortfallMinor, 5000);
  assert.equal(await txCount(emailA), before.n);
  assert.deepEqual(await bal(emailA), before.b);
});

test("one exchange = one debit + one linked credit; both ledgers balanced; reverse works", async () => {
  const res = await eurToUsd(emailA, 10000);
  assert.equal(res.status, 201);
  const { exchange, balances } = await res.json();
  assert.equal(exchange.toAmountMinor, 11000);
  assert.deepEqual(await bal(emailA), { EUR: 10000, USD: 11000 });
  assert.equal(balances.find((b: { currency: string }) => b.currency === "USD").balanceMinor, 11000);
  const row = await prisma.exchange.findUniqueOrThrow({ where: { id: exchange.id }, include: { debitTransaction: true, creditTransaction: true } });
  assert.equal(row.debitTransaction.type, "DEBIT");
  assert.equal(row.debitTransaction.currency, "EUR");
  assert.equal(row.debitTransaction.amountMinor, 10000);
  assert.equal(row.creditTransaction.type, "CREDIT");
  assert.equal(row.creditTransaction.currency, "USD");
  assert.equal(row.creditTransaction.amountMinor, 11000);
  assert.match(row.debitTransaction.description ?? "", /exchange/i);
  assert.equal(await prisma.walletTransaction.count({ where: { operationId: { startsWith: `exchange:${exchange.id}:` } } }), 2);
  await assertLedgerBalanced(emailA);

  const back = await usdToEur(emailA, 11000);
  assert.equal(back.status, 201);
  assert.deepEqual(await bal(emailA), { EUR: 20000, USD: 0 });
  await assertLedgerBalanced(emailA);

  const hist = await (await call("/api/exchanges", "GET", undefined, jar[emailA])).json();
  assert.equal(hist.total, 2);
  assert.equal(hist.items[0].fromCurrency, "USD"); // newest first
  // wallet history shows both legs
  const txs = await (await call("/api/wallet/transactions", "GET", undefined, jar[emailA])).json();
  assert.ok(txs.items.some((t: { description: string }) => /exchange/i.test(t.description)));
});

test("exchange history is immutable at the database level", async () => {
  const e = await prisma.exchange.findFirstOrThrow({ where: { userId: uid[emailA] } });
  await assert.rejects(prisma.exchange.update({ where: { id: e.id }, data: { toAmountMinor: 1 } }));
  await assert.rejects(prisma.exchange.delete({ where: { id: e.id } }));
  await assert.rejects(prisma.$executeRaw`UPDATE "Exchange" SET "fromCurrency" = 'USD', "toCurrency" = 'EUR' WHERE id = ${e.id}::uuid`);
});

test("repeated key returns the original result; conflicting reuse is 409", async () => {
  await fund(emailB, "EUR", 5000);
  const k = key();
  const first = await eurToUsd(emailB, 1000, { idempotencyKey: k });
  assert.equal(first.status, 201);
  const firstBody = await first.json();
  const again = await eurToUsd(emailB, 1000, { idempotencyKey: k });
  assert.equal(again.status, 200);
  const againBody = await again.json();
  assert.equal(againBody.replayed, true);
  assert.equal(againBody.exchange.id, firstBody.exchange.id);
  assert.deepEqual(await bal(emailB), { EUR: 4000, USD: 1100 });
  assert.equal(await count(emailB), 1);
  const conflict = await eurToUsd(emailB, 2000, { idempotencyKey: k });
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).code, "IDEMPOTENCY_KEY_REUSED");
  assert.equal((await usdToEur(emailB, 1100, { idempotencyKey: k })).status, 409);
  assert.deepEqual(await bal(emailB), { EUR: 4000, USD: 1100 });
});

test("concurrent requests with the same key exchange once", async () => {
  await fund(emailC, "EUR", 10000);
  const k = key();
  const results = await Promise.all(Array.from({ length: 8 }, () => eurToUsd(emailC, 1000, { idempotencyKey: k })));
  const statuses = results.map((r) => r.status).sort();
  assert.deepEqual(statuses, [200, 200, 200, 200, 200, 200, 200, 201]);
  assert.equal(await count(emailC), 1);
  assert.deepEqual(await bal(emailC), { EUR: 9000, USD: 1100 });
  await assertLedgerBalanced(emailC);
});

test("concurrent exchanges cannot overspend; opposite directions don't deadlock", async () => {
  // C: EUR 9000, USD 1100. Ten EUR->USD of 2000 (only 4 fit) racing with USD->EUR conversions.
  const before = await bal(emailC);
  const jobs = [
    ...Array.from({ length: 10 }, () => eurToUsd(emailC, 2000)),
    ...Array.from({ length: 6 }, () => usdToEur(emailC, 550)),
  ];
  const res = await Promise.all(jobs);
  assert.ok(res.every((r) => [201, 409].includes(r.status)), "only success or insufficient funds");
  const after = await bal(emailC);
  assert.ok(after.EUR >= 0 && after.USD >= 0);
  await assertLedgerBalanced(emailC);
  // Conservation: value at the fixed rate is only lost to floor rounding, never created.
  const worth = (b: { EUR: number; USD: number }) => b.EUR * 11 + b.USD * 10; // in 1/110 units
  assert.ok(worth(after) <= worth(before));
  const rows = await prisma.exchange.findMany({ where: { userId: uid[emailC] } });
  assert.equal(rows.length - 1, res.filter((r) => r.status === 201).length);
});

test("concurrent plain debit / top-up credit and exchange stay consistent", async () => {
  const before = await bal(emailB); // EUR 4000, USD 1100
  const ops = await Promise.allSettled([
    eurToUsd(emailB, 3000),
    debit({ userId: uid[emailB], currency: "EUR", amountMinor: 3000, operationId: `t008-debit-${stamp}` }),
    credit({ userId: uid[emailB], currency: "EUR", amountMinor: 500, operationId: `t008-topup-${stamp}` }),
    usdToEur(emailB, 1100),
  ]);
  assert.ok(ops.every((o) => o.status === "fulfilled" || /Insufficient/.test(String((o as PromiseRejectedResult).reason))));
  const after = await bal(emailB);
  assert.ok(after.EUR >= 0 && after.USD >= 0);
  await assertLedgerBalanced(emailB);
  assert.ok(before.EUR + before.USD >= 0);
});

test("a failure while crediting the destination rolls back the source debit", async () => {
  const before = { b: await bal(emailB), tx: await txCount(emailB), n: await count(emailB) };
  setFailAfterDebitForTests(true);
  try {
    const res = await eurToUsd(emailB, 100);
    assert.equal(res.status, 500);
  } finally {
    setFailAfterDebitForTests(false);
  }
  assert.deepEqual(await bal(emailB), before.b);
  assert.equal(await txCount(emailB), before.tx);
  assert.equal(await count(emailB), before.n);
  await assertLedgerBalanced(emailB);
});

test("destination balance limit is enforced atomically", async () => {
  const before = await bal(emailA);
  await credit({ userId: uid[emailA], currency: "USD", amountMinor: 1_999_999_000, operationId: `t008-big-${stamp}` });
  const res = await eurToUsd(emailA, 10000); // would push USD over the maximum
  assert.equal(res.status, 409);
  assert.equal((await res.json()).code, "BALANCE_LIMIT");
  assert.deepEqual(await bal(emailA), { EUR: before.EUR, USD: before.USD + 1_999_999_000 });
  await assertLedgerBalanced(emailA);
});

test("users cannot see or reuse each other's exchanges", async () => {
  const mine = await (await call("/api/exchanges?pageSize=50", "GET", undefined, jar[emailB])).json();
  assert.ok(mine.items.length >= 1);
  const ids = new Set(mine.items.map((i: { id: string }) => i.id));
  const theirs = await prisma.exchange.findMany({ where: { userId: uid[emailA] } });
  assert.ok(theirs.length > 0 && theirs.every((t) => !ids.has(t.id)));
  // same key used by another user is an independent exchange, never someone else's result
  const k = key();
  await fund(emailB, "EUR", 1000);
  await fund(emailC, "EUR", 1000);
  const a = await (await eurToUsd(emailC, 1000, { idempotencyKey: k })).json();
  const b = await (await eurToUsd(emailB, 100, { idempotencyKey: k })).json();
  assert.notEqual(a.exchange.id, b.exchange.id);
});

