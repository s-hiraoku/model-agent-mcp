import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AsyncAudit, type AuditPort } from "../src/async-audit.js";
const correlation = "11111111-1111-4111-8111-111111111111";
class Port extends EventEmitter {
	readonly messages: { id: number; event: Record<string, unknown> }[] = [];
	terminated = false;
	postMessage(message: unknown) {
		this.messages.push(message as (typeof this.messages)[number]);
	}
	async terminate() {
		this.terminated = true;
		return 0;
	}
}
test("queue is bounded, flooding uses only saturated fixed counters, summaries respect cooldown", async () => {
	const port = new Port();
	const audit = new AsyncAudit("unused", {
		port: port as AuditPort,
		maxPending: 2,
	});
	port.emit("message", { kind: "ready" });
	await audit.ready();
	try {
		const first = audit.record("request", correlation),
			second = audit.record("tool_started", correlation);
		await assert.rejects(audit.record("tool_started", correlation));
		assert.equal(audit.snapshot().pending, 2);
		assert.equal(port.messages.length, 2);
		for (let i = 0; i < 100000; i++) audit.note("rate_limited");
		assert.equal(port.messages.length, 2);
		assert.equal(audit.snapshot().dropped, 65535);
		assert.equal(audit.snapshot().saturated, true);
		assert.equal(Object.keys(audit.snapshot().counts).length, 2);
		for (const message of port.messages)
			port.emit("message", { kind: "ack", id: message.id });
		await Promise.all([first, second]);
		const summary = audit.flush(10000);
		assert.equal(port.messages.length, 3);
		port.emit("message", { kind: "ack", id: port.messages[2]?.id });
		await summary;
		audit.note("rate_limited");
		await audit.flush(19999);
		assert.equal(port.messages.length, 3);
		const next = audit.flush(20000);
		port.emit("message", { kind: "ack", id: port.messages[3]?.id });
		await next;
		assert.equal(port.messages.length, 4);
	} finally {
		await audit.close();
	}
});
test("writer failure/deadline is sticky fail-closed without retries or token/path errors", async () => {
	for (const mode of ["failure", "deadline"]) {
		const port = new Port();
		const audit = new AsyncAudit("unused", {
			port: port as AuditPort,
			timeoutMs: 5,
		});
		port.emit("message", { kind: "ready" });
		await audit.ready();
		const pending = audit.record("tool_started", correlation);
		if (mode === "failure")
			port.emit("message", { kind: "failed", error: "SECRET" });
		await assert.rejects(pending, /^Error: Audit unavailable$/);
		assert.throws(() => audit.check(), /^Error: Audit unavailable$/);
		for (let i = 0; i < 100; i++)
			await assert.rejects(audit.record("request", correlation));
		assert.equal(port.messages.length, 1);
		assert.equal(audit.snapshot().pending, 0);
		assert.equal(port.terminated, true);
		await audit.close();
	}
});
test("isolated filesystem worker acknowledges safe detail and aggregate writes", async () => {
	const dir = mkdtempSync(join(tmpdir(), "async-audit-"));
	const audit = new AsyncAudit(dir);
	try {
		await audit.ready();
		await audit.record("tool_started", correlation);
		for (let i = 0; i < 20; i++) audit.note("rate_limited");
		await audit.flush();
		const lines = readFileSync(join(dir, "audit.jsonl"), "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		assert(
			lines.some(
				(line) =>
					line.category === "aggregate" &&
					line.summary.dropped === 20 &&
					line.summary.anomaly === true,
			),
		);
		assert(
			lines.every((line) =>
				Object.keys(line).every((key) =>
					["time", "category", "correlation", "summary"].includes(key),
				),
			),
		);
	} finally {
		await audit.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
test("uncertain summary counts remain bounded in memory after writer failure", async () => {
	const port = new Port(),
		audit = new AsyncAudit("unused", { port: port as AuditPort });
	port.emit("message", { kind: "ready" });
	await audit.ready();
	audit.note("rate_limited");
	const flushing = audit.flush(10000);
	audit.note("auth_denied");
	port.emit("message", { kind: "failed" });
	await assert.rejects(flushing);
	assert.equal(audit.snapshot().dropped, 2);
	assert.deepEqual(audit.snapshot().counts, {
		auth_denied: 1,
		rate_limited: 1,
	});
	assert.equal(port.messages.length, 1);
	await audit.close();
	assert.throws(
		() =>
			new AsyncAudit("unused", {
				port: port as AuditPort,
				flushMs: Number.NaN,
			}),
	);
	assert.throws(
		() =>
			new AsyncAudit("unused", {
				port: port as AuditPort,
				timeoutMs: Number.POSITIVE_INFINITY,
			}),
	);
});
test("worker excludes parent environment and environment-file flags", async () => {
	const { spawnSync } = await import("node:child_process");
	const { writeFileSync } = await import("node:fs");
	const dir = mkdtempSync(join(tmpdir(), "audit-env-"));
	try {
		const file = join(dir, "fixture.env");
		writeFileSync(file, "AUDIT_TEST_SENTINEL=DUMMY\n", { mode: 0o600 });
		const result = spawnSync(
			process.execPath,
			[
				`--env-file=${file}`,
				"--import",
				"tsx",
				"--input-type=module",
				"-e",
				`import { AsyncAudit } from './src/async-audit.ts'; const audit = new AsyncAudit(${JSON.stringify(join(dir, "logs"))}); await audit.ready(); await audit.close(); process.stdout.write('audit_ready');`,
			],
			{ env: {}, encoding: "utf8" },
		);
		assert.equal(result.status, 0);
		assert.equal(result.stdout, "audit_ready");
		assert.equal(result.stderr, "");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
