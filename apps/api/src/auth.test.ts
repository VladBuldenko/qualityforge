import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Server } from "node:http";
import { app } from "./app.js";
import { prisma } from "./db.js";
import { deleteTestUsers } from "./test-utils.js";

const ORIGIN = process.env.WEB_ORIGIN ?? "http://localhost:5173";
const email = `smoke-${Date.now()}@example.test`;
const password = "correct-horse-battery";
let base = "";
let server: Server;
let cookie = "";

const call = (path: string, init: { method?: string; body?: unknown; cookie?: string; origin?: string } = {}) =>
  fetch(base + path, {
    method: init.method ?? "GET",
    headers: {
      "content-type": "application/json",
      origin: init.origin ?? ORIGIN,
      ...(init.cookie ? { cookie: init.cookie } : {}),
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });

before(async () => {
  await new Promise<void>((r) => (server = app.listen(0, r)));
  base = `http://localhost:${(server.address() as { port: number }).port}`;
});

after(async () => {
  await deleteTestUsers([email]);
  server.close();
  await prisma.$disconnect();
  process.exit(0); // the session pool keeps the event loop alive
});

test("register creates a CUSTOMER, hides the hash, ignores a client-supplied role", async () => {
  const res = await call("/api/auth/register", {
    method: "POST",
    body: { name: "Smoke Test", email: email.toUpperCase(), password, role: "ADMIN" },
  });
  assert.equal(res.status, 201);
  const { user } = await res.json();
  assert.equal(user.email, email);
  assert.equal(user.role, "CUSTOMER");
  assert.equal(user.passwordHash, undefined);
  const row = await prisma.user.findUnique({ where: { email } });
  assert.notEqual(row?.passwordHash, password);
});

test("duplicate registration is rejected", async () => {
  const res = await call("/api/auth/register", { method: "POST", body: { name: "Dup", email, password } });
  assert.equal(res.status, 409);
});

test("invalid credentials are rejected", async () => {
  const res = await call("/api/auth/login", { method: "POST", body: { email, password: "wrong-password" } });
  assert.equal(res.status, 401);
});

test("/me requires authentication", async () => {
  assert.equal((await call("/api/auth/me")).status, 401);
});

test("state-changing request from a foreign origin is blocked", async () => {
  const res = await call("/api/auth/login", { method: "POST", origin: "http://evil.test", body: { email, password } });
  assert.equal(res.status, 403);
});

test("login sets an HttpOnly cookie and /me works", async () => {
  const res = await call("/api/auth/login", { method: "POST", body: { email, password } });
  assert.equal(res.status, 200);
  const setCookie = res.headers.get("set-cookie") ?? "";
  assert.match(setCookie, /HttpOnly/i);
  cookie = setCookie.split(";")[0];
  const me = await call("/api/auth/me", { cookie });
  assert.equal(me.status, 200);
  assert.equal((await me.json()).user.email, email);
});

test("logout invalidates the session server-side", async () => {
  assert.equal((await call("/api/auth/logout", { method: "POST", cookie })).status, 200);
  assert.equal((await call("/api/auth/me", { cookie })).status, 401);
});
