import assert from "node:assert/strict";
import { test } from "node:test";
import { CLIProxyClient, ProxyError } from "../src/proxy-client.js";

test("uses CLIProxyAPI bearer auth and OpenAI-compatible routes", async () => {
  const requests: { url: string; init: RequestInit }[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    requests.push({ url: String(input), init: init! });
    if (String(input).endsWith("/v1/models")) {
      return Response.json({ data: [{ id: "gpt-test" }, { id: "claude-test" }] });
    }
    return Response.json({ choices: [{ message: { content: "patch" } }] });
  };
  const client = new CLIProxyClient("http://proxy:8317", "secret", 100, 1000, fetcher);
  assert.deepEqual(await client.listModels(), ["claude-test", "gpt-test"]);
  assert.equal(await client.complete("gpt-test", [{ role: "user", content: "task" }], new AbortController().signal), "patch");
  assert.equal(requests[0]!.url, "http://proxy:8317/v1/models");
  assert.equal(new Headers(requests[1]!.init.headers).get("Authorization"), "Bearer secret");
  assert.deepEqual(JSON.parse(String(requests[1]!.init.body)), {
    model: "gpt-test", messages: [{ role: "user", content: "task" }], max_tokens: 100, stream: false,
  });
});

test("returns a safe HTTP error without upstream body or credentials", async () => {
  const client = new CLIProxyClient("http://proxy:8317", "secret", 100, 1000, async () =>
    new Response("secret sensitive body", { status: 401 }));
  await assert.rejects(client.listModels(), (error: unknown) =>
    error instanceof ProxyError && error.status === 401 && !error.message.includes("secret"));
});
