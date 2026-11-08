import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Server } from "node:http";
import { app } from "./app.js";
import { prisma } from "./db.js";

const ORIGIN = process.env.WEB_ORIGIN ?? "http://localhost:5173";
const password = "correct-horse-battery";
const stamp = Date.now();
const emailA = `cart-a-${stamp}@example.test`;
const emailB = `cart-b-${stamp}@example.test`;
let base = "";
let server: Server;

const call = (path: string, method = "GET", body?: unknown, cookie?: string) =>
  fetch(base + path, {
    method,
    headers: { "content-type": "application/json", origin: ORIGIN, ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

async function signUp(email: string) {
  await call("/api/auth/register", "POST", { name: "Cart Tester", email, password });
  const res = await call("/api/auth/login", "POST", { email, password });
  return (res.headers.get("set-cookie") ?? "").split(";")[0];
}

let A = "";
let B = "";
const ids: Record<string, string> = {};

before(async () => {
  await new Promise<void>((r) => (server = app.listen(0, r)));
  base = `http://localhost:${(server.address() as { port: number }).port}`;
  A = await signUp(emailA);
  B = await signUp(emailB);
  for (const p of await prisma.product.findMany()) ids[p.slug] = p.id;
});

after(async () => {
  await prisma.user.deleteMany({ where: { email: { in: [emailA, emailB] } } }); // cascades to carts and items
  server.close();
  await prisma.$disconnect();
  process.exit(0);
});

test("anonymous users cannot access the cart", async () => {
  assert.equal((await call("/api/cart")).status, 401);
  assert.equal((await call("/api/cart/items", "POST", { productId: ids["gaming-mouse"], quantity: 1 })).status, 401);
});

test("add, increase, subtotal in integer cents, persisted in PostgreSQL", async () => {
  let res = await call("/api/cart/items", "POST", { productId: ids["mechanical-keyboard"], quantity: 1 }, A);
  assert.equal(res.status, 201);
  await call("/api/cart/items", "POST", { productId: ids["mechanical-keyboard"], quantity: 2 }, A); // 1 + 2 = 3
  res = await call("/api/cart/items", "POST", { productId: ids["cloud-storage-demo-code"] }, A); // default qty 1, digital
  const { cart } = await res.json();
  assert.equal(cart.itemCount, 4);
  assert.equal(cart.subtotalCents, 3 * 11900 + 999);
  const kb = cart.items.find((i: any) => i.slug === "mechanical-keyboard");
  assert.equal(kb.quantity, 3);
  assert.equal(kb.lineTotalCents, 35700);
  const rows = await prisma.cartItem.count({ where: { cart: { user: { email: emailA } } } });
  assert.equal(rows, 2);
});

test("browser-supplied prices are ignored", async () => {
  await call("/api/cart/items", "POST", { productId: ids["design-template-pack"], quantity: 1, priceCents: 1, unitPriceCents: 1 }, A);
  const { cart } = await (await call("/api/cart", "GET", undefined, A)).json();
  assert.equal(cart.items.find((i: any) => i.slug === "design-template-pack").unitPriceCents, 2900);
});

test("update quantity and remove item", async () => {
  let res = await call(`/api/cart/items/${ids["mechanical-keyboard"]}`, "PATCH", { quantity: 2 }, A);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).cart.items.find((i: any) => i.slug === "mechanical-keyboard").quantity, 2);
  res = await call(`/api/cart/items/${ids["mechanical-keyboard"]}`, "DELETE", undefined, A);
  assert.equal(res.status, 200);
  assert.ok(!(await res.json()).cart.items.some((i: any) => i.slug === "mechanical-keyboard"));
  assert.equal((await call(`/api/cart/items/${ids["mechanical-keyboard"]}`, "PATCH", { quantity: 1 }, A)).status, 404);
});

test("users cannot see or touch each other's carts", async () => {
  const b = await (await call("/api/cart", "GET", undefined, B)).json();
  assert.equal(b.cart.items.length, 0);
  await call("/api/cart/items", "POST", { productId: ids["bluetooth-speaker"], quantity: 1 }, B);
  const a = await (await call("/api/cart", "GET", undefined, A)).json();
  assert.ok(!a.cart.items.some((i: any) => i.slug === "bluetooth-speaker"));
  // A cannot modify B's item: it simply isn't in A's cart.
  assert.equal((await call(`/api/cart/items/${ids["bluetooth-speaker"]}`, "PATCH", { quantity: 5 }, A)).status, 404);
  const b2 = await (await call("/api/cart", "GET", undefined, B)).json();
  assert.equal(b2.cart.items[0].quantity, 1);
});

test("invalid input and stock/quantity limits are enforced", async () => {
  const add = (body: unknown) => call("/api/cart/items", "POST", body, B);
  assert.equal((await add({ productId: "not-a-uuid", quantity: 1 })).status, 400);
  assert.equal((await add({ productId: ids["gaming-mouse"], quantity: 0 })).status, 400);
  assert.equal((await add({ productId: ids["gaming-mouse"], quantity: -2 })).status, 400);
  assert.equal((await add({ productId: ids["gaming-mouse"], quantity: 1.5 })).status, 400);
  assert.equal((await add({ productId: ids["gaming-mouse"], quantity: 21 })).status, 400);
  assert.equal((await add({ productId: "00000000-0000-4000-8000-000000000000", quantity: 1 })).status, 404);
  const oos = await add({ productId: ids["usb-c-hub"], quantity: 1 }); // stock 0
  assert.equal(oos.status, 409);
  assert.equal((await oos.json()).code, "OUT_OF_STOCK");
  const over = await add({ productId: ids["gaming-mouse"], quantity: 4 }); // stock 3
  assert.equal(over.status, 409);
  assert.equal((await over.json()).code, "INSUFFICIENT_STOCK");
  assert.equal((await add({ productId: ids["gaming-mouse"], quantity: 3 })).status, 201);
  assert.equal((await add({ productId: ids["gaming-mouse"], quantity: 1 })).status, 409); // 3 + 1 > 3
  assert.equal((await call(`/api/cart/items/${ids["gaming-mouse"]}`, "PATCH", { quantity: 4 }, B)).status, 409);
  // digital (unlimited) is capped at 20 per item
  assert.equal((await add({ productId: ids["digital-learning-course"], quantity: 20 })).status, 201);
  assert.equal((await add({ productId: ids["digital-learning-course"], quantity: 1 })).status, 409);
});

test("stock drop shows an issue without deleting the item; inactive products cannot be added", async () => {
  const mouse = await prisma.product.findUnique({ where: { slug: "gaming-mouse" } });
  try {
    await prisma.product.update({ where: { slug: "gaming-mouse" }, data: { stockQuantity: 1 } });
    const { cart } = await (await call("/api/cart", "GET", undefined, B)).json();
    const item = cart.items.find((i: any) => i.slug === "gaming-mouse");
    assert.equal(item.quantity, 3); // not silently changed
    assert.equal(item.issue.code, "INSUFFICIENT_STOCK");
    assert.equal(cart.hasIssues, true);
    // can still lower the quantity to fix it
    assert.equal((await call(`/api/cart/items/${ids["gaming-mouse"]}`, "PATCH", { quantity: 1 }, B)).status, 200);
  } finally {
    await prisma.product.update({ where: { slug: "gaming-mouse" }, data: { stockQuantity: mouse!.stockQuantity } });
  }
  await prisma.product.update({ where: { slug: "bluetooth-speaker" }, data: { isActive: false } });
  try {
    const res = await call("/api/cart/items", "POST", { productId: ids["bluetooth-speaker"], quantity: 1 }, A);
    assert.equal(res.status, 404);
  } finally {
    await prisma.product.update({ where: { slug: "bluetooth-speaker" }, data: { isActive: true } });
  }
});

test("concurrent adds cannot exceed stock or lose updates", async () => {
  await call("/api/cart", "DELETE", undefined, A);
  const results = await Promise.all(
    Array.from({ length: 6 }, () => call("/api/cart/items", "POST", { productId: ids["gaming-mouse"], quantity: 1 }, A)),
  );
  const statuses = results.map((r) => r.status).sort();
  assert.equal(statuses.filter((s) => s === 201).length, 3); // stock is 3
  assert.equal(statuses.filter((s) => s === 409).length, 3);
  const { cart } = await (await call("/api/cart", "GET", undefined, A)).json();
  assert.equal(cart.items[0].quantity, 3);
});

test("cart survives logout and login", async () => {
  await call("/api/auth/logout", "POST", undefined, B);
  assert.equal((await call("/api/cart", "GET", undefined, B)).status, 401);
  const res = await call("/api/auth/login", "POST", { email: emailB, password });
  const B2 = (res.headers.get("set-cookie") ?? "").split(";")[0];
  const { cart } = await (await call("/api/cart", "GET", undefined, B2)).json();
  assert.ok(cart.items.length >= 1);
});
