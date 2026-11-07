import { Router } from "express";
import { z } from "zod";
import type { Prisma, Product } from "@prisma/client";
import { prisma } from "./db.js";

const listQuery = z.object({
  q: z.string().trim().max(100).optional(),
  type: z.enum(["PHYSICAL", "DIGITAL"]).optional(),
  category: z.string().trim().max(60).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(12),
});

const slugParam = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(100);

const toDto = (p: Product) => ({
  id: p.id,
  name: p.name,
  slug: p.slug,
  description: p.description,
  type: p.type,
  category: p.category,
  priceCents: p.priceCents,
  currency: p.currency,
  image: p.image,
  stockQuantity: p.stockQuantity, // null = unlimited (digital)
  inStock: p.stockQuantity === null || p.stockQuantity > 0,
});

export const productsRouter = Router();

// Public, read-only. There are intentionally no write endpoints.
productsRouter.get("/", async (req, res) => {
  const parsed = listQuery.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid query", fields: parsed.error.flatten().fieldErrors });
    return;
  }
  const { q, type, category, page, pageSize } = parsed.data;
  const where: Prisma.ProductWhereInput = {
    isActive: true,
    ...(q ? { name: { contains: q, mode: "insensitive" } } : {}),
    ...(type ? { type } : {}),
    ...(category ? { category } : {}),
  };
  const [total, items, cats] = await Promise.all([
    prisma.product.count({ where }),
    prisma.product.findMany({ where, orderBy: [{ name: "asc" }], skip: (page - 1) * pageSize, take: pageSize }),
    prisma.product.findMany({ where: { isActive: true }, select: { category: true }, distinct: ["category"], orderBy: { category: "asc" } }),
  ]);
  res.json({
    items: items.map(toDto),
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
    categories: cats.map((c) => c.category),
  });
});

productsRouter.get("/:slug", async (req, res) => {
  const slug = slugParam.safeParse(req.params.slug);
  const product = slug.success
    ? await prisma.product.findFirst({ where: { slug: slug.data, isActive: true } })
    : null;
  if (!product) {
    res.status(404).json({ error: "Product not found" });
    return;
  }
  res.json({ product: toDto(product) });
});
