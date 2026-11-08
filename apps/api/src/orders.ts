import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { FulfillmentState, Prisma } from "@prisma/client";
import { requireAuth } from "./auth.js";
import { prisma } from "./db.js";

// ---------------------------------------------------------------------------
// Orders (read-only API). There are deliberately NO endpoints that edit orders, refund, or change fulfillment:
// orders are created only by POST /api/checkout, in the same DB transaction as the wallet debit.
// The owner always comes from the session; other users' orders are indistinguishable from missing ones (404).
// ---------------------------------------------------------------------------

/** SIMULATED delivery timeline for physical items (demo only, no carrier): age of the order -> state. */
export const SHIPPED_AFTER_MS = 2 * 60 * 1000;
export const DELIVERED_AFTER_MS = 5 * 60 * 1000;

const RANK: Record<FulfillmentState, number> = { PROCESSING: 0, SHIPPED: 1, DELIVERED: 2 };

export function simulatedStateFor(ageMs: number): FulfillmentState {
  if (ageMs >= DELIVERED_AFTER_MS) return "DELIVERED";
  if (ageMs >= SHIPPED_AFTER_MS) return "SHIPPED";
  return "PROCESSING";
}

/**
 * Moves the owner's physical items forward along the simulated timeline (never backwards) and completes finished orders.
 * Runs only inside the owner's own authenticated read requests; there is no way to set a state from outside.
 */
export async function advanceSimulatedDelivery(userId: string, orderIds?: string[]) {
  const pending = await prisma.orderItem.findMany({
    where: { productType: "PHYSICAL", fulfillmentState: { not: "DELIVERED" }, order: { userId, ...(orderIds ? { id: { in: orderIds } } : {}) } },
    select: { id: true, fulfillmentState: true, order: { select: { createdAt: true } } },
  });
  const now = Date.now();
  for (const item of pending) {
    const target = simulatedStateFor(now - item.order.createdAt.getTime());
    if (RANK[target] > RANK[item.fulfillmentState])
      // Conditional update keeps progress monotonic even with concurrent readers.
      await prisma.orderItem.updateMany({
        where: { id: item.id, fulfillmentState: { in: (Object.keys(RANK) as FulfillmentState[]).filter((s) => RANK[s] < RANK[target]) } },
        data: { fulfillmentState: target },
      });
  }
  await prisma.order.updateMany({
    where: { userId, status: "CONFIRMED", items: { none: { fulfillmentState: { not: "DELIVERED" } } }, ...(orderIds ? { id: { in: orderIds } } : {}) },
    data: { status: "COMPLETED" },
  });
}

const DISCLAIMER = {
  digital: "Demo entitlement only. This code does not unlock any real software and nothing can be downloaded.",
  physical: "Simulated delivery for demonstration. No real shipment, carrier or tracking number exists.",
};

type OrderFull = Prisma.OrderGetPayload<{ include: { items: { include: { digital: true } } } }>;

const shortRef = (id: string) => id.slice(0, 8).toUpperCase(); // same short form the wallet history shows

function summary(o: OrderFull) {
  return {
    id: o.id,
    reference: o.reference,
    createdAt: o.createdAt,
    currency: o.currency,
    totalCents: o.totalCents,
    paymentStatus: o.paymentStatus,
    status: o.status,
    itemCount: o.items.reduce((n, i) => n + i.quantity, 0),
    hasPhysical: o.items.some((i) => i.productType === "PHYSICAL"),
    hasDigital: o.items.some((i) => i.productType === "DIGITAL"),
  };
}

function detail(o: OrderFull) {
  const hasPhysical = o.items.some((i) => i.productType === "PHYSICAL");
  return {
    ...summary(o),
    payment: { method: "EUR wallet", status: o.paymentStatus, amountCents: o.totalCents, currency: o.currency, walletReference: shortRef(o.walletTransactionId) },
    shipping: o.shippingName
      ? { name: o.shippingName, line1: o.shippingLine1, line2: o.shippingLine2, city: o.shippingCity, postalCode: o.shippingPostalCode, country: o.shippingCountry }
      : null,
    delivery: hasPhysical ? { simulated: true, note: DISCLAIMER.physical } : null,
    items: o.items
      .slice()
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id))
      .map((i) => ({
        id: i.id,
        productId: i.productId,
        name: i.productName, // snapshot, not the live catalog
        type: i.productType,
        quantity: i.quantity,
        unitPriceCents: i.unitPriceCents,
        lineTotalCents: i.lineTotalCents,
        currency: i.currency,
        fulfillmentState: i.fulfillmentState,
        simulatedDelivery: i.productType === "PHYSICAL",
        entitlements: i.digital
          .slice()
          .sort((a, b) => a.unitIndex - b.unitIndex)
          .map((d) => ({ kind: "DEMO_LICENSE", code: d.code, issuedAt: d.issuedAt, note: DISCLAIMER.digital })),
      })),
  };
}

export async function loadOrderDetail(userId: string, id: string) {
  if (!z.string().uuid().safeParse(id).success) return null;
  await advanceSimulatedDelivery(userId, [id]);
  const order = await prisma.order.findFirst({ where: { id, userId }, include: { items: { include: { digital: true } } } });
  return order ? detail(order) : null;
}

const listQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(10),
});

export const ordersRouter = Router();
ordersRouter.use(requireAuth);

ordersRouter.get("/", async (req: Request, res: Response) => {
  const q = listQuery.safeParse(req.query);
  if (!q.success) {
    res.status(400).json({ error: "Invalid query", fields: q.error.flatten().fieldErrors });
    return;
  }
  const userId = req.session.userId!;
  await advanceSimulatedDelivery(userId);
  const [total, rows] = await Promise.all([
    prisma.order.count({ where: { userId } }),
    prisma.order.findMany({
      where: { userId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (q.data.page - 1) * q.data.pageSize,
      take: q.data.pageSize,
      include: { items: { include: { digital: true } } },
    }),
  ]);
  res.json({ items: rows.map(summary), page: q.data.page, pageSize: q.data.pageSize, total, totalPages: Math.max(1, Math.ceil(total / q.data.pageSize)) });
});

ordersRouter.get("/:id", async (req: Request, res: Response) => {
  const order = await loadOrderDetail(req.session.userId!, String(req.params.id));
  if (!order) {
    res.status(404).json({ error: "Order not found" });
    return;
  }
  res.json({ order });
});
