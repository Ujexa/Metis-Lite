import express from "express";
import { createServer } from "node:http";
import { searchOpenModels } from "./modelSearch";
import { parseTrustProxyHops } from "./config";
import { serveStatic, setupVite } from "./vite";

async function startServer() {
  const app = express();
  const server = createServer(app);

  app.disable("x-powered-by");
  // Do not trust client-supplied forwarding headers unless deployment explicitly has a trusted proxy.
  app.set("trust proxy", parseTrustProxyHops(process.env.TRUST_PROXY_HOPS));
  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    res.setHeader("X-Frame-Options", "SAMEORIGIN");
    next();
  });

  app.get("/api/health", (_req, res) => {
    res.set("Cache-Control", "no-store").json({ status: "ok" });
  });
  app.get("/api/models/search", (req, res) => {
    void searchOpenModels(req, res).catch(error => {
      console.error(
        "Model search failed:",
        error instanceof Error ? error.message : error
      );
      if (!res.headersSent) {
        res.set("Cache-Control", "no-store").status(500).json({
          error: "Model search failed unexpectedly. Please try again.",
        });
      }
    });
  });
  app.use("/api", (_req, res) => {
    res
      .set("Cache-Control", "no-store")
      .status(404)
      .json({ error: "API endpoint not found." });
  });

  const isDevelopment =
    process.env.NODE_ENV === "development" || process.argv.includes("--dev");

  if (isDevelopment) {
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

  const port = Number(process.env.PORT || "3000");
  const host = process.env.HOST?.trim() || "127.0.0.1";
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Invalid PORT");
  }

  server.on("error", error => {
    console.error(
      "Server failed:",
      error instanceof Error ? error.message : error
    );
    process.exit(1);
  });
  server.listen(port, host, () => {
    console.log(`Metis Lite listening on ${host}:${port}`);
  });
}

startServer().catch(error => {
  console.error(
    "Could not start Metis Lite:",
    error instanceof Error ? error.message : error
  );
  process.exit(1);
});
