import express, { type Express } from "express";
import fs from "node:fs";
import type { Server } from "node:http";
import path from "node:path";
import { createServer as createViteServer } from "vite";
import viteConfig from "../vite.config";

export async function setupVite(app: Express, server: Server) {
  const vite = await createViteServer({
    ...viteConfig,
    configFile: false,
    server: {
      ...(viteConfig.server ?? {}),
      middlewareMode: true,
      hmr: { server },
    },
    appType: "custom",
  });

  app.use(vite.middlewares);
  app.use("*", async (req, res, next) => {
    try {
      const template = await fs.promises.readFile(
        path.resolve(import.meta.dirname, "../client/index.html"),
        "utf-8"
      );
      const page = await vite.transformIndexHtml(req.originalUrl, template);
      res.status(200).set("Content-Type", "text/html").end(page);
    } catch (error) {
      vite.ssrFixStacktrace(error as Error);
      next(error);
    }
  });
}

export function serveStatic(app: Express) {
  const distPath = path.resolve(import.meta.dirname, "../dist/public");
  if (!fs.existsSync(distPath)) {
    throw new Error(`Could not find the production build at ${distPath}. Run pnpm build first.`);
  }

  app.use(express.static(distPath, { index: "index.html" }));
  app.use("*", (_req, res) => {
    res.sendFile(path.join(distPath, "index.html"));
  });
}
