import express, { Router, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import Stripe from "stripe";
import { z } from "zod";
import { requireAuth } from "./auth.js";
import { config } from "./config.js";
import { prisma } from "./db.js";
import { credit } from "./wallet.js";

// ---------------------------------------------------------------------------
// Stripe Checkout wallet top-ups — TEST MODE ONLY (config.ts rejects non-test keys).
// A top-up is created PENDING, the customer pays on Stripe's hosted page, and the wallet is credited only
// after a signed webhook (or a server-side session lookup) confirms payment_status === "paid".
// ---------------------------------------------------------------------------

export const MIN_TOP_UP_MINOR = 500; // €5
export const MAX_TOP_UP_MINOR = 50_000; // €500

let stripeClient: Stripe | null = null;
let stripeOverride: Stripe | null | undefined; // tests only: undefined = use env config, null = force "not configured"
/** Lazily built from env; tests inject a client whose network calls are mocked. */
export function getStripe(): Stripe | null {
  if (stripeOverride !== undefined) return stripeOverride;
  if (!stripeClient && config.stripeSecretKey) stripeClient = new Stripe(config.stripeSecretKey);
  return stripeClient;
}
export function setStripeForTests(client: Stripe | null | undefined) {
  stripeOverride = client;
}

const creditOperationId = (sessionId: string) => `stripe:checkout_session:${sessionId}`;

const createBody = z.object({
  currency: z.literal("EUR", { message: "Only EUR top-ups are supported" }),
  amountMinor: z
    .number({ message: "Amount must be a number" })
    .int("Amount must be a whole number of cents")
    .min(MIN_TOP_UP_MINOR, "Minimum top-up is €5.00")
    .max(MAX_TOP_UP_MINOR, "Maximum top-up is €500.00"),
});

const idParam = z.string().uuid();

const toDto = (t: { id: string; status: string; amountMinor: number; currency: string; createdAt: Date; updatedAt: Date }) => ({
  id: t.id,
  status: t.status,
  amountMinor: t.amountMinor,
  currency: t.currency,
  createdAt: t.createdAt,
  updatedAt: t.updatedAt,
});

// ---------------------------------------------------------------------------
// Completion: the ONLY place a top-up becomes SUCCEEDED and the wallet is credited.
// ---------------------------------------------------------------------------

type PaidSession = { id: string; amountTotal: number | null; currency: string | null; paymentIntentId: string | null; livemode: boolean };

export function sessionToPaid(s: Stripe.Checkout.Session): PaidSession {
  const pi = typeof s.payment_intent === "string" ? s.payment_intent : (s.payment_intent?.id ?? null);
  return { id: s.id, amountTotal: s.amount_total, currency: s.currency, paymentIntentId: pi, livemode: s.livemode };
}

/**
 * Marks the matching top-up SUCCEEDED and credits the wallet in ONE database transaction.
 * Safe to call any number of times, concurrently, from webhooks or status polling:
 * the top-up row is locked, a finished top-up is returned as-is, and the credit is idempotent by operationId.
 */
export async function completeTopUp(s: PaidSession): Promise<"credited" | "duplicate" | "unknown" | "rejected"> {
  if (s.livemode) return "rejected"; // never act on live-mode objects
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM "TopUp" WHERE "stripeCheckoutSessionId" = ${s.id} FOR UPDATE`;
    if (!rows[0]) return "unknown" as const; // not a session we created
    const topUp = await tx.topUp.findUniqueOrThrow({ where: { id: rows[0].id } });
    if (topUp.status === "SUCCEEDED") return "duplicate" as const;

    // The payment must be exactly what the server asked for.
    if (s.amountTotal !== topUp.amountMinor || s.currency?.toLowerCase() !== "eur") {
      console.error(`Top-up ${topUp.id}: payment details do not match (amount/currency); not crediting`);
      await tx.topUp.update({ where: { id: topUp.id }, data: { status: "FAILED" } });
      return "rejected" as const;
    }

    const result = await credit(
      {
        userId: topUp.userId,
        currency: "EUR",
        amountMinor: topUp.amountMinor,
        operationId: creditOperationId(s.id),
        description: "Wallet top-up (Stripe test payment)",
      },
      tx,
    );
    await tx.topUp.update({
      where: { id: topUp.id },
      data: { status: "SUCCEEDED", walletTransactionId: result.reference, stripePaymentIntentId: s.paymentIntentId ?? undefined },
    });
    return "credited" as const;
  });
}

/** Moves a still-open top-up to a terminal non-success state. Never touches a SUCCEEDED top-up. */
async function closeTopUp(sessionId: string, status: "CANCELED" | "FAILED") {
  await prisma.topUp.updateMany({ where: { stripeCheckoutSessionId: sessionId, status: "PENDING" }, data: { status } });
}

/** Asks Stripe (server-side, with our secret key) what happened to a pending top-up's session and applies it. */
async function reconcile(topUp: { id: string; status: string; stripeCheckoutSessionId: string | null }) {
  const stripe = getStripe();
  if (topUp.status !== "PENDING" || !topUp.stripeCheckoutSessionId || !stripe) return;
  try {
    const session = await stripe.checkout.sessions.retrieve(topUp.stripeCheckoutSessionId);
    if (session.payment_status === "paid") await completeTopUp(sessionToPaid(session));
    else if (session.status === "expired") await closeTopUp(session.id, "CANCELED");
  } catch (e) {
    console.error("Stripe session lookup failed:", e instanceof Error ? e.message : e); // customer can retry/poll later
  }
}

// ---------------------------------------------------------------------------
// Authenticated API
// ---------------------------------------------------------------------------

const createLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: Number(process.env.TOPUP_RATE_LIMIT ?? 30),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.session.userId ?? "anon",
  validate: { keyGeneratorIpFallback: false },
  message: { error: "Too many top-up attempts. Try again later." },
});

export const topUpsRouter = Router();
topUpsRouter.use(requireAuth);

topUpsRouter.post("/", createLimiter, async (req: Request, res: Response) => {
  const parsed = createBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0].message, fields: parsed.error.flatten().fieldErrors });
    return;
  }
  const stripe = getStripe();
  if (!stripe) {
    res.status(503).json({ error: "Payments are not configured on this server (missing Stripe test keys)." });
    return;
  }
  const userId = req.session.userId!;
  const { amountMinor } = parsed.data;

  // 1. Persist the pending operation BEFORE the customer can pay.
  const topUp = await prisma.topUp.create({ data: { userId, amountMinor, currency: "EUR" } });

  try {
    // 2. Create the hosted Checkout Session; the idempotency key makes retries return the same session.
    const session = await stripe.checkout.sessions.create(
      {
        mode: "payment",
        client_reference_id: topUp.id,
        metadata: { topUpId: topUp.id, userId },
        line_items: [
          { quantity: 1, price_data: { currency: "eur", unit_amount: amountMinor, product_data: { name: "WalletShop EUR wallet top-up (test mode)" } } },
        ],
        success_url: `${config.webOrigin}/wallet/top-up/result?topUp=${topUp.id}`,
        cancel_url: `${config.webOrigin}/wallet/top-up/result?topUp=${topUp.id}&canceled=1`,
        expires_at: Math.floor(Date.now() / 1000) + 31 * 60,
      },
      { idempotencyKey: `wallet-top-up:${topUp.id}` },
    );
    if (session.livemode || !session.url || !/^https:\/\/checkout\.stripe\.com\//.test(session.url)) {
      throw new Error("Stripe returned an unexpected checkout session");
    }
    await prisma.topUp.update({
      where: { id: topUp.id },
      data: {
        stripeCheckoutSessionId: session.id,
        stripePaymentIntentId: typeof session.payment_intent === "string" ? session.payment_intent : undefined,
      },
    });
    res.status(201).json({ topUp: toDto(topUp), checkoutUrl: session.url });
  } catch (e) {
    console.error("Could not create Stripe Checkout Session:", e instanceof Error ? e.message : e);
    await prisma.topUp.updateMany({ where: { id: topUp.id, status: "PENDING" }, data: { status: "FAILED" } });
    res.status(502).json({ error: "Could not start the payment. Please try again." });
  }
});

topUpsRouter.get("/:id", async (req: Request, res: Response) => {
  const id = idParam.safeParse(req.params.id);
  // userId always comes from the session: another user's top-up is indistinguishable from a missing one.
  const found = id.success ? await prisma.topUp.findFirst({ where: { id: id.data, userId: req.session.userId! } }) : null;
  if (!found) {
    res.status(404).json({ error: "Top-up not found" });
    return;
  }
  await reconcile(found); // covers a delayed or missing webhook
  const latest = await prisma.topUp.findUniqueOrThrow({ where: { id: found.id } });
  res.json({ topUp: toDto(latest) });
});

// The customer clicked "back" on Stripe's page. Expire the session so it can no longer be paid, then mark it canceled.
topUpsRouter.post("/:id/cancel", async (req: Request, res: Response) => {
  const id = idParam.safeParse(req.params.id);
  const found = id.success ? await prisma.topUp.findFirst({ where: { id: id.data, userId: req.session.userId! } }) : null;
  if (!found) {
    res.status(404).json({ error: "Top-up not found" });
    return;
  }
  const stripe = getStripe();
  if (found.status === "PENDING" && found.stripeCheckoutSessionId && stripe) {
    try {
      await stripe.checkout.sessions.expire(found.stripeCheckoutSessionId);
      await closeTopUp(found.stripeCheckoutSessionId, "CANCELED");
    } catch {
      await reconcile(found); // expiring fails if the session was already paid: then credit it instead
    }
  }
  const latest = await prisma.topUp.findUniqueOrThrow({ where: { id: found.id } });
  res.json({ topUp: toDto(latest) });
});

// ---------------------------------------------------------------------------
// Stripe webhook. Mounted BEFORE express.json() and the Origin/CSRF check: it needs the exact raw body, and it is
// authenticated by Stripe's signature instead of a browser session.
// ---------------------------------------------------------------------------

export const stripeWebhookRouter = Router();

stripeWebhookRouter.post("/", express.raw({ type: "application/json", limit: "1mb" }), async (req: Request, res: Response) => {
  const stripe = getStripe();
  if (!stripe || !config.stripeWebhookSecret) {
    res.status(503).json({ error: "Webhook is not configured" });
    return;
  }
  const signature = req.get("stripe-signature");
  if (!signature || !Buffer.isBuffer(req.body)) {
    res.status(400).json({ error: "Missing signature" });
    return;
  }
  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(req.body, signature, config.stripeWebhookSecret);
  } catch {
    res.status(400).json({ error: "Invalid signature" });
    return;
  }
  if (event.livemode) {
    res.status(200).json({ received: true, ignored: "live-mode event" });
    return;
  }

  try {
    switch (event.type) {
      case "checkout.session.completed":
      case "checkout.session.async_payment_succeeded": {
        const session = event.data.object as Stripe.Checkout.Session;
        // For delayed methods "completed" arrives unpaid; credit only once payment_status is "paid".
        if (session.payment_status === "paid") await completeTopUp(sessionToPaid(session));
        break;
      }
      case "checkout.session.async_payment_failed":
        await closeTopUp((event.data.object as Stripe.Checkout.Session).id, "FAILED");
        break;
      case "checkout.session.expired":
        await closeTopUp((event.data.object as Stripe.Checkout.Session).id, "CANCELED");
        break;
      default:
        break; // unrelated events are acknowledged and ignored
    }
    res.json({ received: true });
  } catch (e) {
    console.error("Webhook processing failed:", e instanceof Error ? e.message : e);
    res.status(500).json({ error: "Processing failed" }); // Stripe will retry
  }
});
