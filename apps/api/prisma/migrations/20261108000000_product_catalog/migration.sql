-- CreateEnum
CREATE TYPE "ProductType" AS ENUM ('PHYSICAL', 'DIGITAL');

-- CreateTable
CREATE TABLE "Product" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "type" "ProductType" NOT NULL,
    "category" TEXT NOT NULL,
    "priceCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "image" TEXT NOT NULL,
    "stockQuantity" INTEGER,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Product_slug_key" ON "Product"("slug");

-- CreateIndex
CREATE INDEX "Product_isActive_type_idx" ON "Product"("isActive", "type");

-- CreateIndex
CREATE INDEX "Product_category_idx" ON "Product"("category");


-- Integrity rules Prisma cannot express
ALTER TABLE "Product"
  ADD CONSTRAINT "Product_priceCents_nonneg" CHECK ("priceCents" >= 0),
  ADD CONSTRAINT "Product_stock_nonneg" CHECK ("stockQuantity" IS NULL OR "stockQuantity" >= 0),
  ADD CONSTRAINT "Product_physical_has_stock" CHECK ("type" <> 'PHYSICAL' OR "stockQuantity" IS NOT NULL);
