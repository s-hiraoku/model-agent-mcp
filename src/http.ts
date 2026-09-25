import { timingSafeEqual } from "node:crypto";
import express from "express";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler } from "@modelcontextprotocol/server";
import type { Config } from "./config.js";
import { createMcpServer } from "./mcp.js";
import type { SessionService } from "./session-service.js";

function authorized(header: string | undefined, token: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(header.slice(7));
  const expected = Buffer.from(token);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

export function createApp(config: Config, sessions: SessionService) {
  const app = express();
  const handler = createMcpHandler(() => createMcpServer(sessions));
  const nodeHandler = toNodeHandler(handler);
  app.get("/healthz", (_req, res) => { res.json({ status: "ok" }); });
  app.use("/mcp", (req, res, next) => {
    if (!authorized(req.headers.authorization, config.mcpBearerToken)) {
      res.setHeader("WWW-Authenticate", "Bearer");
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    next();
  });
  app.use("/mcp", express.json({ limit: "1mb" }));
  app.all("/mcp", async (req, res) => {
    try {
      await nodeHandler(req, res, req.body);
    } catch {
      if (!res.headersSent) res.status(500).json({ error: "MCP transport error" });
    }
  });
  return app;
}
