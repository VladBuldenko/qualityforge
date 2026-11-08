-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('PAID');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('CONFIRMED', 'COMPLETED');

-- CreateEnum
CREATE TYPE "FulfillmentState" AS ENUM ('PROCESSING', 'SHIPPED', 'DELIVERED');

-- CreateTable
CREATE TABLE "Order" (
    "id" UUID NOT NULL,
    "reference" TEXT NOT NULL,
    "userId" UUID NOT NULL,
    "currency" "Currency" NOT NULL DEFAULT 'EUR',
    "totalCents" INTEGER NOT NULL,
    "paymentStatus" "PaymentStatus" NOT NULL DEFAULT 'PAID',
    "status" "OrderStatus" NOT NULL DEFAULT 'CONFIRMED',
    "idempotencyKey" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "walletTransactionId" UUID NOT NULL,
    "shippingName" TEXT,
    "shippingLine1" TEXT,
    "shippingLine2" TEXT,
    "shippingCity" TEXT,
    "shippingPostalCode" TEXT,
    "shippingCountry" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderItem" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "productName" TEXT NOT NULL,
    "productType" "ProductType" NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unitPriceCents" INTEGER NOT NULL,
    "lineTotalCents" INTEGER NOT NULL,
    "currency" "Currency" NOT NULL DEFAULT 'EUR',
    "fulfillmentState" "FulfillmentState" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DigitalFulfillment" (
    "id" UUID NOT NULL,
    "orderItemId" UUID NOT NULL,
    "unitIndex" INTEGER NOT NULL,
    "code" TEXT NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DigitalFulfillment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Order_reference_key" ON "Order"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "Order_walletTransactionId_key" ON "Order"("walletTransactionId");

-- CreateIndex
CREATE INDEX "Order_userId_createdAt_idx" ON "Order"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Order_userId_idempotencyKey_key" ON "Order"("userId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "OrderItem_orderId_idx" ON "OrderItem"("orderId");

-- CreateIndex
CREATE INDEX "OrderItem_productId_idx" ON "OrderItem"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "DigitalFulfillment_code_key" ON "DigitalFulfillment"("code");

-- CreateIndex
CREATE UNIQUE INDEX "DigitalFulfillment_orderItemId_unitIndex_key" ON "DigitalFulfillment"("orderItemId", "unitIndex");

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_walletTransactionId_fkey" FOREIGN KEY ("walletTransactionId") REFERENCES "WalletTransaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DigitalFulfillment" ADD CONSTRAINT "DigitalFulfillment_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "OrderItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Integrity rules that Prisma cannot express. These are the last line of defence behind the application logic.
ALTER TABLE "Order" ADD CONSTRAINT "Order_total_positive" CHECK ("totalCents" > 0);
ALTER TABLE "Order" ADD CONSTRAINT "Order_eur_only" CHECK ("currency" = 'EUR');
ALTER TABLE "Order" ADD CONSTRAINT "Order_shipping_all_or_none" CHECK (
  ("shippingName" IS NULL AND "shippingLine1" IS NULL AND "shippingCity" IS NULL AND "shippingPostalCode" IS NULL AND "shippingCountry" IS NULL AND "shippingLine2" IS NULL)
  OR ("shippingName" IS NOT NULL AND "shippingLine1" IS NOT NULL AND "shippingCity" IS NOT NULL AND "shippingPostalCode" IS NOT NULL AND "shippingCountry" IS NOT NULL)
);
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_quantity_range" CHECK ("quantity" BETWEEN 1 AND 20);
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_price_nonnegative" CHECK ("unitPriceCents" >= 0);
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_line_total" CHECK ("lineTotalCents" = "unitPriceCents" * "quantity");
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_eur_only" CHECK ("currency" = 'EUR');
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_digital_delivered" CHECK ("productType" <> 'DIGITAL' OR "fulfillmentState" = 'DELIVERED');
