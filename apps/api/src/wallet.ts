import { Router } from "express";
import { z } from "zod";
import { Prisma, type Currency } from "@prisma/client";
import { requireAuth } from "./auth.js";
import { prisma } from "./db.js";

// ---------------------------------------------------------------------------
// Wallet service (internal). There are deliberately NO public credit/debit endpoints:
// later tasks call credit() after a verified Stripe test payment and debit() at checkout.
// All amounts are integer minor units (cents).
// ---------------------------------------------------------------------------

export const CURRENCIES: Currency[] = ["EUR", "USD"];
export const MAX_AMOUNT_MINOR = 2_000_000_000; // keeps balances inside PostgreSQL INTEGER

export class WalletError extends Error {
  constructor(
    public code: "INVALID_AMOUNT" | "INVALID_CURRENCY" | "INSUFFICIENT_FUNDS" | "BALANCE_LIMIT" | "OPERATION_ID_REUSED" | "NO_WALLET",
    message: string,
  ) {
    super(message);
  }
}

export type OperationInput = {
  userId: string;
  currency: Currency;
  amountMinor: number;
  /** Unique idempotency key for this financial operation (e.g. "stripe:pi_123", "order:<id>"). */
  operationId: string;
  description?: string;
};

type Tx = Prisma.TransactionClient;

/** Creates the user's EUR and USD accounts if missing (safe to call repeatedly / concurrently). */
export async function ensureWallets(userId: string, db: Tx | typeof prisma = prisma) {
  await db.walletAccount.createMany({
    data: CURRENCIES.map((currency) => ({ userId, currency, kind: "USER" as const })),
    skipDuplicates: true,
  });
}

export async function getBalances(userId: string) {
  await ensureWallets(userId);
  const accounts = await prisma.walletAccount.findMany({ where: { userId, kind: "USER" } });
  return CURRENCIES.map((currency) => ({
    currency,
    balanceMinor: accounts.find((a) => a.currency === currency)?.balanceMinor ?? 0,
  }));
}

export async function hasFunds(userId: string, currency: Currency, amountMinor: number) {
  assertAmount(amountMinor);
  const acct = await prisma.walletAccount.findUnique({ where: { userId_currency: { userId, currency } } });
  return !!acct && acct.balanceMinor >= amountMinor;
}

export async function getTransactions(userId: string, opts: { page: number; pageSize: number; currency?: Currency }) {
  const where: Prisma.WalletTransactionWhereInput = { userId, ...(opts.currency ? { currency: opts.currency } : {}) };
  const [total, rows] = await Promise.all([
    prisma.walletTransaction.count({ where }),
    prisma.walletTransaction.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (opts.page - 1) * opts.pageSize,
      take: opts.pageSize,
      include: { entries: { where: { account: { kind: "USER" } }, select: { balanceAfterMinor: true } } },
    }),
  ]);
  return {
    total,
    items: rows.map((t) => ({
      reference: t.id, // safe public reference; the internal operationId is never exposed
      type: t.type,
      currency: t.currency,
      amountMinor: t.amountMinor,
      balanceAfterMinor: t.entries[0]?.balanceAfterMinor ?? null,
      description: t.description,
      createdAt: t.createdAt,
    })),
  };
}

function assertAmount(amountMinor: number) {
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0 || amountMinor > MAX_AMOUNT_MINOR)
    throw new WalletError("INVALID_AMOUNT", "Amount must be a positive whole number of minor units");
}

export const credit = (input: OperationInput) => applyOperation("CREDIT", input);
export const debit = (input: OperationInput) => applyOperation("DEBIT", input);

/**
 * Atomically moves funds between the user's account and the currency's clearing account.
 * - The user's account row is locked (SELECT ... FOR UPDATE), so concurrent operations on one wallet are serialized
 *   and the balance check + update can't race (no overspending, no lost updates).
 * - operationId is unique: repeating a finished operation returns the original result without moving money again.
 * - Transaction + two ledger entries + balance update commit or roll back together.
 */
async function applyOperation(type: "CREDIT" | "DEBIT", input: OperationInput) {
  const { userId, currency, amountMinor, operationId, description } = input;
  assertAmount(amountMinor);
  if (!CURRENCIES.includes(currency)) throw new WalletError("INVALID_CURRENCY", "Unsupported currency");
  if (!operationId || operationId.length > 200) throw new WalletError("OPERATION_ID_REUSED", "A valid operationId is required");

  try {
    return await prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ id: string; balanceMinor: number }[]>`
        SELECT id, "balanceMinor" FROM "WalletAccount"
        WHERE "userId" = ${userId}::uuid AND "currency" = ${currency}::"Currency" AND "kind" = 'USER'
        FOR UPDATE`;
      const account = locked[0];
      if (!account) throw new WalletError("NO_WALLET", "Wallet not found");

      const existing = await tx.walletTransaction.findUnique({ where: { operationId } });
      if (existing) {
        if (existing.userId !== userId || existing.type !== type || existing.currency !== currency || existing.amountMinor !== amountMinor)
          throw new WalletError("OPERATION_ID_REUSED", "operationId was already used for a different operation");
        return { duplicate: true, reference: existing.id, balanceMinor: account.balanceMinor };
      }

      const delta = type === "CREDIT" ? amountMinor : -amountMinor;
      const newBalance = account.balanceMinor + delta;
      if (newBalance < 0) throw new WalletError("INSUFFICIENT_FUNDS", "Insufficient balance");
      if (newBalance > MAX_AMOUNT_MINOR) throw new WalletError("BALANCE_LIMIT", "Balance limit exceeded");

      const clearing = await tx.walletAccount.findFirstOrThrow({ where: { kind: "CLEARING", currency } });
      await tx.walletAccount.update({ where: { id: account.id }, data: { balanceMinor: newBalance } });
      const t = await tx.walletTransaction.create({
        data: {
          operationId, userId, type, currency, amountMinor, description,
          entries: {
            create: [
              { accountId: account.id, amountMinor: delta, balanceAfterMinor: newBalance },
              { accountId: clearing.id, amountMinor: -delta },
            ],
          },
        },
      });
      return { duplicate: false, reference: t.id, balanceMinor: newBalance };
    });
  } catch (e) {
    // Same operationId used by two different users at once: the unique index rejects the second.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002")
      throw new WalletError("OPERATION_ID_REUSED", "operationId was already used");
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Read-only authenticated API. The wallet owner always comes from the session.
// ---------------------------------------------------------------------------

const txQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(10),
  currency: z.enum(["EUR", "USD"]).optional(),
});

export const walletRouter = Router();
walletRouter.use(requireAuth);

walletRouter.get("/", async (req, res) => {
  res.json({ wallet: { balances: await getBalances(req.session.userId!) } });
});

walletRouter.get("/transactions", async (req, res) => {
  const q = txQuery.safeParse(req.query);
  if (!q.success) {
    res.status(400).json({ error: "Invalid query", fields: q.error.flatten().fieldErrors });
    return;
  }
  const { total, items } = await getTransactions(req.session.userId!, q.data);
  res.json({ items, page: q.data.page, pageSize: q.data.pageSize, total, totalPages: Math.max(1, Math.ceil(total / q.data.pageSize)) });
});
