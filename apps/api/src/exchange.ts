import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { Prisma, type Currency } from "@prisma/client";
import { requireAuth } from "./auth.js";
import { prisma } from "./db.js";
import { credit, debit, ensureWallets, getBalances, MAX_AMOUNT_MINOR, WalletError } from "./wallet.js";

// ---------------------------------------------------------------------------
// EUR <-> USD DEMO currency exchange. The rate is a fixed, illustrative number (NOT market pricing):
//   1 EUR = 1.10 USD = 11/10.   EUR->USD multiplies by 11/10, USD->EUR by the reciprocal 10/11.
// All arithmetic is exact integer math (BigInt intermediates) and rounds DOWN to the minor unit. No fee.
// ---------------------------------------------------------------------------

export const RATE_VERSION = "demo-v1";
const RATES: Record<string, { numerator: number; denominator: number }> = {
  "EUR>USD": { numerator: 11, denominator: 10 },
  "USD>EUR": { numerator: 10, denominator: 11 },
};
export const DEMO_RATE_TEXT = "1 EUR = 1.10 USD (demo rate, not real market pricing; no fee)";

export class ExchangeError extends Error {
  constructor(
    public status: number,
    public code: "INVALID_PAIR" | "AMOUNT_TOO_SMALL" | "AMOUNT_TOO_LARGE" | "STALE_RATE" | "INSUFFICIENT_FUNDS" | "BALANCE_LIMIT" | "IDEMPOTENCY_KEY_REUSED",
    message: string,
    public extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

/** Exact quote: destination = floor(source * numerator / denominator). Throws if the result would be zero or too large. */
export function computeQuote(from: Currency, to: Currency, amountMinor: number) {
  const rate = RATES[`${from}>${to}`];
  if (!rate) throw new ExchangeError(400, "INVALID_PAIR", "Only EUR to USD and USD to EUR exchanges are supported");
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0 || amountMinor > MAX_AMOUNT_MINOR)
    throw new ExchangeError(400, "AMOUNT_TOO_LARGE", "Amount must be a positive whole number of cents within limits");
  const toAmount = (BigInt(amountMinor) * BigInt(rate.numerator)) / BigInt(rate.denominator);
  if (toAmount <= 0n) throw new ExchangeError(400, "AMOUNT_TOO_SMALL", "Amount is too small: you would receive less than one cent");
  if (toAmount > BigInt(MAX_AMOUNT_MINOR)) throw new ExchangeError(400, "AMOUNT_TOO_LARGE", "Resulting amount exceeds the wallet limit");
  return {
    fromCurrency: from,
    toCurrency: to,
    fromAmountMinor: amountMinor,
    toAmountMinor: Number(toAmount),
    rateNumerator: rate.numerator,
    rateDenominator: rate.denominator,
    rateVersion: RATE_VERSION,
    rateText: DEMO_RATE_TEXT,
  };
}

let failAfterDebitForTests = false;
/** Tests only: makes execution fail after the source debit, to prove the whole transaction rolls back. */
export function setFailAfterDebitForTests(v: boolean) {
  failAfterDebitForTests = v;
}

export type ExchangeInput = { userId: string; fromCurrency: Currency; toCurrency: Currency; amountMinor: number; rateVersion: string; idempotencyKey: string };


const dto = (e: Prisma.ExchangeGetPayload<object>) => ({
  id: e.id,
  fromCurrency: e.fromCurrency,
  toCurrency: e.toCurrency,
  fromAmountMinor: e.fromAmountMinor,
  toAmountMinor: e.toAmountMinor,
  rateNumerator: e.rateNumerator,
  rateDenominator: e.rateDenominator,
  rateVersion: e.rateVersion,
  debitReference: e.debitTransactionId,
  creditReference: e.creditTransactionId,
  createdAt: e.createdAt,
});

/**
 * Executes an exchange in ONE database transaction:
 * lock EUR wallet then USD wallet (fixed order => opposite-direction exchanges can't deadlock; checkout and top-ups
 * only ever lock the EUR wallet) -> idempotency check -> validate -> debit -> credit -> record. Anything failing rolls everything back.
 */
export async function executeExchange(input: ExchangeInput) {
  const { userId, fromCurrency, toCurrency, amountMinor, rateVersion, idempotencyKey } = input;
  const quote = computeQuote(fromCurrency, toCurrency, amountMinor);
  await ensureWallets(userId);

  return prisma.$transaction(async (tx) => {
    for (const currency of ["EUR", "USD"] as const) {
      await tx.$queryRaw`
        SELECT id FROM "WalletAccount"
        WHERE "userId" = ${userId}::uuid AND "currency" = ${currency}::"Currency" AND "kind" = 'USER' FOR UPDATE`;
    }

    const existing = await tx.exchange.findUnique({ where: { userId_idempotencyKey: { userId, idempotencyKey } } });
    if (existing) {
      if (existing.fromCurrency !== fromCurrency || existing.toCurrency !== toCurrency || existing.fromAmountMinor !== amountMinor || existing.rateVersion !== rateVersion)
        throw new ExchangeError(409, "IDEMPOTENCY_KEY_REUSED", "This idempotency key was already used for a different exchange");
      return { exchange: dto(existing), replayed: true };
    }

    if (rateVersion !== RATE_VERSION)
      throw new ExchangeError(409, "STALE_RATE", "The exchange rate has changed. Please request a fresh quote.", { currentRateVersion: RATE_VERSION });

    const id = crypto.randomUUID();
    const desc = `Currency exchange ${fromCurrency} → ${toCurrency} (${DEMO_RATE_TEXT.split(" (")[0]})`;
    let debited, credited;
    try {
      debited = await debit({ userId, currency: fromCurrency, amountMinor, operationId: `exchange:${id}:debit`, description: `${desc}: sent` }, tx);
      if (failAfterDebitForTests) throw new Error("forced failure after debit (test)");
      credited = await credit({ userId, currency: toCurrency, amountMinor: quote.toAmountMinor, operationId: `exchange:${id}:credit`, description: `${desc}: received` }, tx);
    } catch (e) {
      if (e instanceof WalletError && e.code === "INSUFFICIENT_FUNDS") {
        const have = (await tx.walletAccount.findUniqueOrThrow({ where: { userId_currency: { userId, currency: fromCurrency } } })).balanceMinor;
        throw new ExchangeError(409, "INSUFFICIENT_FUNDS", `Insufficient ${fromCurrency} balance`, { balanceMinor: have, shortfallMinor: amountMinor - have });
      }
      if (e instanceof WalletError && e.code === "BALANCE_LIMIT") throw new ExchangeError(409, "BALANCE_LIMIT", "The destination wallet balance limit would be exceeded");
      throw e;
    }
    const exchange = await tx.exchange.create({
      data: {
        id, userId, idempotencyKey, fromCurrency, toCurrency,
        fromAmountMinor: amountMinor, toAmountMinor: quote.toAmountMinor,
        rateNumerator: quote.rateNumerator, rateDenominator: quote.rateDenominator, rateVersion: RATE_VERSION,
        debitTransactionId: debited.reference, creditTransactionId: credited.reference,
      },
    });
    return { exchange: dto(exchange), replayed: false };
  });
}

// ---------------------------------------------------------------------------
// API (session-authenticated; the user always comes from the session)
// ---------------------------------------------------------------------------

const currencyEnum = z.enum(["EUR", "USD"], { message: "Currency must be EUR or USD" });
const pair = { fromCurrency: currencyEnum, toCurrency: currencyEnum };
const quoteQuery = z.object({
  ...pair,
  amountMinor: z.string().regex(/^\d{1,10}$/, "amountMinor must be a whole number of cents").transform(Number),
});
const execBody = z.object({
  ...pair,
  amountMinor: z.number({ message: "amountMinor must be a number" }).int("amountMinor must be a whole number of cents").positive("Amount must be positive"),
  rateVersion: z.string().min(1).max(40),
  idempotencyKey: z.string().regex(/^[A-Za-z0-9_.:-]{8,100}$/, "idempotencyKey must be 8-100 URL-safe characters"),
});
const listQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(10),
});

function fail(res: Response, e: unknown): boolean {
  if (e instanceof ExchangeError) {
    res.status(e.status).json({ error: e.message, code: e.code, ...e.extra });
    return true;
  }
  return false;
}
const badRequest = (res: Response, err: z.ZodError) =>
  res.status(400).json({ error: err.issues[0].message, code: "VALIDATION", fields: err.flatten().fieldErrors });

export const exchangeRouter = Router();
exchangeRouter.use(requireAuth);

exchangeRouter.get("/quote", async (req: Request, res: Response) => {
  const q = quoteQuery.safeParse(req.query);
  if (!q.success) return void badRequest(res, q.error);
  try {
    const quote = computeQuote(q.data.fromCurrency, q.data.toCurrency, q.data.amountMinor);
    const balance = (await getBalances(req.session.userId!)).find((b) => b.currency === quote.fromCurrency)!.balanceMinor;
    res.json({ quote: { ...quote, availableBalanceMinor: balance, sufficientFunds: balance >= quote.fromAmountMinor } });
  } catch (e) {
    if (!fail(res, e)) throw e;
  }
});

exchangeRouter.post("/", async (req: Request, res: Response) => {
  const b = execBody.safeParse(req.body);
  if (!b.success) return void badRequest(res, b.error);
  try {
    const { exchange, replayed } = await executeExchange({ userId: req.session.userId!, ...b.data });
    res.status(replayed ? 200 : 201).json({ exchange, replayed, balances: await getBalances(req.session.userId!) });
  } catch (e) {
    if (!fail(res, e)) throw e;
  }
});

export const exchangesRouter = Router();
exchangesRouter.use(requireAuth);

exchangesRouter.get("/", async (req: Request, res: Response) => {
  const q = listQuery.safeParse(req.query);
  if (!q.success) return void badRequest(res, q.error);
  const where = { userId: req.session.userId! };
  const [total, rows] = await Promise.all([
    prisma.exchange.count({ where }),
    prisma.exchange.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "desc" }], skip: (q.data.page - 1) * q.data.pageSize, take: q.data.pageSize }),
  ]);
  res.json({ items: rows.map(dto), page: q.data.page, pageSize: q.data.pageSize, total, totalPages: Math.max(1, Math.ceil(total / q.data.pageSize)) });
});
