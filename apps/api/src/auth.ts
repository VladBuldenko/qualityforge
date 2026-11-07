import bcrypt from "bcryptjs";
import { Router, type NextFunction, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { prisma } from "./db.js";

const SESSION_COOKIE = "walletshop.sid";
export { SESSION_COOKIE };

const normalizeEmail = (v: string) => v.trim().toLowerCase();

const registerSchema = z.object({
  name: z.string().trim().min(2, "Name must be at least 2 characters").max(80),
  email: z.string().trim().max(254).email("Enter a valid email address").transform(normalizeEmail),
  // bcrypt only uses the first 72 bytes, so cap the length.
  password: z
    .string()
    .min(8, "Password must be at least 8 characters")
    .max(72, "Password must be at most 72 characters"),
});

const loginSchema = z.object({
  email: z.string().trim().max(254).email().transform(normalizeEmail),
  password: z.string().min(1).max(72),
});

const publicUser = (u: { id: string; name: string; email: string; role: string; createdAt: Date }) => ({
  id: u.id,
  name: u.name,
  email: u.email,
  role: u.role,
  createdAt: u.createdAt,
});

// A real hash to compare against when the email is unknown, so timing doesn't reveal which emails exist.
const DUMMY_HASH = bcrypt.hashSync("walletshop-dummy-password", 10);

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!req.session.userId) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  next();
}

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: Number(process.env.LOGIN_RATE_LIMIT ?? 10),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many login attempts. Try again later." },
});

export const authRouter = Router();

authRouter.post("/register", async (req, res) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input", fields: parsed.error.flatten().fieldErrors });
    return;
  }
  const { name, email, password } = parsed.data;
  const passwordHash = await bcrypt.hash(password, 12);
  try {
    // role is never taken from the request: new users are always CUSTOMER.
    const user = await prisma.user.create({ data: { name, email, passwordHash } });
    res.status(201).json({ user: publicUser(user) });
  } catch (e: any) {
    if (e?.code === "P2002") {
      res.status(409).json({ error: "An account with this email already exists" });
      return;
    }
    throw e;
  }
});

authRouter.post("/login", loginLimiter, async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Enter a valid email and password" });
    return;
  }
  const { email, password } = parsed.data;
  const user = await prisma.user.findUnique({ where: { email } });
  const ok = await bcrypt.compare(password, user?.passwordHash ?? DUMMY_HASH);
  if (!user || !ok) {
    res.status(401).json({ error: "Invalid email or password" });
    return;
  }
  // New session id on login prevents session fixation.
  req.session.regenerate((err) => {
    if (err) return res.status(500).json({ error: "Could not start session" });
    req.session.userId = user.id;
    req.session.save((err2) => {
      if (err2) return res.status(500).json({ error: "Could not start session" });
      res.json({ user: publicUser(user) });
    });
  });
});

authRouter.get("/me", requireAuth, async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.session.userId! } });
  if (!user) {
    req.session.destroy(() => res.status(401).json({ error: "Not authenticated" }));
    return;
  }
  res.json({ user: publicUser(user) });
});

authRouter.post("/logout", (req, res) => {
  req.session.destroy(() => {
    res.clearCookie(SESSION_COOKIE);
    res.json({ ok: true });
  });
});
