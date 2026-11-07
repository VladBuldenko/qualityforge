import "dotenv/config";

const isProd = process.env.NODE_ENV === "production";

export const config = {
  isProd,
  port: Number(process.env.API_PORT ?? 4000),
  webOrigin: process.env.WEB_ORIGIN ?? "http://localhost:5173",
  databaseUrl: process.env.DATABASE_URL ?? "",
  sessionSecret: process.env.SESSION_SECRET ?? "",
};

if (!config.databaseUrl) {
  throw new Error("DATABASE_URL is not set (see .env.example)");
}
if (config.sessionSecret.length < 16) {
  throw new Error("SESSION_SECRET must be set and at least 16 characters (see .env.example)");
}
if (isProd && config.sessionSecret.startsWith("walletshop-dev")) {
  throw new Error("Refusing to use the development SESSION_SECRET in production");
}
