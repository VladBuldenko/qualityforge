import connectPgSimple from "connect-pg-simple";
import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import session from "express-session";
import pg from "pg";
import { authRouter, SESSION_COOKIE } from "./auth.js";
import { productsRouter } from "./products.js";
import { config } from "./config.js";
import { prisma } from "./db.js";

export const app = express();

if (config.isProd) app.set("trust proxy", 1); // behind a TLS-terminating proxy
app.disable("x-powered-by");

app.use(cors({ origin: config.webOrigin, credentials: true }));
app.use(express.json({ limit: "10kb" }));

const PgStore = connectPgSimple(session);
app.use(
  session({
    name: SESSION_COOKIE,
    store: new PgStore({ pool: new pg.Pool({ connectionString: config.databaseUrl }), tableName: "session" }),
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: config.isProd,
      maxAge: 7 * 24 * 60 * 60 * 1000,
    },
  }),
);

// CSRF protection for cookie auth: state-changing requests must come from the web app's origin
// (browsers always send Origin on cross-origin/POST requests and it can't be forged by other sites).
app.use((req: Request, res: Response, next: NextFunction) => {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  if (req.get("origin") !== config.webOrigin) {
    res.status(403).json({ error: "Forbidden origin" });
    return;
  }
  next();
});

app.get("/health", async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ status: "ok", database: "up" });
  } catch {
    res.status(503).json({ status: "error", database: "down" });
  }
});

app.use("/api/auth", authRouter);
app.use("/api/products", productsRouter);

// Express 5 forwards async errors here; keep unexpected failures as clean 500s.
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error(err);
  res.status(500).json({ error: "Internal server error" });
});
