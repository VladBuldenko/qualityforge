import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Server } from "node:http";
import { app } from "./app.js";
import { prisma } from "./db.js";
import { deleteTestUsers } from "./test-utils.js";
import { credit, debit, getBalances, WalletError } from "./wallet.js";

const ORIGIN = process.env.WEB_ORIGIN ?? "http://localhost:5173";
const password = "correct-horse-battery";
const stamp = Date.now();
const emailA = `wallet-a-${stamp}@example.test`;
const emailB = `wallet-b-${stamp}@example.test`;
const emailC = `wallet-c-${stamp}@example.test`;
let base = "";
let server: Server;
const ids: Record<string, string> = {};
const cookies: Record<string, string> = {};

const call = (path: string, method = "GET", body?: unknown, cookie?: string) =>
  fetch(base + path, {
    method,
    headers: { "content-type": "application/json", origin: ORIGIN, ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

async function signUp(email: string) {
  const reg = await call("/api/auth/register", "POST", { name: "Wallet Tester", email, password });
  const { user } = await reg.json();
  const login = await call("/api/auth/login", "POST", { email, password });
  return { id: user.id as string, cookie: (login.headers.get("set-cookie") ?? "").split(";")[0] };
}

const balance = async (userId: string, currency: "EUR" | "USD") =>
  (await getBalances(userId)).find((b) => b.currency === currency)!.balanceMinor;

before(async () => {
  await new Promise<void>((r) => (server = app.listen(0, r)));
  base = `http://localhost:${(server.address() as { port: number }).port}`;
  for (const [k, email] of [["a", emailA], ["b", emailB], ["c", emailC]] as const) {
    const u = await signUp(email);
    ids[k] = u.id;
    cookies[k] = u.cookie;
  }
});

after(async () => {
  await deleteTestUsers([emailA, emailB, emailC]);
  server.close();
  await prisma.$disconnect();
  process.exit(0);
});

test("anonymous wallet access returns 401", async () => {
  assert.equal((await call("/api/wallet")).status, 401);
  assert.equal((await call("/api/wallet/transactions")).status, 401);
});

test("new user has EUR and USD wallets with zero balances and empty history", async () => {
  const { wallet } = await (await call("/api/wallet", "GET", undefined, cookies.a)).json();
  assert.deepEqual(wallet.balances, [{ currency: "EUR", balanceMinor: 0 }, { currency: "USD", balanceMinor: 0 }]);
  const tx = await (await call("/api/wallet/transactions", "GET", undefined, cookies.a)).json();
  assert.equal(tx.total, 0);
  assert.equal(await prisma.walletAccount.count({ where: { userId: ids.a, kind: "USER" } }), 2);
});

test("an existing user without wallets gets them on first access", async () => {
  await prisma.walletAccount.deleteMany({ where: { userId: ids.c } }); // simulate a pre-wallet user
  const { wallet } = await (await call("/api/wallet", "GET", undefined, cookies.c)).json();
  assert.equal(wallet.balances.length, 2);
  assert.ok(wallet.balances.every((b: any) => b.balanceMinor === 0));
});

test("credit and debit update balance, history and a balanced ledger atomically", async () => {
  const c = await credit({ userId: ids.a, currency: "EUR", amountMinor: 10_000, operationId: `t-${stamp}-c1`, description: "test credit" });
  assert.equal(c.balanceMinor, 10_000);
  const d = await debit({ userId: ids.a, currency: "EUR", amountMinor: 2_550, operationId: `t-${stamp}-d1` });
  assert.equal(d.balanceMinor, 7_450);
  assert.equal(await balance(ids.a, "USD"), 0); // currencies are independent

  const history = await (await call("/api/wallet/transactions", "GET", undefined, cookies.a)).json();
  assert.equal(history.total, 2);
  assert.deepEqual(history.items.map((t: any) => [t.type, t.amountMinor, t.balanceAfterMinor]), [["DEBIT", 2550, 7450], ["CREDIT", 10000, 10000]]);
  assert.equal(history.items[0].operationId, undefined); // internal key is never exposed

  // every transaction has two entries that sum to zero
  const entries = await prisma.ledgerEntry.findMany({ where: { transaction: { userId: ids.a } } });
  assert.equal(entries.length, 4);
  assert.equal(entries.reduce((n, e) => n + e.amountMinor, 0), 0);
});

test("insufficient funds and invalid amounts are rejected without side effects", async () => {
  const before = await prisma.walletTransaction.count({ where: { userId: ids.a } });
  await assert.rejects(debit({ userId: ids.a, currency: "EUR", amountMinor: 999_999, operationId: `t-${stamp}-big` }), (e: any) => e instanceof WalletError && e.code === "INSUFFICIENT_FUNDS");
  await assert.rejects(debit({ userId: ids.a, currency: "USD", amountMinor: 1, operationId: `t-${stamp}-usd` }), (e: any) => e.code === "INSUFFICIENT_FUNDS");
  for (const bad of [0, -5, 1.5, NaN, 3_000_000_000]) {
    await assert.rejects(credit({ userId: ids.a, currency: "EUR", amountMinor: bad, operationId: `t-${stamp}-bad-${bad}` }), (e: any) => e.code === "INVALID_AMOUNT");
  }
  assert.equal(await prisma.walletTransaction.count({ where: { userId: ids.a } }), before);
  assert.equal(await balance(ids.a, "EUR"), 7_450);
});

test("repeating an operationId does not move money twice; reusing it differently is refused", async () => {
  const op = { userId: ids.b, currency: "USD" as const, amountMinor: 5_000, operationId: `t-${stamp}-dup` };
  const first = await credit(op);
  const again = await credit(op);
  assert.equal(first.duplicate, false);
  assert.equal(again.duplicate, true);
  assert.equal(again.reference, first.reference);
  assert.equal(await balance(ids.b, "USD"), 5_000);
  await assert.rejects(credit({ ...op, amountMinor: 1 }), (e: any) => e.code === "OPERATION_ID_REUSED");
  // concurrent duplicates also credit once
  const results = await Promise.all(Array.from({ length: 5 }, () => credit({ ...op, operationId: `t-${stamp}-dup2` })));
  assert.equal(results.filter((r) => !r.duplicate).length, 1);
  assert.equal(await balance(ids.b, "USD"), 10_000);
});

test("concurrent debits cannot overspend a wallet", async () => {
  await credit({ userId: ids.c, currency: "EUR", amountMinor: 1_000, operationId: `t-${stamp}-fund-c` });
  const results = await Promise.allSettled(
    Array.from({ length: 6 }, (_, i) => debit({ userId: ids.c, currency: "EUR", amountMinor: 300, operationId: `t-${stamp}-race-${i}` })),
  );
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 3);
  assert.ok(results.filter((r) => r.status === "rejected").every((r: any) => r.reason.code === "INSUFFICIENT_FUNDS"));
  assert.equal(await balance(ids.c, "EUR"), 100);
});

test("users cannot see each other's wallet data", async () => {
  const b = await (await call("/api/wallet", "GET", undefined, cookies.b)).json();
  assert.equal(b.wallet.balances.find((x: any) => x.currency === "EUR").balanceMinor, 0); // A's EUR is not visible to B
  assert.equal(b.wallet.balances.find((x: any) => x.currency === "USD").balanceMinor, 10_000);
  const bTx = await (await call("/api/wallet/transactions", "GET", undefined, cookies.b)).json();
  assert.ok(bTx.items.every((t: any) => t.currency === "USD"));
  // a client-supplied userId is ignored
  const spoof = await (await call(`/api/wallet?userId=${ids.a}`, "GET", undefined, cookies.b)).json();
  assert.equal(spoof.wallet.balances.find((x: any) => x.currency === "EUR").balanceMinor, 0);
});

test("no public credit/debit endpoints; DB protects balances and the ledger", async () => {
  for (const path of ["/api/wallet/credit", "/api/wallet/debit", "/api/wallet/topup"]) {
    const res = await call(path, "POST", { currency: "EUR", amountMinor: 100 }, cookies.a);
    assert.equal(res.status, 404);
  }
  const acct = await prisma.walletAccount.findFirstOrThrow({ where: { userId: ids.a, currency: "EUR" } });
  await assert.rejects(prisma.walletAccount.update({ where: { id: acct.id }, data: { balanceMinor: -1 } })); // CHECK >= 0
  const tx = await prisma.walletTransaction.findFirstOrThrow({ where: { userId: ids.a } });
  await assert.rejects(prisma.walletTransaction.update({ where: { id: tx.id }, data: { amountMinor: 1 } })); // append-only
  await assert.rejects(prisma.walletTransaction.delete({ where: { id: tx.id } }));
  await assert.rejects(prisma.ledgerEntry.deleteMany({ where: { transactionId: tx.id } }));
});
