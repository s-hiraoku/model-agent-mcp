import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import {
	McpServer,
	createMcpHandler,
	PROTOCOL_VERSION_META_KEY,
	CLIENT_CAPABILITIES_META_KEY,
} from "@modelcontextprotocol/server";
import { z } from "zod";
import { createApp } from "../src/http.js";
import { MemoryAudit } from "../src/audit.js";
import { boundedResponse } from "../src/protocol.js";
import { SessionService } from "../src/session-service.js";
import { MemorySessionStore } from "../src/session-store.js";
import { SCOPES } from "../src/principal.js";
const principal = {
	issuer: "https://example.auth0.com/",
	subject: "fixture",
	clientId: "fixture",
	scopes: SCOPES,
};
const listenBody = {
	jsonrpc: "2.0",
	id: 1,
	method: "subscriptions/listen",
	params: {
		notifications: { toolsListChanged: true },
		_meta: {
			[PROTOCOL_VERSION_META_KEY]: "2026-07-28",
			[CLIENT_CAPABILITIES_META_KEY]: {},
		},
	},
};
const listenHeaders = {
	"Mcp-Method": "subscriptions/listen",
	"MCP-Protocol-Version": "2026-07-28",
	"Content-Type": "application/json",
	Accept: "text/event-stream",
	Authorization: "Bearer DUMMY",
};
async function fixture(
	audit: { record: MemoryAudit["record"]; note?: MemoryAudit["note"] },
	authorized = true,
) {
	const deps = {
		audit,
		verify: async () => (authorized ? principal : null),
		allowedHost: "",
	};
	const service = new SessionService(
		new MemorySessionStore(),
		{ listModels: async () => [], complete: async () => "fixed" },
		"fixture",
	);
	const app = createApp(
		{
			host: "127.0.0.1",
			port: 0,
			proxyBaseUrl: "http://proxy",
			proxyApiKey: "DUMMY",
			defaultModel: "fixture",
			maxTokens: 100,
			timeoutMs: 1000,
		},
		service,
		deps,
	);
	const server = app.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	assert(address && typeof address !== "string");
	deps.allowedHost = `127.0.0.1:${address.port}`;
	return { server, url: `http://${deps.allowedHost}/mcp` };
}
test("installed SDK can serve a long-lived listener; protected ingress refuses four listeners", async () => {
	const raw = createMcpHandler(() => {
		const server = new McpServer({ name: "fixture", version: "1" });
		server.registerTool("fixture", { inputSchema: z.strictObject({}) }, () => ({
			content: [{ type: "text", text: "fixed" }],
		}));
		return server;
	});
	const baseline = await raw.fetch(
		new Request("https://fixture.example/mcp", {
			method: "POST",
			headers: listenHeaders,
			body: JSON.stringify(listenBody),
		}),
	);
	assert.equal(baseline.status, 200);
	assert.match(
		baseline.headers.get("content-type") ?? "",
		/text\/event-stream/,
	);
	const reader = baseline.body?.getReader();
	assert(reader);
	assert.equal(
		await Promise.race([
			reader.closed.then(() => true),
			new Promise((resolve) => setTimeout(() => resolve(false), 10)),
		]),
		false,
	);
	await reader.cancel();
	await raw.close();
	const audit = new MemoryAudit();
	const { server, url } = await fixture(audit);
	try {
		for (let i = 0; i < 4; i++) {
			const response = await fetch(url, {
				method: "POST",
				headers: listenHeaders,
				body: JSON.stringify(listenBody),
			});
			assert.equal(response.status, 405);
			await response.text();
		}
		const response = await fetch(url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json, text/event-stream",
				Authorization: "Bearer DUMMY",
			},
			body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
		});
		assert.equal(response.status, 200);
		await response.text();
		assert.equal(audit.counts.get("resource_rejected"), 4);
	} finally {
		server.close();
		await once(server, "close");
	}
});
test("SDK pre-callback UUID/unknown-tool errors and malformed JSON have fixed audit classifications", async () => {
	const audit = new MemoryAudit();
	const { server, url } = await fixture(audit);
	const headers = {
		"Content-Type": "application/json",
		Accept: "application/json, text/event-stream",
		Authorization: "Bearer DUMMY",
	};
	try {
		for (const [name, args] of [
			["agent_get_session", { session_id: "PRIVATE malformed UUID" }],
			["unknown_PRIVATE", {}],
		] as const) {
			const response = await fetch(url, {
				method: "POST",
				headers,
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: 1,
					method: "tools/call",
					params: { name, arguments: args },
				}),
			});
			assert.equal(response.status, 200);
			assert.match(await response.text(), /isError|"error"/);
		}
		const malformed = await fetch(url, {
			method: "POST",
			headers,
			body: "{PRIVATE",
		});
		assert(malformed.status >= 400);
		assert(!(await malformed.text()).includes("PRIVATE"));
		assert.equal(audit.counts.get("tool_error"), 2);
		assert.equal(audit.counts.get("tool_started"), undefined);
		assert.equal(audit.counts.get("transport_error"), 1);
	} finally {
		server.close();
		await once(server, "close");
	}
});
test("unauthenticated flood detail writes stop at admission ceiling; rejected events only aggregate", async () => {
	let writes = 0,
		dropped = 0;
	const { server, url } = await fixture(
		{
			record() {
				writes++;
			},
			note() {
				dropped++;
			},
		},
		false,
	);
	try {
		for (let i = 0; i < 500; i++) {
			const response = await fetch(url, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: "{}",
			});
			assert.equal(response.status, i < 120 ? 401 : 429);
			await response.text();
		}
		assert.equal(writes, 240);
		assert.equal(dropped, 380);
	} finally {
		server.close();
		await once(server, "close");
	}
});
test("response bytes and absolute wait deadline reject oversized or stalled streams", async () => {
	await assert.rejects(
		boundedResponse(new Response("x".repeat(65537)), 20),
		/rejected/,
	);
	await assert.rejects(
		boundedResponse(new Response(new ReadableStream()), 5),
		/rejected/,
	);
});
test("SDK version/envelope/header failures and preflight media-type rejection are safely audited", async () => {
	const audit = new MemoryAudit(),
		{ server, url } = await fixture(audit);
	const headers = {
		"Content-Type": "application/json",
		Accept: "application/json, text/event-stream",
		Authorization: "Bearer DUMMY",
	};
	const body = { jsonrpc: "2.0", id: 1, method: "tools/list" };
	try {
		for (const value of [
			{ headers: { ...headers, "Content-Type": "text/plain" }, body },
			{
				headers: {
					...headers,
					"MCP-Protocol-Version": "PRIVATE-invalid-version",
				},
				body,
			},
			{ headers, body: { ...body, jsonrpc: "PRIVATE-invalid-envelope" } },
			{ headers: { ...headers, Accept: "text/plain" }, body },
		]) {
			const response = await fetch(url, {
				method: "POST",
				headers: value.headers,
				body: JSON.stringify(value.body),
			});
			assert(response.status >= 400);
			await response.text();
		}
		assert.equal(audit.counts.get("transport_error"), 4);
		assert.equal(audit.counts.get("tool_started"), undefined);
	} finally {
		server.close();
		await once(server, "close");
	}
});
