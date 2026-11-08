-- CreateTable
CREATE TABLE "Exchange" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "fromCurrency" "Currency" NOT NULL,
    "toCurrency" "Currency" NOT NULL,
    "fromAmountMinor" INTEGER NOT NULL,
    "toAmountMinor" INTEGER NOT NULL,
    "rateNumerator" INTEGER NOT NULL,
    "rateDenominator" INTEGER NOT NULL,
    "rateVersion" TEXT NOT NULL,
    "debitTransactionId" UUID NOT NULL,
    "creditTransactionId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Exchange_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Exchange_debitTransactionId_key" ON "Exchange"("debitTransactionId");

-- CreateIndex
CREATE UNIQUE INDEX "Exchange_creditTransactionId_key" ON "Exchange"("creditTransactionId");

-- CreateIndex
CREATE INDEX "Exchange_userId_createdAt_idx" ON "Exchange"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Exchange_userId_idempotencyKey_key" ON "Exchange"("userId", "idempotencyKey");

-- AddForeignKey
ALTER TABLE "Exchange" ADD CONSTRAINT "Exchange_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Exchange" ADD CONSTRAINT "Exchange_debitTransactionId_fkey" FOREIGN KEY ("debitTransactionId") REFERENCES "WalletTransaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Exchange" ADD CONSTRAINT "Exchange_creditTransactionId_fkey" FOREIGN KEY ("creditTransactionId") REFERENCES "WalletTransaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ---- Integrity: EUR<->USD only, positive amounts, valid rate; immutable history ----
ALTER TABLE "Exchange" ADD CONSTRAINT "Exchange_currencies_differ" CHECK ("fromCurrency" <> "toCurrency");
ALTER TABLE "Exchange" ADD CONSTRAINT "Exchange_amounts_positive" CHECK ("fromAmountMinor" > 0 AND "toAmountMinor" > 0);
ALTER TABLE "Exchange" ADD CONSTRAINT "Exchange_rate_positive" CHECK ("rateNumerator" > 0 AND "rateDenominator" > 0);
ALTER TABLE "Exchange" ADD CONSTRAINT "Exchange_debit_credit_differ" CHECK ("debitTransactionId" <> "creditTransactionId");
-- Executed amount must equal floor(from * numerator / denominator) in the stored direction.
ALTER TABLE "Exchange" ADD CONSTRAINT "Exchange_amount_matches_rate"
  CHECK ("toAmountMinor"::bigint = ("fromAmountMinor"::bigint * "rateNumerator"::bigint) / "rateDenominator"::bigint);

-- Completed exchanges are append-only (same guard as the ledger; deletes only via the test-cleanup setting).
CREATE TRIGGER "Exchange_append_only" BEFORE UPDATE OR DELETE ON "Exchange" FOR EACH ROW EXECUTE FUNCTION walletshop_ledger_guard();
