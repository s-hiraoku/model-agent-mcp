import { SCOPES, type Principal } from "../src/principal.js";
const PRINCIPAL: Principal = {
	issuer: "https://example.auth0.com/",
	subject: "test-user",
	clientId: "test-client",
	scopes: SCOPES,
};
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	ProxyError,
	type ChatMessage,
	type ModelClient,
} from "../src/proxy-client.js";
import { SessionService, SessionError } from "../src/session-service.js";
import { MemorySessionStore } from "../src/session-store.js";

test("preserves history and switches models between turns", async () => {
	const calls: { model: string; messages: ChatMessage[] }[] = [];
	const client: ModelClient = {
		listModels: async () => ["claude-test", "gpt-test"],
		complete: async (model, messages) => {
			calls.push({ model, messages });
			return `reply-${calls.length}`;
		},
	};
	const service = new SessionService(
		new MemorySessionStore(),
		client,
		"claude-test",
	);
	assert.deepEqual(await service.listModels(PRINCIPAL), {
		default_model: "claude-test",
		models: ["claude-test", "gpt-test"],
	});

	const first = await service.start(
		PRINCIPAL,
		"Implement X",
		"src/a.ts exists",
	);
	assert.equal(first.status, "ready");
	assert.equal(first.response, "reply-1");
	const initialMessage = calls[0]?.messages[0];
	assert(initialMessage);
	assert.match(initialMessage.content, /src\/a\.ts exists/);
	assert.match(
		initialMessage.content,
		/calling MCP client owns repository inspection/,
	);

	await service.setModel(PRINCIPAL, first.session_id, "gpt-test");
	const second = await service.continue(
		PRINCIPAL,
		first.session_id,
		"Revise X",
	);
	assert.equal(second.model, "gpt-test");
	assert.equal(second.response, "reply-2");
	const continuation = calls[1];
	assert(continuation);
	assert.deepEqual(
		continuation.messages.slice(1).map((item) => [item.role, item.content]),
		[
			["user", "Implement X"],
			["assistant", "reply-1"],
			["user", "Revise X"],
		],
	);
	const metadata = (await service.get(PRINCIPAL, first.session_id)) as {
		turn_count: number;
		model: string;
	};
	assert.equal(metadata.turn_count, 2);
	assert.equal(metadata.model, "gpt-test");
});

test("updates the default only for new sessions without changing existing sessions", async () => {
	const usedModels: string[] = [];
	const service = new SessionService(
		new MemorySessionStore(),
		{
			listModels: async () => ["claude-test", "gpt-test"],
			complete: async (model) => {
				usedModels.push(model);
				return "ok";
			},
		},
		"claude-test",
	);

	const existing = await service.start(PRINCIPAL, "first");
	assert.equal(existing.model, "claude-test");
	assert.deepEqual(await service.setDefaultModel(PRINCIPAL, "gpt-test"), {
		default_model: "gpt-test",
	});
	assert.equal((await service.listModels(PRINCIPAL)).default_model, "gpt-test");
	const next = await service.start(PRINCIPAL, "second");
	assert.equal(next.model, "gpt-test");
	const explicit = await service.start(
		PRINCIPAL,
		"third",
		undefined,
		"claude-test",
	);
	assert.equal(explicit.model, "claude-test");
	assert.equal(
		(await service.continue(PRINCIPAL, existing.session_id, "follow up")).model,
		"claude-test",
	);
	assert.deepEqual(usedModels, [
		"claude-test",
		"gpt-test",
		"claude-test",
		"claude-test",
	]);
});

test("falls back once to CLIProxyAPI auto and keeps the successful session on auto", async () => {
	const usedModels: string[] = [];
	const service = new SessionService(
		new MemorySessionStore(),
		{
			listModels: async () => [],
			complete: async (model) => {
				usedModels.push(model);
				if (model === "missing")
					throw new ProxyError(
						"CLIProxyAPI returned HTTP 400",
						400,
						"model_not_found",
					);
				return "fallback response";
			},
		},
		"missing",
		{ allowFallback: true },
	);
	const first = await service.start(PRINCIPAL, "first");
	assert.deepEqual(first, {
		session_id: first.session_id,
		model: "auto",
		status: "ready",
		response: "fallback response",
		fallback_from: "missing",
	});
	assert.equal(
		((await service.get(PRINCIPAL, first.session_id)) as { turn_count: number })
			.turn_count,
		1,
	);
	const next = await service.continue(PRINCIPAL, first.session_id, "second");
	assert.equal(next.model, "auto");
	assert.deepEqual(usedModels, ["missing", "auto", "auto"]);
});

test("does not fall back on authentication errors or retry auto repeatedly", async () => {
	const usedModels: string[] = [];
	const client: ModelClient = {
		listModels: async () => [],
		complete: async (model) => {
			usedModels.push(model);
			throw new ProxyError("CLIProxyAPI returned HTTP 401", 401);
		},
	};
	const service = new SessionService(
		new MemorySessionStore(),
		client,
		"missing",
	);
	const result = await service.start(PRINCIPAL, "first");
	assert.equal(result.status, "error");
	assert.deepEqual(usedModels, ["missing"]);

	const auto = new SessionService(
		new MemorySessionStore(),
		{
			listModels: async () => [],
			complete: async (model) => {
				usedModels.push(model);
				throw new ProxyError("CLIProxyAPI returned HTTP 503", 503);
			},
		},
		"auto",
	);
	assert.equal((await auto.start(PRINCIPAL, "first")).status, "error");
	assert.deepEqual(usedModels, ["missing", "auto"]);
});

test("reports a failed fallback and leaves conversation history unchanged", async () => {
	const usedModels: string[] = [];
	const service = new SessionService(
		new MemorySessionStore(),
		{
			listModels: async () => [],
			complete: async (model) => {
				usedModels.push(model);
				throw new ProxyError(
					`CLIProxyAPI returned HTTP ${model === "auto" ? 503 : 400}`,
					model === "auto" ? 503 : 400,
					model === "auto" ? undefined : "model_not_found",
				);
			},
		},
		"missing",
		{ allowFallback: true },
	);
	const result = await service.start(PRINCIPAL, "first");
	assert.equal(result.status, "error");
	assert.equal(result.model, "missing");
	assert.equal(result.fallback_from, "missing");
	assert.equal(
		(
			(await service.get(PRINCIPAL, result.session_id)) as {
				turn_count: number;
			}
		).turn_count,
		0,
	);
	assert.deepEqual(usedModels, ["missing", "auto"]);
});

test("cancel aborts an in-flight continuation and closes the session", async () => {
	let started!: () => void;
	const entered = new Promise<void>((resolve) => {
		started = resolve;
	});
	const client: ModelClient = {
		listModels: async () => [],
		complete: async (_model, messages, signal) => {
			if (messages.at(-1)?.content === "first") return "ok";
			started();
			return new Promise<string>((_resolve, reject) => {
				signal.addEventListener(
					"abort",
					() => reject(new DOMException("Aborted", "AbortError")),
					{ once: true },
				);
			});
		},
	};
	const service = new SessionService(
		new MemorySessionStore(),
		client,
		"claude-test",
	);
	const first = await service.start(PRINCIPAL, "first");
	const pending = service.continue(PRINCIPAL, first.session_id, "second");
	await entered;
	await assert.rejects(
		service.continue(PRINCIPAL, first.session_id, "third"),
		SessionError,
	);
	assert.deepEqual(await service.cancel(PRINCIPAL, first.session_id), {
		session_id: first.session_id,
		status: "cancelled",
	});
	assert.equal((await pending).status, "cancelled");
	await assert.rejects(
		service.continue(PRINCIPAL, first.session_id, "again"),
		/cancelled/,
	);
});

test("failed upstream call leaves history intact for retry", async () => {
	let attempts = 0;
	const service = new SessionService(
		new MemorySessionStore(),
		{
			listModels: async () => [],
			complete: async () => {
				if (++attempts === 1) throw new Error("upstream down");
				return "recovered";
			},
		},
		"claude-test",
	);
	const first = await service.start(PRINCIPAL, "first");
	assert.equal(first.status, "error");
	assert.equal(first.error, "Upstream operation failed");
	const retry = await service.continue(PRINCIPAL, first.session_id, "retry");
	assert.equal(retry.response, "recovered");
	assert.equal(
		((await service.get(PRINCIPAL, first.session_id)) as { turn_count: number })
			.turn_count,
		1,
	);
});
