-- CreateEnum
CREATE TYPE "PaymentProvider" AS ENUM ('STRIPE');

-- CreateEnum
CREATE TYPE "TopUpStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED', 'CANCELED');

-- CreateTable
CREATE TABLE "TopUp" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "provider" "PaymentProvider" NOT NULL DEFAULT 'STRIPE',
    "amountMinor" INTEGER NOT NULL,
    "currency" "Currency" NOT NULL DEFAULT 'EUR',
    "status" "TopUpStatus" NOT NULL DEFAULT 'PENDING',
    "stripeCheckoutSessionId" TEXT,
    "stripePaymentIntentId" TEXT,
    "walletTransactionId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TopUp_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TopUp_stripeCheckoutSessionId_key" ON "TopUp"("stripeCheckoutSessionId");

-- CreateIndex
CREATE UNIQUE INDEX "TopUp_stripePaymentIntentId_key" ON "TopUp"("stripePaymentIntentId");

-- CreateIndex
CREATE UNIQUE INDEX "TopUp_walletTransactionId_key" ON "TopUp"("walletTransactionId");

-- CreateIndex
CREATE INDEX "TopUp_userId_createdAt_idx" ON "TopUp"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "TopUp" ADD CONSTRAINT "TopUp_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TopUp" ADD CONSTRAINT "TopUp_walletTransactionId_fkey" FOREIGN KEY ("walletTransactionId") REFERENCES "WalletTransaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Integrity rules Prisma cannot express
ALTER TABLE "TopUp"
  ADD CONSTRAINT "TopUp_amount_positive" CHECK ("amountMinor" > 0),
  ADD CONSTRAINT "TopUp_eur_only" CHECK ("currency" = 'EUR'),
  -- a top-up is SUCCEEDED if and only if its wallet credit is recorded
  ADD CONSTRAINT "TopUp_succeeded_has_credit" CHECK (("status" = 'SUCCEEDED') = ("walletTransactionId" IS NOT NULL));
