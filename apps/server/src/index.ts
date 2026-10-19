import "dotenv/config";
import { trpcServer } from "@hono/trpc-server";
import { connectDB } from "@nexdrive/db";
import { createContext } from "@nexdrive/api/context";
import { getEnv } from "@nexdrive/api/env";
import { appRouter } from "@nexdrive/api/routers/index";
import { getAuth } from "@nexdrive/auth";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";

// Validate environment variables at startup - will throw if missing/invalid
const env = getEnv();

// Establish the MongoDB connection before serving anything. The router's
// models and Better Auth's adapter both read from this shared connection.
await connectDB(env.MONGODB_URI);

const auth = getAuth();
const app = new Hono();

app.use(logger());
app.use(
  "/*",
  cors({
    origin: env.CORS_ORIGIN,
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  }),
);

app.on(["POST", "GET"], "/api/auth/*", (c) => auth.handler(c.req.raw));

app.use(
  "/trpc/*",
  trpcServer({
    router: appRouter,
    createContext: (_opts, context) => {
      return createContext({ context });
    },
  }),
);

app.get("/", (c) => {
  return c.text("OK");
});

export default app;
