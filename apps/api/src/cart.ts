import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { requireAuth } from "./auth.js";
import { prisma } from "./db.js";

export const MAX_ITEM_QUANTITY = 20;

class CartError extends Error {
  constructor(
    public status: number,
    message: string,
    public code: string,
    public extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

const quantity = z.number().int("Quantity must be a whole number").min(1, "Quantity must be at least 1").max(MAX_ITEM_QUANTITY, `Maximum quantity per item is ${MAX_ITEM_QUANTITY}`);
const addBody = z.object({ productId: z.string().uuid("Invalid product id"), quantity: quantity.default(1) });
const patchBody = z.object({ quantity });
const productIdParam = z.string().uuid("Invalid product id");

type Tx = Prisma.TransactionClient;

type CartWithItems = Prisma.CartGetPayload<{ include: { items: { include: { product: true } } } }>;

// Builds the response from server-side data only. All money is integer cents.
function toDto(cart: CartWithItems | null) {
  const items = (cart?.items ?? [])
    .slice()
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id))
    .map((i) => {
      const p = i.product;
      let issue: null | { code: string; message: string; available?: number } = null;
      if (!p.isActive) issue = { code: "UNAVAILABLE", message: "This product is no longer available." };
      else if (p.stockQuantity !== null && p.stockQuantity === 0) issue = { code: "OUT_OF_STOCK", message: "This product is out of stock.", available: 0 };
      else if (p.stockQuantity !== null && i.quantity > p.stockQuantity)
        issue = { code: "INSUFFICIENT_STOCK", message: `Only ${p.stockQuantity} left in stock. Reduce the quantity.`, available: p.stockQuantity };
      return {
        productId: p.id,
        name: p.name,
        slug: p.slug,
        type: p.type,
        image: p.image,
        quantity: i.quantity,
        unitPriceCents: p.priceCents,
        lineTotalCents: p.priceCents * i.quantity,
        issue,
      };
    });
  return {
    cart: {
      currency: "EUR",
      items,
      itemCount: items.reduce((n, i) => n + i.quantity, 0),
      subtotalCents: items.reduce((n, i) => n + i.lineTotalCents, 0),
      hasIssues: items.some((i) => i.issue),
    },
  };
}

const loadCart = (db: Tx | typeof prisma, userId: string) =>
  db.cart.findUnique({ where: { userId }, include: { items: { include: { product: true } } } });

// Runs fn with the user's cart row locked, so concurrent changes by the same user are serialized
// (no lost updates, stock check and write happen atomically w.r.t. other cart operations).
async function withLockedCart<T>(userId: string, fn: (tx: Tx, cartId: string) => Promise<T>): Promise<T> {
  return prisma.$transaction(async (tx) => {
    const cart = await tx.cart.upsert({ where: { userId }, create: { userId }, update: {} });
    await tx.$queryRaw`SELECT id FROM "Cart" WHERE id = ${cart.id}::uuid FOR UPDATE`;
    return fn(tx, cart.id);
  });
}

// Validates that `wanted` units of the product may be in a cart, based on current server-side data.
function assertCanHold(product: { isActive: boolean; stockQuantity: number | null }, wanted: number) {
  if (!product.isActive) throw new CartError(404, "Product not found", "NOT_FOUND");
  if (wanted > MAX_ITEM_QUANTITY)
    throw new CartError(409, `Maximum quantity per item is ${MAX_ITEM_QUANTITY}`, "MAX_QUANTITY", { max: MAX_ITEM_QUANTITY });
  if (product.stockQuantity !== null) {
    if (product.stockQuantity === 0) throw new CartError(409, "This product is out of stock", "OUT_OF_STOCK", { available: 0 });
    if (wanted > product.stockQuantity)
      throw new CartError(409, `Only ${product.stockQuantity} in stock`, "INSUFFICIENT_STOCK", { available: product.stockQuantity });
  }
}

const handle = (fn: (req: Request, res: Response, userId: string) => Promise<void>) => async (req: Request, res: Response) => {
  try {
    await fn(req, res, req.session.userId!);
  } catch (e) {
    if (e instanceof CartError) {
      res.status(e.status).json({ error: e.message, code: e.code, ...e.extra });
      return;
    }
    throw e;
  }
};

export const cartRouter = Router();
cartRouter.use(requireAuth); // every cart route requires a session; the cart is always the session user's own

cartRouter.get("/", handle(async (_req, res, userId) => {
  res.json(toDto(await loadCart(prisma, userId)));
}));

cartRouter.post("/items", handle(async (req, res, userId) => {
  const parsed = addBody.safeParse(req.body);
  if (!parsed.success) throw new CartError(400, parsed.error.issues[0].message, "INVALID_INPUT", { fields: parsed.error.flatten().fieldErrors });
  const { productId, quantity: add } = parsed.data;
  await withLockedCart(userId, async (tx, cartId) => {
    const product = await tx.product.findUnique({ where: { id: productId } });
    if (!product) throw new CartError(404, "Product not found", "NOT_FOUND");
    const existing = await tx.cartItem.findUnique({ where: { cartId_productId: { cartId, productId } } });
    assertCanHold(product, (existing?.quantity ?? 0) + add);
    await tx.cartItem.upsert({
      where: { cartId_productId: { cartId, productId } },
      create: { cartId, productId, quantity: add },
      update: { quantity: (existing?.quantity ?? 0) + add },
    });
  });
  res.status(201).json(toDto(await loadCart(prisma, userId)));
}));

cartRouter.patch("/items/:productId", handle(async (req, res, userId) => {
  const pid = productIdParam.safeParse(req.params.productId);
  const parsed = patchBody.safeParse(req.body);
  if (!pid.success) throw new CartError(400, "Invalid product id", "INVALID_INPUT");
  if (!parsed.success) throw new CartError(400, parsed.error.issues[0].message, "INVALID_INPUT", { fields: parsed.error.flatten().fieldErrors });
  await withLockedCart(userId, async (tx, cartId) => {
    const item = await tx.cartItem.findUnique({ where: { cartId_productId: { cartId, productId: pid.data } }, include: { product: true } });
    if (!item) throw new CartError(404, "Item is not in your cart", "NOT_IN_CART");
    // Lowering the quantity is always allowed (lets users fix an item whose stock dropped).
    if (parsed.data.quantity > item.quantity) assertCanHold(item.product, parsed.data.quantity);
    await tx.cartItem.update({ where: { id: item.id }, data: { quantity: parsed.data.quantity } });
  });
  res.json(toDto(await loadCart(prisma, userId)));
}));

cartRouter.delete("/items/:productId", handle(async (req, res, userId) => {
  const pid = productIdParam.safeParse(req.params.productId);
  if (!pid.success) throw new CartError(400, "Invalid product id", "INVALID_INPUT");
  await withLockedCart(userId, async (tx, cartId) => {
    // deleteMany is idempotent: removing an already-removed item is not an error.
    await tx.cartItem.deleteMany({ where: { cartId, productId: pid.data } });
  });
  res.json(toDto(await loadCart(prisma, userId)));
}));

cartRouter.delete("/", handle(async (_req, res, userId) => {
  await withLockedCart(userId, async (tx, cartId) => {
    await tx.cartItem.deleteMany({ where: { cartId } });
  });
  res.json(toDto(await loadCart(prisma, userId)));
}));
