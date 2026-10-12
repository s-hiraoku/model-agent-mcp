import { randomUUID } from "node:crypto";
import express from "express";
import {
	protocolAdmission,
	boundedResponse,
	exchangeResponse,
} from "./protocol.js";
import { createMcpHandler } from "@modelcontextprotocol/server";
import type { Config } from "./config.js";
import { createVerifier, loadAuthConfig, type Verify } from "./auth.js";
import type { Audit } from "./audit.js";
import { AsyncAudit } from "./async-audit.js";
import { createMcpServer } from "./mcp.js";
import type { SessionService } from "./session-service.js";

export function createApp(
	config: Config,
	sessions: SessionService,
	dependencies: { verify?: Verify; audit?: Audit; allowedHost?: string } = {},
) {
	const app = express();
	app.disable("x-powered-by");
	const auth = config.authConfigPath
		? loadAuthConfig(config.authConfigPath)
		: undefined;
	const verify =
		dependencies.verify ?? (auth ? createVerifier(auth) : async () => null);
	const audit =
		dependencies.audit ??
		new AsyncAudit(config.auditDirectory ?? "runtime/audit");
	let window = 0,
		calls = 0,
		active = 0;
	if (auth)
		app.get("/.well-known/oauth-protected-resource/mcp", (_req, res) => {
			res.setHeader("Cache-Control", "no-store");
			res.json({
				resource: auth.resource,
				authorization_servers: [auth.issuer],
				scopes_supported: [
					"model:list",
					"model:start",
					"model:continue",
					"model:set",
					"model:get",
					"model:cancel",
				],
			});
		});
	app.locals.audit = audit;
	app.get("/healthz", (_req, res) => {
		try {
			audit.check?.();
			res.json({ status: "ok" });
		} catch {
			res.status(503).json({ status: "unavailable" });
		}
	});
	app.use("/mcp", async (req, res, next) => {
		const correlation = randomUUID();
		res.locals.correlation = correlation;
		res.setHeader("X-Request-ID", correlation);
		try {
			audit.check?.();
			const now = Date.now();
			if (now - window > 60000) {
				window = now;
				calls = 0;
			}
			calls = Math.min(121, calls + 1);
			if (calls > 120 || active >= 4) {
				audit.note?.("rate_limited");
				res.status(429).json({ error: "Request rejected" });
				return;
			}
			active++;
			let released = false;
			const release = () => {
				if (!released) {
					released = true;
					active--;
				}
			};
			res.once("finish", release);
			res.once("close", release);
			await audit.record("request", correlation);
			const allowedHost =
				dependencies.allowedHost ??
				(auth ? new URL(auth.resource).host : `${config.host}:${config.port}`);
			if (
				req.headers.host !== allowedHost ||
				(req.headers.origin &&
					req.headers.origin !==
						(auth ? new URL(auth.resource).origin : `http://${allowedHost}`)) ||
				["host", "origin", "authorization"].some(
					(name) =>
						req.rawHeaders.filter(
							(h, i) => i % 2 === 0 && h.toLowerCase() === name,
						).length > 1,
				) ||
				(req.headers["content-length"] &&
					Number(req.headers["content-length"]) > 32768)
			) {
				await audit.record("resource_rejected", correlation);
				res.status(400).json({ error: "Request rejected" });
				return;
			}
			const principal = await verify(req.headers.authorization);
			if (!principal) {
				await audit.record("auth_denied", correlation);
				res.setHeader(
					"WWW-Authenticate",
					auth
						? `Bearer resource_metadata="${new URL("/.well-known/oauth-protected-resource/mcp", auth.resource).href}"`
						: "Bearer",
				);
				res.status(401).json({ error: "Unauthorized" });
				return;
			}
			if (req.originalUrl !== "/mcp" || req.method !== "POST") {
				await audit.record("resource_rejected", correlation);
				res.status(405).json({ error: "Request rejected" });
				return;
			}
			res.locals.principal = principal;
			next();
		} catch {
			res.status(503).json({ error: "Service unavailable" });
		}
	});
	app.use("/mcp", express.json({ limit: 32768 }));
	app.all("/mcp", async (req, res) => {
		let handler: ReturnType<typeof createMcpHandler> | undefined;
		try {
			if (
				!(await protocolAdmission(
					req.body,
					typeof req.headers["mcp-method"] === "string"
						? req.headers["mcp-method"]
						: undefined,
					audit,
					res.locals.correlation,
				))
			) {
				res.status(405).json({ error: "Request rejected" });
				return;
			}
			handler = createMcpHandler(() =>
				createMcpServer(
					sessions,
					res.locals.principal,
					audit,
					res.locals.correlation,
				),
			);
			const headers = new Headers();
			for (const key of [
				"accept",
				"content-type",
				"mcp-method",
				"mcp-name",
				"mcp-protocol-version",
			]) {
				const value = req.headers[key];
				if (typeof value === "string") headers.set(key, value);
			}
			const response = await exchangeResponse(
				handler.fetch(
					new Request("http://mcp.internal/mcp", {
						method: "POST",
						headers,
						body: JSON.stringify(req.body),
					}),
				),
			);
			if (response.status >= 400)
				await audit.record("transport_error", res.locals.correlation);
			const body = await boundedResponse(response);
			res.status(response.status);
			for (const [name, value] of response.headers) res.setHeader(name, value);
			res.setTimeout(5000, () => res.destroy());
			res.end(Buffer.from(body));
		} catch {
			try {
				await audit.record("transport_error", res.locals.correlation);
			} catch {
				/* No unsafe fallback logging. */
			}
			if (!res.headersSent)
				res.status(500).json({ error: "MCP transport error" });
		} finally {
			void handler?.close().catch(() => {});
		}
	});
	app.use(
		async (
			_error: unknown,
			_req: express.Request,
			res: express.Response,
			_next: express.NextFunction,
		) => {
			try {
				await audit.record("transport_error", res.locals.correlation);
			} catch {
				/* Admission remains closed. */
			}
			res.status(413).json({ error: "Request rejected" });
		},
	);
	return app;
}
