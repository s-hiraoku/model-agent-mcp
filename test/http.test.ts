import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Config } from "../src/config.js";
import { createApp } from "../src/http.js";
import { SessionService } from "../src/session-service.js";
import { MemorySessionStore } from "../src/session-store.js";

test("MCP rejects unauthenticated calls and exposes model tools", async () => {
  const config: Config = {
    host: "127.0.0.1", port: 0, mcpBearerToken: "test-token", proxyBaseUrl: "http://proxy",
    proxyApiKey: "proxy-token", defaultModel: "claude-test", maxTokens: 100, timeoutMs: 1000,
  };
  const sessions = new SessionService(new MemorySessionStore(), {
    listModels: async () => ["claude-test", "gpt-test"],
    complete: async (model) => `hello from ${model}`,
  }, config.defaultModel);
  const server = createApp(config, sessions).listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing port");
  const url = new URL(`http://127.0.0.1:${address.port}/mcp`);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  try {
    const unauthorized = await fetch(url, { method: "POST", body: "{}" });
    assert.equal(unauthorized.status, 401);
    const transport = new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { Authorization: "Bearer test-token" } },
    });
    await client.connect(transport);
    const tools = await client.listTools();
    assert(tools.tools.some((tool) => tool.name === "agent_set_session_model"));
    const started = await client.callTool({ name: "agent_start_task", arguments: { task: "implement", model: "gpt-test" } });
    assert.equal(started.isError, undefined);
    assert(Array.isArray(started.content));
    const body = JSON.parse((started.content[0] as { text: string }).text);
    assert.equal(body.response, "hello from gpt-test");
    const listed = await client.callTool({ name: "agent_list_models", arguments: {} });
    assert(Array.isArray(listed.content));
    assert.deepEqual(JSON.parse((listed.content[0] as { text: string }).text).models, ["claude-test", "gpt-test"]);
  } finally {
    await client.close();
    server.close();
    await once(server, "close");
  }
});
