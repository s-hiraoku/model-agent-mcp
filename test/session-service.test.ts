import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChatMessage, ModelClient } from "../src/proxy-client.js";
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
  const service = new SessionService(new MemorySessionStore(), client, "claude-test");
  assert.deepEqual(await service.listModels(), { default_model: "claude-test", models: ["claude-test", "gpt-test"] });

  const first = await service.start("Implement X", "src/a.ts exists");
  assert.equal(first.status, "ready");
  assert.equal(first.response, "reply-1");
  assert.match(calls[0]!.messages[0]!.content, /src\/a\.ts exists/);

  await service.setModel(first.session_id, "gpt-test");
  const second = await service.continue(first.session_id, "Revise X");
  assert.equal(second.model, "gpt-test");
  assert.equal(second.response, "reply-2");
  assert.deepEqual(calls[1]!.messages.slice(1).map((item) => [item.role, item.content]), [
    ["user", "Implement X"], ["assistant", "reply-1"], ["user", "Revise X"],
  ]);
  const metadata = await service.get(first.session_id) as { turn_count: number; model: string };
  assert.equal(metadata.turn_count, 2);
  assert.equal(metadata.model, "gpt-test");
});

test("cancel aborts an in-flight continuation and closes the session", async () => {
  let started!: () => void;
  const entered = new Promise<void>((resolve) => { started = resolve; });
  const client: ModelClient = {
    listModels: async () => [],
    complete: async (_model, messages, signal) => {
      if (messages.at(-1)?.content === "first") return "ok";
      started();
      return new Promise<string>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      });
    },
  };
  const service = new SessionService(new MemorySessionStore(), client, "claude-test");
  const first = await service.start("first");
  const pending = service.continue(first.session_id, "second");
  await entered;
  await assert.rejects(service.continue(first.session_id, "third"), SessionError);
  assert.deepEqual(await service.cancel(first.session_id), { session_id: first.session_id, status: "cancelled" });
  assert.equal((await pending).status, "cancelled");
  await assert.rejects(service.continue(first.session_id, "again"), /cancelled/);
});

test("failed upstream call leaves history intact for retry", async () => {
  let attempts = 0;
  const service = new SessionService(new MemorySessionStore(), {
    listModels: async () => [],
    complete: async () => { if (++attempts === 1) throw new Error("upstream down"); return "recovered"; },
  }, "claude-test");
  const first = await service.start("first");
  assert.equal(first.status, "error");
  assert.equal(first.error, "upstream down");
  const retry = await service.continue(first.session_id, "retry");
  assert.equal(retry.response, "recovered");
  assert.equal((await service.get(first.session_id) as { turn_count: number }).turn_count, 1);
});
