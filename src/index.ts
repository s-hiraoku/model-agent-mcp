import { loadConfig } from "./config.js";
import { createApp } from "./http.js";
import { CLIProxyClient } from "./proxy-client.js";
import { SessionService } from "./session-service.js";
import { MemorySessionStore } from "./session-store.js";

const config = loadConfig();
const client = new CLIProxyClient(config.proxyBaseUrl, config.proxyApiKey, config.maxTokens, config.timeoutMs);
const sessions = new SessionService(new MemorySessionStore(), client, config.defaultModel);
createApp(config, sessions).listen(config.port, config.host, () => {
  process.stdout.write(`model-agent-mcp listening on ${config.host}:${config.port}\n`);
});
