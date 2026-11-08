-- CreateEnum
CREATE TYPE "Currency" AS ENUM ('EUR', 'USD');

-- CreateEnum
CREATE TYPE "AccountKind" AS ENUM ('USER', 'CLEARING');

-- CreateEnum
CREATE TYPE "TransactionType" AS ENUM ('CREDIT', 'DEBIT');

-- CreateTable
CREATE TABLE "WalletAccount" (
    "id" UUID NOT NULL,
    "userId" UUID,
    "currency" "Currency" NOT NULL,
    "kind" "AccountKind" NOT NULL DEFAULT 'USER',
    "balanceMinor" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WalletAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WalletTransaction" (
    "id" UUID NOT NULL,
    "operationId" TEXT NOT NULL,
    "userId" UUID NOT NULL,
    "type" "TransactionType" NOT NULL,
    "currency" "Currency" NOT NULL,
    "amountMinor" INTEGER NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WalletTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LedgerEntry" (
    "id" UUID NOT NULL,
    "transactionId" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "amountMinor" INTEGER NOT NULL,
    "balanceAfterMinor" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WalletAccount_userId_currency_key" ON "WalletAccount"("userId", "currency");

-- CreateIndex
CREATE UNIQUE INDEX "WalletTransaction_operationId_key" ON "WalletTransaction"("operationId");

-- CreateIndex
CREATE INDEX "WalletTransaction_userId_createdAt_idx" ON "WalletTransaction"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "LedgerEntry_transactionId_idx" ON "LedgerEntry"("transactionId");

-- CreateIndex
CREATE INDEX "LedgerEntry_accountId_createdAt_idx" ON "LedgerEntry"("accountId", "createdAt");

-- AddForeignKey
ALTER TABLE "WalletAccount" ADD CONSTRAINT "WalletAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalletTransaction" ADD CONSTRAINT "WalletTransaction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "WalletTransaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "WalletAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ---- Integrity rules Prisma cannot express ----
ALTER TABLE "WalletAccount"
  ADD CONSTRAINT "WalletAccount_kind_owner" CHECK (("kind" = 'USER') = ("userId" IS NOT NULL)),
  ADD CONSTRAINT "WalletAccount_no_negative_balance" CHECK ("kind" = 'CLEARING' OR "balanceMinor" >= 0);
-- exactly one clearing account per currency (NULL userId would otherwise bypass the unique index)
CREATE UNIQUE INDEX "WalletAccount_one_clearing_per_currency" ON "WalletAccount"("currency") WHERE "kind" = 'CLEARING';
ALTER TABLE "WalletTransaction" ADD CONSTRAINT "WalletTransaction_amount_positive" CHECK ("amountMinor" > 0);
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_amount_nonzero" CHECK ("amountMinor" <> 0);

-- Append-only ledger: rows can never be updated; deletes are refused unless explicitly allowed
-- for the current transaction (used only by test cleanup).
CREATE FUNCTION walletshop_ledger_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'ledger tables are append-only (UPDATE refused on %)', TG_TABLE_NAME;
  END IF;
  IF coalesce(current_setting('walletshop.allow_ledger_delete', true), '') <> 'on' THEN
    RAISE EXCEPTION 'ledger tables are append-only (DELETE refused on %)', TG_TABLE_NAME;
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "WalletTransaction_append_only" BEFORE UPDATE OR DELETE ON "WalletTransaction" FOR EACH ROW EXECUTE FUNCTION walletshop_ledger_guard();
CREATE TRIGGER "LedgerEntry_append_only" BEFORE UPDATE OR DELETE ON "LedgerEntry" FOR EACH ROW EXECUTE FUNCTION walletshop_ledger_guard();

-- ---- Data: clearing accounts and wallets for existing users (zero balances) ----
INSERT INTO "WalletAccount" ("id", "userId", "currency", "kind", "balanceMinor", "createdAt", "updatedAt")
SELECT gen_random_uuid(), NULL, c, 'CLEARING', 0, now(), now() FROM unnest(ARRAY['EUR', 'USD']::"Currency"[]) AS c;

INSERT INTO "WalletAccount" ("id", "userId", "currency", "kind", "balanceMinor", "createdAt", "updatedAt")
SELECT gen_random_uuid(), u."id", c, 'USER', 0, now(), now()
FROM "User" u CROSS JOIN unnest(ARRAY['EUR', 'USD']::"Currency"[]) AS c
ON CONFLICT DO NOTHING;
