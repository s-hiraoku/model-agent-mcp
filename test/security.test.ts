import assert from "node:assert/strict";
import { test } from "node:test";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import {
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createVerifier, type AuthConfig } from "../src/auth.js";
import { LocalAudit, MemoryAudit } from "../src/audit.js";
import { SCOPES, type Principal } from "../src/principal.js";
import { SessionService } from "../src/session-service.js";
import { MemorySessionStore } from "../src/session-store.js";
import { createMcpServer } from "../src/mcp.js";
import { createMcpHandler } from "@modelcontextprotocol/server";
const principal: Principal = {
	issuer: "https://example.auth0.com/",
	subject: "user",
	clientId: "client",
	scopes: SCOPES,
};
const config: AuthConfig = {
	issuer: principal.issuer,
	audience: "urn:example:model-agent",
	resource: "https://model.example/mcp",
	clients: [{ id: "client", subjects: ["user"], scopes: [...SCOPES] }],
};
test("verified Auth0 issuer/audience/time/client/subject/scope with pinned keys and no redirects", async () => {
	const { publicKey, privateKey } = await generateKeyPair("RS256", {
		modulusLength: 2048,
	});
	const jwk = {
		...(await exportJWK(publicKey)),
		kid: "key",
		use: "sig",
		alg: "RS256",
	};
	let calls = 0;
	const verify = createVerifier(config, async (url, init) => {
		assert.equal(
			String(url),
			"https://example.auth0.com/.well-known/jwks.json",
		);
		assert.equal(init?.redirect, "error");
		calls++;
		return Response.json({ keys: [jwk] });
	});
	const now = Math.floor(Date.now() / 1000);
	const token = (overrides: object = {}, alg = "RS256") =>
		new SignJWT({
			sub: "user",
			azp: "client",
			scope: "model:get",
			...overrides,
		})
			.setProtectedHeader({ alg, kid: "key" })
			.setIssuer(config.issuer)
			.setAudience(config.audience)
			.setIssuedAt(now)
			.setExpirationTime(now + 300)
			.sign(privateKey);
	assert.equal((await verify(`Bearer ${await token()}`))?.clientId, "client");
	for (const claims of [
		{ iss: "https://other.auth0.com/" },
		{ aud: "urn:hub" },
		{ exp: now - 1 },
		{ iat: now + 10 },
		{ exp: now + 601 },
		{ azp: "other" },
		{ sub: "other" },
		{ scope: "hub:get" },
		{ scope: "model:get model:unknown" },
		{ client_id: "other" },
		{ act: { sub: "user" } },
	]) {
		// setIssuer/setAudience etc must not overwrite negative claims.
		const signed = await new SignJWT({
			iss: config.issuer,
			aud: config.audience,
			sub: "user",
			azp: "client",
			scope: "model:get",
			iat: now,
			exp: now + 300,
			...claims,
		})
			.setProtectedHeader({ alg: "RS256", kid: "key" })
			.sign(privateKey);
		assert.equal(await verify(`Bearer ${signed}`), null);
	}
	assert.equal(await verify("Bearer legacy-secret"), null);
	assert.equal(calls, 1);
});
test("all session operations isolate same-sub different-client and missing scopes; admin is explicit", async () => {
	const service = new SessionService(
		new MemorySessionStore(),
		{ listModels: async () => [], complete: async () => "ok" },
		"test",
	);
	const session = await service.start(principal, "hello");
	const other = { ...principal, clientId: "other" };
	for (const operation of [
		() => service.get(other, session.session_id),
		() => service.continue(other, session.session_id, "hi"),
		() => service.setModel(other, session.session_id, "other"),
		() => service.cancel(other, session.session_id),
	])
		await assert.rejects(operation, /rejected/);
	const ordinary = { ...principal, scopes: ["model:get"] as const };
	await assert.rejects(service.setDefaultModel(ordinary, "other"), /rejected/);
	await assert.rejects(service.start(ordinary, "hello"), /rejected/);
	await service.setDefaultModel(principal, "approved");
	assert.equal((await service.listModels(principal)).default_model, "approved");
});
test("concurrency, call, history, session, TTL and response bounds fail before extra upstream work", async () => {
	let finish!: (value: string) => void;
	let calls = 0;
	const service = new SessionService(
		new MemorySessionStore(),
		{
			listModels: async () => [],
			complete: () => {
				calls++;
				return new Promise((r) => {
					finish = r;
				});
			},
		},
		"test",
		{ maxCalls: 2 },
	);
	const running = service.start(principal, "hello");
	await new Promise((r) => setImmediate(r));
	await assert.rejects(service.start(principal, "second"), /limit/);
	await assert.rejects(service.listModels(principal), /limit/);
	assert.equal(calls, 1);
	finish("ok");
	await running;
	const oversized = new SessionService(
		new MemorySessionStore(),
		{ listModels: async () => [], complete: async () => "x".repeat(16385) },
		"test",
		{ maxTurns: 1 },
	);
	assert.equal((await oversized.start(principal, "hi")).status, "error");
	await assert.rejects(oversized.start(principal, "é".repeat(8192)), /limit/);
	const once = new SessionService(
		new MemorySessionStore(1),
		{ listModels: async () => [], complete: async () => "ok" },
		"test",
		{ maxTurns: 1 },
	);
	const first = await once.start(principal, "hi");
	await assert.rejects(
		once.continue(principal, first.session_id, "again"),
		/limit/,
	);
	await assert.rejects(once.start(principal, "another"), /limit/);
	let now = Date.now();
	const store = new MemorySessionStore(1, 5, () => now);
	const ttl = new SessionService(
		store,
		{ listModels: async () => [], complete: async () => "ok" },
		"test",
	);
	const old = await ttl.start(principal, "hi");
	now += 100;
	await assert.rejects(ttl.get(principal, old.session_id), /rejected/);
});
test("audit projects fixed categories, rotates bounded files, rejects symlinks and write failures", () => {
	const dir = mkdtempSync(join(tmpdir(), "model-audit-"));
	const id = "11111111-1111-4111-8111-111111111111";
	try {
		const audit = new LocalAudit(dir, 256);
		for (let i = 0; i < 40; i++) audit.record("tool_error", id);
		assert(readdirSync(dir).length <= 3);
		for (const name of readdirSync(dir))
			for (const line of readFileSync(join(dir, name), "utf8")
				.trim()
				.split("\n"))
				assert.deepEqual(Object.keys(JSON.parse(line)), [
					"time",
					"category",
					"correlation",
				]);
		assert.throws(() => audit.record("secret" as never, id));
		assert.throws(() => audit.record("request", "raw-session-id"));
		assert.throws(
			() =>
				new LocalAudit(dir, 256, Date.now, () => {
					throw new Error("SECRET");
				}),
			/^Error: Audit unavailable$/,
		);
		const link = join(dir, "link");
		symlinkSync(dir, link);
		assert.throws(() => new LocalAudit(link));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
test("HTTP-200 MCP upstream failure is audited as tool_error and hides exception text", async () => {
	const audit = new MemoryAudit();
	const service = new SessionService(
		new MemorySessionStore(),
		{
			listModels: async () => [],
			complete: async () => {
				throw new Error("SECRET exception");
			},
		},
		"test",
	);
	const handler = createMcpHandler(() =>
		createMcpServer(
			service,
			principal,
			audit,
			"11111111-1111-4111-8111-111111111111",
		),
	);
	const response = await handler.fetch(
		new Request("https://model.example/mcp", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json, text/event-stream",
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: {
					name: "agent_start_task",
					arguments: { task: "SECRET input" },
				},
			}),
		}),
	);
	assert.equal(response.status, 200);
	const body = await response.text();
	assert.match(body, /isError/);
	assert(!body.includes("SECRET"));
	assert.equal(audit.counts.get("tool_error"), 1);
});
test("hung provider reaches deadline and retains uncertain concurrency slot", async () => {
	const service = new SessionService(
		new MemorySessionStore(),
		{
			listModels: () => new Promise(() => {}),
			complete: () => new Promise(() => {}),
		},
		"test",
		{ timeoutMs: 5 },
	);
	const outcome = await service.start(principal, "hello");
	assert.equal(outcome.status, "unknown");
	await assert.rejects(service.start(principal, "second"), /limit/);
	const listing = new SessionService(
		new MemorySessionStore(),
		{ listModels: () => new Promise(() => {}), complete: async () => "ok" },
		"test",
		{ timeoutMs: 5 },
	);
	await assert.rejects(listing.listModels(principal), /Deadline/);
	await assert.rejects(listing.start(principal, "hello"), /limit/);
});
test("audit outage blocks model action; fallback remains disabled by default", async () => {
	let calls = 0;
	const service = new SessionService(
		new MemorySessionStore(),
		{
			listModels: async () => [],
			complete: async () => {
				calls++;
				throw new Error("PRIVATE");
			},
		},
		"missing",
	);
	const handler = createMcpHandler(() =>
		createMcpServer(
			service,
			principal,
			{
				record() {
					throw new Error("PRIVATE audit");
				},
			},
			"11111111-1111-4111-8111-111111111111",
		),
	);
	const response = await handler.fetch(
		new Request("https://model.example/mcp", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json, text/event-stream",
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: { name: "agent_start_task", arguments: { task: "hello" } },
			}),
		}),
	);
	assert.match(await response.text(), /Operation rejected/);
	assert.equal(calls, 0);
	await service.start(principal, "hello");
	assert.equal(calls, 1);
});
test("private Auth0 configuration rejects unsafe permissions, symlinks, extra fields and shared audiences", async () => {
	const { loadAuthConfig } = await import("../src/auth.js");
	const { writeFileSync, chmodSync } = await import("node:fs");
	const dir = mkdtempSync(join(tmpdir(), "model-config-"));
	const path = join(dir, "config.local.json");
	const good = { ...config, audience: config.resource };
	try {
		writeFileSync(path, JSON.stringify(good), { mode: 0o600 });
		assert.equal(loadAuthConfig(path).audience, good.resource);
		chmodSync(path, 0o644);
		assert.throws(() => loadAuthConfig(path));
		chmodSync(path, 0o600);
		const link = join(dir, "link");
		symlinkSync(path, link);
		assert.throws(() => loadAuthConfig(link));
		for (const candidate of [
			{ ...good, enabled: false },
			{ ...good, audience: "https://hub.example/mcp" },
			{ ...good, clients: [{ ...good.clients[0], token: "DUMMY" }] },
		]) {
			writeFileSync(path, JSON.stringify(candidate));
			assert.throws(() => loadAuthConfig(path));
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
test("startup configuration failure hides private paths and exception stacks", async () => {
	const { spawnSync } = await import("node:child_process");
	const result = spawnSync(
		process.execPath,
		["--import", "tsx", "src/index.ts"],
		{
			encoding: "utf8",
			env: {
				MODEL_AUTH0_CONFIG: "/tmp/nonexistent-private-model-config-fixture",
				CLIPROXY_BASE_URL: "http://proxy",
				CLIPROXY_API_KEY: "DUMMY",
				DEFAULT_MODEL: "test",
			},
		},
	);
	assert.equal(result.status, 1);
	assert.equal(result.stdout, "");
	assert.equal(result.stderr, "startup_rejected\n");
});
test("rejected busy/rate starts never reserve hidden sessions", async () => {
	let finish!: (value: string) => void;
	const store = new MemorySessionStore(2);
	let calls = 0;
	const service = new SessionService(
		store,
		{
			listModels: async () => [],
			complete: async () => {
				calls++;
				if (calls === 1)
					return new Promise((resolve) => {
						finish = resolve;
					});
				return "ok";
			},
		},
		"test",
	);
	const running = service.start(principal, "first");
	await new Promise((r) => setImmediate(r));
	for (let i = 0; i < 40; i++)
		await assert.rejects(service.start(principal, "rejected"), /limit/);
	assert.equal(store.count(), 1);
	finish("ok");
	await running;
	await service.start(principal, "accepted");
	assert.equal(store.count(), 2);
	const rateStore = new MemorySessionStore();
	const rate = new SessionService(
		rateStore,
		{ listModels: async () => [], complete: async () => "ok" },
		"test",
		{ maxCalls: 1 },
	);
	await rate.start(principal, "first");
	for (let i = 0; i < 40; i++)
		await assert.rejects(rate.start(principal, "rejected"), /limit/);
	assert.equal(rateStore.count(), 1);
});
test("idle cancel wins concurrent continuation and model changes without revival", async () => {
	for (const operation of ["continue", "setModel"]) {
		let calls = 0;
		const service = new SessionService(
			new MemorySessionStore(),
			{
				listModels: async () => [],
				complete: async () => {
					calls++;
					return "ok";
				},
			},
			"test",
		);
		const first = await service.start(principal, "first");
		const results = await Promise.allSettled([
			service.cancel(principal, first.session_id),
			operation === "continue"
				? service.continue(principal, first.session_id, "after cancel")
				: service.setModel(principal, first.session_id, "other"),
		]);
		assert.equal(results[0]?.status, "fulfilled");
		assert.equal(results[1]?.status, "rejected");
		assert.equal(
			((await service.get(principal, first.session_id)) as { status: string })
				.status,
			"cancelled",
		);
		assert.equal(calls, 1);
	}
});
test("deadline is unknown/isError/tool_error while explicit cancel succeeds", async () => {
	const audit = new MemoryAudit();
	const service = new SessionService(
		new MemorySessionStore(),
		{ listModels: async () => [], complete: () => new Promise(() => {}) },
		"test",
		{ timeoutMs: 5 },
	);
	const handler = createMcpHandler(() =>
		createMcpServer(
			service,
			principal,
			audit,
			"11111111-1111-4111-8111-111111111111",
		),
	);
	const response = await handler.fetch(
		new Request("https://model.example/mcp", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json, text/event-stream",
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: { name: "agent_start_task", arguments: { task: "hello" } },
			}),
		}),
	);
	const body = await response.text();
	assert.match(body, /unknown/);
	assert.match(body, /isError/);
	assert.equal(audit.counts.get("tool_error"), 1);
	assert.equal(audit.counts.get("tool_succeeded"), undefined);
	const other = new SessionService(
		new MemorySessionStore(),
		{ listModels: async () => [], complete: async () => "ok" },
		"test",
	);
	const session = await other.start(principal, "first");
	assert.equal(
		(await other.cancel(principal, session.session_id)).status,
		"cancelled",
	);
});
