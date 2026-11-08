import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Server } from "node:http";
import { app } from "./app.js";
import { prisma } from "./db.js";
import { deleteTestUsers } from "./test-utils.js";
import { credit, getBalances } from "./wallet.js";

const ORIGIN = process.env.WEB_ORIGIN ?? "http://localhost:5173";
const password = "correct-horse-battery";
const stamp = Date.now();
const emails = ["a", "b", "c", "d", "e"].map((n) => `co-${n}-${stamp}@example.test`);
const [emailA, emailB, emailC, emailD, emailE] = emails;
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
  await call("/api/auth/register", "POST", { name: "Checkout Tester", email, password });
  const res = await call("/api/auth/login", "POST", { email, password });
  jar[email] = (res.headers.get("set-cookie") ?? "").split(";")[0];
  uid[email] = (await prisma.user.findUniqueOrThrow({ where: { email } })).id;
}
let fundSeq = 0;
const fund = (email: string, cents: number) => credit({ userId: uid[email], currency: "EUR", amountMinor: cents, operationId: `t007-fund-${stamp}-${fundSeq++}` });
const eur = async (email: string) => (await getBalances(uid[email])).find((b) => b.currency === "EUR")!.balanceMinor;
const key = () => `k-${stamp}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
const addToCart = (email: string, productId: string, quantity = 1) => call("/api/cart/items", "POST", { productId, quantity }, jar[email]);
const checkout = (email: string, body: Record<string, unknown>) => call("/api/checkout", "POST", body, jar[email]);
const SHIP = { name: "Ada Lovelace", line1: "1 Demo Street", city: "Berlin", postalCode: "10115", country: "Germany" };

const P: Record<string, { id: string }> = {};
const slugs = ["phys", "last", "dig", "gone"].map((s) => `t007-${s}-${stamp}`);

before(async () => {
  await new Promise<void>((r) => (server = app.listen(0, r)));
  base = `http://localhost:${(server.address() as { port: number }).port}`;
  for (const e of emails) await signUp(e);
  const mk = (slug: string, type: "PHYSICAL" | "DIGITAL", priceCents: number, stockQuantity: number | null) =>
    prisma.product.create({ data: { name: `Test ${slug}`, slug, description: "test product", type, category: "Test", priceCents, image: "/x.png", stockQuantity } });
  P.phys = await mk(slugs[0], "PHYSICAL", 2500, 10);
  P.last = await mk(slugs[1], "PHYSICAL", 1000, 1);
  P.dig = await mk(slugs[2], "DIGITAL", 999, null);
  P.gone = await mk(slugs[3], "PHYSICAL", 500, 5);
});

after(async () => {
  await deleteTestUsers(emails); // orders, entitlements, wallet history and carts of the throw-away users
  await prisma.product.deleteMany({ where: { slug: { in: slugs } } });
  server.close();
  await prisma.$disconnect();
  process.exit(0);
});

const stock = async (id: string) => (await prisma.product.findUniqueOrThrow({ where: { id } })).stockQuantity;

test("anonymous users cannot check out or read orders", async () => {
  assert.equal((await call("/api/checkout", "POST", { idempotencyKey: key() })).status, 401);
  assert.equal((await call("/api/checkout/preview")).status, 401);
  assert.equal((await call("/api/orders")).status, 401);
  assert.equal((await call("/api/orders/" + crypto.randomUUID())).status, 401);
});

test("empty cart cannot be checked out; invalid keys are rejected", async () => {
  const res = await checkout(emailA, { idempotencyKey: key() });
  assert.equal(res.status, 409);
  assert.equal((await res.json()).code, "EMPTY_CART");
  assert.equal((await checkout(emailA, { idempotencyKey: "short" })).status, 400);
});

test("insufficient funds: nothing is charged, reserved, issued or cleared", async () => {
  await fund(emailC, 100);
  await addToCart(emailC, P.phys.id, 2);
  await addToCart(emailC, P.dig.id, 1);
  const before = { stock: await stock(P.phys.id), balance: await eur(emailC) };
  const preview = (await (await call("/api/checkout/preview", "GET", undefined, jar[emailC])).json()).preview;
  assert.equal(preview.canCheckout, false);
  assert.equal(preview.totalCents, 2 * 2500 + 999);
  assert.ok(preview.blockers.some((b: { code: string }) => b.code === "INSUFFICIENT_FUNDS"));

  const res = await checkout(emailC, { idempotencyKey: key(), shipping: SHIP });
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.code, "INSUFFICIENT_FUNDS");
  assert.equal(body.shortfallCents, 2 * 2500 + 999 - 100);
  assert.equal(await stock(P.phys.id), before.stock);
  assert.equal(await eur(emailC), before.balance);
  assert.equal(await prisma.order.count({ where: { userId: uid[emailC] } }), 0);
  assert.equal(await prisma.digitalFulfillment.count({ where: { orderItem: { order: { userId: uid[emailC] } } } }), 0);
  assert.equal(await prisma.walletTransaction.count({ where: { userId: uid[emailC], type: "DEBIT" } }), 0);
  const cart = (await (await call("/api/cart", "GET", undefined, jar[emailC])).json()).cart;
  assert.equal(cart.itemCount, 3, "cart is untouched after a failed checkout");
});

test("mixed physical + digital checkout: one order, one debit, stock, entitlements, cart cleared; client prices ignored", async () => {
  await fund(emailA, 20000);
  await addToCart(emailA, P.phys.id, 2);
  await addToCart(emailA, P.dig.id, 2);
  const startStock = await stock(P.phys.id);
  assert.equal(await prisma.digitalFulfillment.count({ where: { orderItem: { order: { userId: uid[emailA] } } } }), 0, "no entitlements before payment");

  const k = key();
  const res = await checkout(emailA, {
    idempotencyKey: k, shipping: SHIP,
    totalCents: 1, amountCents: 1, priceCents: 1, items: [{ productId: P.phys.id, priceCents: 1, quantity: 1 }], // must be ignored
  });
  assert.equal(res.status, 201);
  const { order, replayed } = await res.json();
  assert.equal(replayed, false);
  const expected = 2 * 2500 + 2 * 999;
  assert.equal(order.totalCents, expected);
  assert.equal(order.paymentStatus, "PAID");
  assert.match(order.reference, /^WS-[0-9A-Z]{10}$/);
  assert.equal(order.items.length, 2);
  const phys = order.items.find((i: { type: string }) => i.type === "PHYSICAL");
  const dig = order.items.find((i: { type: string }) => i.type === "DIGITAL");
  assert.equal(phys.fulfillmentState, "PROCESSING");
  assert.equal(phys.simulatedDelivery, true);
  assert.equal(phys.entitlements.length, 0);
  assert.equal(dig.fulfillmentState, "DELIVERED");
  assert.equal(dig.entitlements.length, 2);
  assert.match(dig.entitlements[0].code, /^DEMO-/);
  assert.equal(order.delivery.simulated, true);
  assert.equal(order.shipping.city, "Berlin");
  assert.equal(JSON.stringify(order).includes("order:"), false, "internal operation ids are not exposed");

  assert.equal(await eur(emailA), 20000 - expected);
  assert.equal(await stock(P.phys.id), startStock! - 2);
  assert.equal(await prisma.order.count({ where: { userId: uid[emailA] } }), 1);
  assert.equal(await prisma.walletTransaction.count({ where: { userId: uid[emailA], type: "DEBIT" } }), 1);
  assert.equal((await (await call("/api/cart", "GET", undefined, jar[emailA])).json()).cart.itemCount, 0);

  // Ledger stays balanced for the debit.
  const tx = await prisma.walletTransaction.findFirstOrThrow({ where: { userId: uid[emailA], type: "DEBIT" }, include: { entries: true } });
  assert.equal(tx.entries.reduce((n, e) => n + e.amountMinor, 0), 0);

  // Retrying the same logical checkout (timeout / double click / second tab) returns the original and charges nothing.
  const retry = await checkout(emailA, { idempotencyKey: k, shipping: SHIP });
  assert.equal(retry.status, 200);
  const again = await retry.json();
  assert.equal(again.replayed, true);
  assert.equal(again.order.id, order.id);
  assert.equal(await eur(emailA), 20000 - expected);
  // Same key, different details: rejected, no new payment.
  const conflict = await checkout(emailA, { idempotencyKey: k, shipping: { ...SHIP, city: "Paris" } });
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).code, "IDEMPOTENCY_KEY_REUSED");
  assert.equal(await prisma.walletTransaction.count({ where: { userId: uid[emailA], type: "DEBIT" } }), 1);

  // The order shows up in history and details; wallet history has the debit.
  const list = await (await call("/api/orders", "GET", undefined, jar[emailA])).json();
  assert.equal(list.total, 1);
  assert.equal(list.items[0].id, order.id);
  const wallet = await (await call("/api/wallet/transactions", "GET", undefined, jar[emailA])).json();
  assert.ok(wallet.items.some((t: { type: string; amountMinor: number }) => t.type === "DEBIT" && t.amountMinor === expected));
});

test("concurrent identical checkouts (double click / multiple tabs) create exactly one order and one debit", async () => {
  await fund(emailB, 10000);
  await addToCart(emailB, P.phys.id, 1);
  const k = key();
  const startStock = await stock(P.phys.id);
  const results = await Promise.all(Array.from({ length: 6 }, () => checkout(emailB, { idempotencyKey: k, shipping: SHIP })));
  const statuses = results.map((r) => r.status).sort();
  assert.equal(statuses.filter((s) => s === 201).length, 1, `statuses: ${statuses}`);
  assert.ok(statuses.every((s) => s === 201 || s === 200), `statuses: ${statuses}`);
  assert.equal(await prisma.order.count({ where: { userId: uid[emailB] } }), 1);
  assert.equal(await prisma.walletTransaction.count({ where: { userId: uid[emailB], type: "DEBIT" } }), 1);
  assert.equal(await eur(emailB), 10000 - 2500);
  assert.equal(await stock(P.phys.id), startStock! - 1);
});

test("two customers racing for the last unit: exactly one wins, stock never goes below zero", async () => {
  await fund(emailD, 5000);
  await fund(emailE, 5000);
  assert.equal(await stock(P.last.id), 1);
  assert.equal((await addToCart(emailD, P.last.id)).status, 201);
  assert.equal((await addToCart(emailE, P.last.id)).status, 201);
  const [rd, re] = await Promise.all([
    checkout(emailD, { idempotencyKey: key(), shipping: SHIP }),
    checkout(emailE, { idempotencyKey: key(), shipping: SHIP }),
  ]);
  const statuses = [rd.status, re.status].sort();
  assert.deepEqual(statuses, [201, 409]);
  const loser = rd.status === 409 ? rd : re;
  assert.equal((await loser.json()).code, "ITEMS_UNAVAILABLE");
  assert.equal(await stock(P.last.id), 0);
  const winnerEmail = rd.status === 201 ? emailD : emailE;
  const loserEmail = rd.status === 201 ? emailE : emailD;
  assert.equal(await eur(winnerEmail), 4000);
  assert.equal(await eur(loserEmail), 5000, "loser was not charged");
  assert.equal(await prisma.order.count({ where: { userId: uid[loserEmail] } }), 0);
  assert.equal((await (await call("/api/cart", "GET", undefined, jar[loserEmail])).json()).cart.itemCount, 1, "loser keeps the cart");
});

test("out-of-stock and inactive products are rejected without side effects", async () => {
  await fund(emailC, 50000); // now plenty of funds; cart from the earlier test still holds phys x2 + dig
  await call("/api/cart", "DELETE", undefined, jar[emailC]);
  await addToCart(emailC, P.gone.id, 2);
  await addToCart(emailC, P.dig.id, 1);
  const balance = await eur(emailC);

  await prisma.product.update({ where: { id: P.gone.id }, data: { stockQuantity: 1 } });
  let res = await checkout(emailC, { idempotencyKey: key(), shipping: SHIP });
  assert.equal(res.status, 409);
  let body = await res.json();
  assert.equal(body.code, "ITEMS_UNAVAILABLE");
  assert.equal(body.issues[0].code, "INSUFFICIENT_STOCK");

  await prisma.product.update({ where: { id: P.gone.id }, data: { stockQuantity: 0 } });
  body = await (await checkout(emailC, { idempotencyKey: key(), shipping: SHIP })).json();
  assert.equal(body.issues[0].code, "OUT_OF_STOCK");

  await prisma.product.update({ where: { id: P.gone.id }, data: { stockQuantity: 5, isActive: false } });
  body = await (await checkout(emailC, { idempotencyKey: key(), shipping: SHIP })).json();
  assert.equal(body.issues[0].code, "UNAVAILABLE");

  assert.equal(await eur(emailC), balance);
  assert.equal(await prisma.order.count({ where: { userId: uid[emailC] } }), 0);
  assert.equal(await stock(P.gone.id), 5);
  assert.equal((await (await call("/api/cart", "GET", undefined, jar[emailC])).json()).cart.items.length, 2);
});

test("physical orders require valid shipping details; digital-only orders do not", async () => {
  await call("/api/cart", "DELETE", undefined, jar[emailC]);
  await addToCart(emailC, P.phys.id, 1);
  const balance = await eur(emailC);
  let res = await checkout(emailC, { idempotencyKey: key() });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, "SHIPPING_REQUIRED");
  res = await checkout(emailC, { idempotencyKey: key(), shipping: { ...SHIP, postalCode: "<script>" } });
  assert.equal(res.status, 400);
  assert.equal(await eur(emailC), balance);

  await call("/api/cart", "DELETE", undefined, jar[emailC]);
  await addToCart(emailC, P.dig.id, 1);
  res = await checkout(emailC, { idempotencyKey: key() });
  assert.equal(res.status, 201);
  const { order } = await res.json();
  assert.equal(order.status, "COMPLETED");
  assert.equal(order.shipping, null);
  assert.equal(order.items[0].entitlements.length, 1);
});

test("customers cannot read each other's orders; bad ids are safe 404s", async () => {
  const mine = (await (await call("/api/orders", "GET", undefined, jar[emailA])).json()).items[0];
  assert.equal((await call(`/api/orders/${mine.id}`, "GET", undefined, jar[emailA])).status, 200);
  assert.equal((await call(`/api/orders/${mine.id}`, "GET", undefined, jar[emailB])).status, 404);
  assert.equal((await call(`/api/orders/not-a-uuid`, "GET", undefined, jar[emailB])).status, 404);
  assert.equal((await call(`/api/orders/${crypto.randomUUID()}`, "GET", undefined, jar[emailB])).status, 404);
  const listB = await (await call("/api/orders", "GET", undefined, jar[emailB])).json();
  assert.ok(listB.items.every((o: { id: string }) => o.id !== mine.id));
  // No mutation endpoints exist for orders.
  assert.equal((await call(`/api/orders/${mine.id}`, "DELETE", undefined, jar[emailA])).status, 404);
  assert.equal((await call(`/api/orders/${mine.id}`, "PATCH", { status: "COMPLETED" }, jar[emailA])).status, 404);
});

test("order snapshots stay stable after catalog changes; simulated delivery progresses for the owner only", async () => {
  const mine = (await (await call("/api/orders", "GET", undefined, jar[emailA])).json()).items[0];
  const before = (await (await call(`/api/orders/${mine.id}`, "GET", undefined, jar[emailA])).json()).order;
  await prisma.product.update({ where: { id: P.phys.id }, data: { name: "Renamed later", priceCents: 99999, isActive: false } });
  await prisma.product.update({ where: { id: P.dig.id }, data: { name: "Renamed digital", priceCents: 1 } });
  const after = (await (await call(`/api/orders/${mine.id}`, "GET", undefined, jar[emailA])).json()).order;
  assert.deepEqual(after.items.map((i: { name: string; unitPriceCents: number; lineTotalCents: number }) => [i.name, i.unitPriceCents, i.lineTotalCents]),
    before.items.map((i: { name: string; unitPriceCents: number; lineTotalCents: number }) => [i.name, i.unitPriceCents, i.lineTotalCents]));
  assert.equal(after.totalCents, before.totalCents);

  // Simulated timeline: age the order, then the owner's read moves the physical item forward.
  assert.equal(after.items.find((i: { type: string }) => i.type === "PHYSICAL").fulfillmentState, "PROCESSING");
  await prisma.order.update({ where: { id: mine.id }, data: { createdAt: new Date(Date.now() - 3 * 60 * 1000) } });
  let o = (await (await call(`/api/orders/${mine.id}`, "GET", undefined, jar[emailA])).json()).order;
  assert.equal(o.items.find((i: { type: string }) => i.type === "PHYSICAL").fulfillmentState, "SHIPPED");
  assert.equal(o.status, "CONFIRMED");
  await prisma.order.update({ where: { id: mine.id }, data: { createdAt: new Date(Date.now() - 10 * 60 * 1000) } });
  o = (await (await call(`/api/orders/${mine.id}`, "GET", undefined, jar[emailA])).json()).order;
  assert.equal(o.items.find((i: { type: string }) => i.type === "PHYSICAL").fulfillmentState, "DELIVERED");
  assert.equal(o.status, "COMPLETED");
});
