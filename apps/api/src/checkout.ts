import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { requireAuth } from "./auth.js";
import { loadCart, toDto } from "./cart.js";
import { prisma } from "./db.js";
import { loadOrderDetail } from "./orders.js";
import { debit, ensureWallets, getBalances, WalletError } from "./wallet.js";

// ---------------------------------------------------------------------------
// Checkout: pays for the cart from the customer's EUR demo wallet.
// Everything that matters happens in ONE PostgreSQL transaction (see performCheckout), so the order, wallet debit,
// stock decrease, digital entitlements and cart clearing commit or roll back together.
//
// Lock order (same everywhere, so no deadlocks): Cart row -> Product rows (ordered by id) -> wallet account row.
// ---------------------------------------------------------------------------

class CheckoutError extends Error {
  constructor(
    public status: number,
    message: string,
    public code: string,
    public extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

const text = (min: number, max: number, label: string) =>
  z.string().trim().min(min, `${label} is required`).max(max, `${label} is too long`).regex(/^[^<>\u0000-\u001f]*$/, `${label} contains invalid characters`);

export const shippingSchema = z.object({
  name: text(2, 80, "Full name"),
  line1: text(3, 100, "Address"),
  line2: z.string().trim().max(100, "Address line 2 is too long").regex(/^[^<>\u0000-\u001f]*$/, "Address line 2 contains invalid characters").optional().transform((v) => v || undefined),
  city: text(2, 60, "City"),
  postalCode: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9 -]{1,10}[A-Za-z0-9]$/, "Enter a valid postal code"),
  country: text(2, 60, "Country"),
});
type Shipping = z.infer<typeof shippingSchema>;

const checkoutBody = z.object({
  idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{16,100}$/, "idempotencyKey must be 16-100 characters (letters, digits, - or _)"),
  shipping: z.unknown().optional(), // validated separately: only required when the cart has physical items
});

// Crockford base32 without ambiguous characters.
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const randomChars = (n: number) => Array.from(randomBytes(n), (b) => ALPHABET[b % 32]).join("");
const newReference = () => `WS-${randomChars(10)}`;
const newDemoCode = () => `DEMO-${randomChars(4)}-${randomChars(4)}-${randomChars(4)}`;

const hashRequest = (shipping: Shipping | null) =>
  createHash("sha256").update(JSON.stringify(shipping ? [shipping.name, shipping.line1, shipping.line2 ?? "", shipping.city, shipping.postalCode, shipping.country] : null)).digest("hex");

type Issue = { productId: string; name: string; code: string; message: string; available?: number };

async function runCheckout(userId: string, key: string, shipping: Shipping | null, rawShipping: unknown) {
  return prisma.$transaction(async (tx) => {
    // 1. Lock the customer's cart (serializes this user's concurrent checkouts / cart edits).
    const cart = await tx.cart.upsert({ where: { userId }, create: { userId }, update: {} });
    await tx.$queryRaw`SELECT id FROM "Cart" WHERE id = ${cart.id}::uuid FOR UPDATE`;

    // Idempotency: decided only after the lock, so a concurrent twin always sees the committed original.
    const requestHash = hashRequest(shipping);
    const existing = await tx.order.findUnique({ where: { userId_idempotencyKey: { userId, idempotencyKey: key } } });
    if (existing) {
      if (existing.requestHash !== requestHash)
        throw new CheckoutError(409, "This idempotency key was already used for a different checkout request.", "IDEMPOTENCY_KEY_REUSED");
      return { orderId: existing.id, replayed: true };
    }

    // 2-3. Cart must not be empty. Lock the product rows in a consistent (id) order.
    const items = await tx.cartItem.findMany({ where: { cartId: cart.id }, orderBy: { productId: "asc" } });
    if (items.length === 0) throw new CheckoutError(409, "Your cart is empty.", "EMPTY_CART");
    const productIds = items.map((i) => i.productId);
    await tx.$queryRaw`SELECT id FROM "Product" WHERE id IN (${Prisma.join(productIds.map((id) => Prisma.sql`${id}::uuid`))}) ORDER BY id FOR UPDATE`;

    // 4-6. Re-read authoritative state (prices, stock, activity) after the locks.
    const products = new Map((await tx.product.findMany({ where: { id: { in: productIds } } })).map((p) => [p.id, p]));
    const issues: Issue[] = [];
    for (const i of items) {
      const p = products.get(i.productId)!;
      if (!p.isActive) issues.push({ productId: p.id, name: p.name, code: "UNAVAILABLE", message: `${p.name} is no longer available.` });
      else if (p.stockQuantity !== null && p.stockQuantity === 0) issues.push({ productId: p.id, name: p.name, code: "OUT_OF_STOCK", message: `${p.name} is out of stock.`, available: 0 });
      else if (p.stockQuantity !== null && i.quantity > p.stockQuantity)
        issues.push({ productId: p.id, name: p.name, code: "INSUFFICIENT_STOCK", message: `Only ${p.stockQuantity} of ${p.name} left in stock.`, available: p.stockQuantity });
    }
    if (issues.length) throw new CheckoutError(409, "Some items in your cart are no longer available.", "ITEMS_UNAVAILABLE", { issues });

    const hasPhysical = items.some((i) => products.get(i.productId)!.type === "PHYSICAL");
    if (hasPhysical && !shipping) {
      const parsed = shippingSchema.safeParse(rawShipping ?? {});
      throw new CheckoutError(400, "Shipping details are required for physical products.", "SHIPPING_REQUIRED", parsed.success ? {} : { fields: flatFields(parsed.error) });
    }

    // 7. Authoritative total in integer cents.
    const lines = items.map((i) => {
      const p = products.get(i.productId)!;
      return { item: i, product: p, lineTotalCents: p.priceCents * i.quantity };
    });
    const totalCents = lines.reduce((n, l) => n + l.lineTotalCents, 0);
    if (!Number.isSafeInteger(totalCents) || totalCents <= 0) throw new CheckoutError(409, "This order has nothing to pay.", "NOTHING_TO_PAY");

    // 8-10. Debit the wallet (atomic; locks the wallet row; throws INSUFFICIENT_FUNDS) and create the order.
    const orderId = randomUUID();
    const reference = newReference();
    await ensureWallets(userId, tx);
    const payment = await debit(
      { userId, currency: "EUR", amountMinor: totalCents, operationId: `order:${orderId}`, description: `Order ${reference}` },
      tx,
    );
    const ship = hasPhysical ? shipping : null;
    await tx.order.create({
      data: {
        id: orderId, reference, userId, totalCents, currency: "EUR", requestHash, idempotencyKey: key,
        walletTransactionId: payment.reference,
        status: hasPhysical ? "CONFIRMED" : "COMPLETED",
        shippingName: ship?.name, shippingLine1: ship?.line1, shippingLine2: ship?.line2 ?? null,
        shippingCity: ship?.city, shippingPostalCode: ship?.postalCode, shippingCountry: ship?.country,
      },
    });
    for (const l of lines) {
      const p = l.product;
      const orderItem = await tx.orderItem.create({
        data: {
          orderId, productId: p.id, productName: p.name, productType: p.type, quantity: l.item.quantity,
          unitPriceCents: p.priceCents, lineTotalCents: l.lineTotalCents, currency: "EUR",
          fulfillmentState: p.type === "DIGITAL" ? "DELIVERED" : "PROCESSING",
        },
      });
      // 11. Physical stock (guarded again by the DB CHECK stockQuantity >= 0).
      if (p.stockQuantity !== null)
        await tx.product.update({ where: { id: p.id }, data: { stockQuantity: { decrement: l.item.quantity } } });
      // 12. Digital demo entitlements exist only because the payment above is part of this same transaction.
      if (p.type === "DIGITAL")
        await tx.digitalFulfillment.createMany({
          data: Array.from({ length: l.item.quantity }, (_, unitIndex) => ({ orderItemId: orderItem.id, unitIndex, code: newDemoCode() })),
        });
    }
    // 13. Clear the purchased items.
    await tx.cartItem.deleteMany({ where: { cartId: cart.id } });
    return { orderId, replayed: false };
  });
}

const flatFields = (e: z.ZodError) => {
  const out: Record<string, string[]> = {};
  for (const i of e.issues) (out[`shipping.${String(i.path[0] ?? "")}`] ??= []).push(i.message);
  return out;
};

export const checkoutRouter = Router();
checkoutRouter.use(requireAuth);

// Informative only: checkout re-validates everything inside its own transaction.
checkoutRouter.get("/preview", async (req: Request, res: Response) => {
  const userId = req.session.userId!;
  const { cart } = toDto(await loadCart(prisma, userId));
  const balanceCents = (await getBalances(userId)).find((b) => b.currency === "EUR")?.balanceMinor ?? 0;
  const blockers: { code: string; message: string; shortfallCents?: number }[] = [];
  if (cart.items.length === 0) blockers.push({ code: "EMPTY_CART", message: "Your cart is empty." });
  for (const i of cart.items) if (i.issue) blockers.push({ code: i.issue.code, message: `${i.name}: ${i.issue.message}` });
  if (cart.items.length > 0 && cart.subtotalCents <= 0) blockers.push({ code: "NOTHING_TO_PAY", message: "This order has nothing to pay." });
  if (cart.subtotalCents > balanceCents)
    blockers.push({ code: "INSUFFICIENT_FUNDS", message: "Your EUR wallet balance is too low.", shortfallCents: cart.subtotalCents - balanceCents });
  res.json({
    preview: {
      ...cart,
      totalCents: cart.subtotalCents,
      walletBalanceCents: balanceCents,
      shortfallCents: Math.max(0, cart.subtotalCents - balanceCents),
      requiresShipping: cart.items.some((i) => i.type === "PHYSICAL"),
      canCheckout: blockers.length === 0,
      blockers,
    },
  });
});

checkoutRouter.post("/", async (req: Request, res: Response) => {
  const userId = req.session.userId!;
  const body = checkoutBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.issues[0].message, code: "INVALID_INPUT", fields: body.error.flatten().fieldErrors });
    return;
  }
  // Any price/total fields a client sends are ignored: the body schema has no such inputs.
  let shipping: Shipping | null = null;
  if (body.data.shipping !== undefined && body.data.shipping !== null) {
    const s = shippingSchema.safeParse(body.data.shipping);
    if (!s.success) {
      res.status(400).json({ error: s.error.issues[0].message, code: "INVALID_SHIPPING", fields: flatFields(s.error) });
      return;
    }
    shipping = s.data;
  }

  try {
    let result;
    try {
      result = await runCheckout(userId, body.data.idempotencyKey, shipping, body.data.shipping);
    } catch (e) {
      // Lost a unique-constraint race (e.g. first-ever cart creation): the retry sees the committed state.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") result = await runCheckout(userId, body.data.idempotencyKey, shipping, body.data.shipping);
      else throw e;
    }
    const order = await loadOrderDetail(userId, result.orderId);
    res.status(result.replayed ? 200 : 201).json({ order, replayed: result.replayed });
  } catch (e) {
    if (e instanceof CheckoutError) {
      res.status(e.status).json({ error: e.message, code: e.code, ...e.extra });
      return;
    }
    if (e instanceof WalletError && e.code === "INSUFFICIENT_FUNDS") {
      // The whole transaction rolled back: nothing was charged, reserved or cleared.
      const { cart } = toDto(await loadCart(prisma, userId));
      const balanceCents = (await getBalances(userId)).find((b) => b.currency === "EUR")?.balanceMinor ?? 0;
      res.status(409).json({
        error: "Your EUR wallet balance is too low to pay for this order.",
        code: "INSUFFICIENT_FUNDS",
        totalCents: cart.subtotalCents,
        walletBalanceCents: balanceCents,
        shortfallCents: Math.max(0, cart.subtotalCents - balanceCents),
      });
      return;
    }
    throw e;
  }
});
