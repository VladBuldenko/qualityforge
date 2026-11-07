import { PrismaClient, ProductType } from "@prisma/client";

const prisma = new PrismaClient();

type Seed = {
  name: string;
  slug: string;
  type: ProductType;
  category: string;
  priceCents: number;
  stockQuantity: number | null;
  description: string;
};

const P = ProductType.PHYSICAL;
const D = ProductType.DIGITAL;

const products: Seed[] = [
  { name: "Wireless Headphones", slug: "wireless-headphones", type: P, category: "Audio", priceCents: 8999, stockQuantity: 25,
    description: "Over-ear wireless headphones with active noise cancelling and up to 30 hours of battery life." },
  { name: "Mechanical Keyboard", slug: "mechanical-keyboard", type: P, category: "Computer Accessories", priceCents: 11900, stockQuantity: 12,
    description: "Compact 75% mechanical keyboard with hot-swappable switches and per-key RGB backlight." },
  { name: "Gaming Mouse", slug: "gaming-mouse", type: P, category: "Computer Accessories", priceCents: 4950, stockQuantity: 3,
    description: "Lightweight 16,000 DPI gaming mouse with six programmable buttons." },
  { name: "USB-C Hub", slug: "usb-c-hub", type: P, category: "Computer Accessories", priceCents: 3499, stockQuantity: 0,
    description: "7-in-1 USB-C hub: HDMI, two USB-A ports, SD reader and 100W power pass-through." },
  { name: "Bluetooth Speaker", slug: "bluetooth-speaker", type: P, category: "Audio", priceCents: 5990, stockQuantity: 40,
    description: "Portable waterproof speaker with deep bass and 12 hours of playtime." },
  { name: "Productivity Software License", slug: "productivity-software-license", type: D, category: "Software", priceCents: 4900, stockQuantity: null,
    description: "One-year demo license for a task and notes suite. Delivered as a license key after purchase." },
  { name: "Cloud Storage Demo Code", slug: "cloud-storage-demo-code", type: D, category: "Software", priceCents: 999, stockQuantity: null,
    description: "Redeemable demo code for 1 TB of cloud storage for three months." },
  { name: "Design Template Pack", slug: "design-template-pack", type: D, category: "Design", priceCents: 2900, stockQuantity: null,
    description: "120 editable templates for presentations, social posts and invoices. Instant download." },
  { name: "Digital Learning Course", slug: "digital-learning-course", type: D, category: "Education", priceCents: 7900, stockQuantity: null,
    description: "Self-paced online course with 40 video lessons, exercises and a completion certificate." },
  { name: "Demo Software Subscription", slug: "demo-software-subscription", type: D, category: "Software", priceCents: 1299, stockQuantity: null,
    description: "Monthly demo subscription to a fictional creative software suite. Cancel any time." },
];

// Idempotent: only inserts products whose slug doesn't exist yet. Existing rows
// (including any later edits to price/stock) are never overwritten, and nothing is deleted.
const result = await prisma.product.createMany({
  data: products.map((p) => ({ ...p, currency: "EUR", image: `/products/${p.slug}.svg` })),
  skipDuplicates: true,
});
console.log(`Seed: ${result.count} product(s) inserted, ${products.length - result.count} already present.`);
await prisma.$disconnect();
