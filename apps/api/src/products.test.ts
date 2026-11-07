import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Server } from "node:http";
import { app } from "./app.js";
import { prisma } from "./db.js";

let base = "";
let server: Server;
const get = (path: string) => fetch(base + path);

before(async () => {
  await new Promise<void>((r) => (server = app.listen(0, r)));
  base = `http://localhost:${(server.address() as { port: number }).port}`;
});

after(async () => {
  await prisma.product.deleteMany({ where: { slug: "test-inactive-product" } });
  server.close();
  await prisma.$disconnect();
  process.exit(0);
});

test("catalog is public and loads seeded products from PostgreSQL", async () => {
  const res = await get("/api/products?pageSize=50");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.total >= 10);
  assert.ok(body.items.every((p: any) => p.priceCents >= 0 && Number.isInteger(p.priceCents) && p.currency === "EUR"));
});

test("type, category and search filters work", async () => {
  const physical = await (await get("/api/products?type=PHYSICAL&pageSize=50")).json();
  assert.ok(physical.items.length >= 5 && physical.items.every((p: any) => p.type === "PHYSICAL"));
  const audio = await (await get("/api/products?category=Audio")).json();
  assert.ok(audio.items.length >= 2 && audio.items.every((p: any) => p.category === "Audio"));
  const search = await (await get("/api/products?q=keyBOARD")).json();
  assert.deepEqual(search.items.map((p: any) => p.slug), ["mechanical-keyboard"]);
});

test("pagination works and bad queries are rejected", async () => {
  const p2 = await (await get("/api/products?page=2&pageSize=4")).json();
  assert.equal(p2.page, 2);
  assert.equal(p2.items.length, 4);
  assert.equal((await get("/api/products?type=BOGUS")).status, 400);
  assert.equal((await get("/api/products?pageSize=1000")).status, 400);
});

test("product details; unknown and inactive products return 404", async () => {
  const ok = await get("/api/products/usb-c-hub");
  assert.equal(ok.status, 200);
  const { product } = await ok.json();
  assert.equal(product.stockQuantity, 0);
  assert.equal(product.inStock, false);
  assert.equal((await get("/api/products/does-not-exist")).status, 404);

  await prisma.product.create({
    data: { name: "Inactive", slug: "test-inactive-product", description: "x", type: "DIGITAL", category: "Test", priceCents: 100, image: "/x.svg", isActive: false },
  });
  assert.equal((await get("/api/products/test-inactive-product")).status, 404);
  const list = await (await get("/api/products?q=Inactive")).json();
  assert.equal(list.items.length, 0);
});

test("DB rejects negative price and physical product without stock", async () => {
  const base = { name: "Bad", description: "x", category: "Test", image: "/x.svg" };
  await assert.rejects(prisma.product.create({ data: { ...base, slug: "bad-1", type: "DIGITAL", priceCents: -1 } }));
  await assert.rejects(prisma.product.create({ data: { ...base, slug: "bad-2", type: "PHYSICAL", priceCents: 100, stockQuantity: -5 } }));
  await assert.rejects(prisma.product.create({ data: { ...base, slug: "bad-3", type: "PHYSICAL", priceCents: 100 } }));
});

test("no public write endpoints", async () => {
  const res = await fetch(base + "/api/products", {
    method: "POST",
    headers: { "content-type": "application/json", origin: process.env.WEB_ORIGIN ?? "http://localhost:5173" },
    body: "{}",
  });
  assert.ok([404, 405].includes(res.status));
});
