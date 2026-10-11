import { loadConfig } from "./config.js";
import { createApp } from "./http.js";
import { CLIProxyClient } from "./proxy-client.js";
import { SessionService } from "./session-service.js";
import { MemorySessionStore } from "./session-store.js";

function main() {
	const config = loadConfig();
	const client = new CLIProxyClient(
		config.proxyBaseUrl,
		config.proxyApiKey,
		config.maxTokens,
		config.timeoutMs,
	);
	const sessions = new SessionService(
		new MemorySessionStore(),
		client,
		config.defaultModel,
	);
	const server = createApp(config, sessions).listen(
		config.port,
		config.host,
		() => {
			process.stdout.write("model-agent-mcp ready\n");
		},
	);

	server.requestTimeout = 10000;
	server.headersTimeout = 5000;
	server.maxRequestsPerSocket = 60;
	server.maxConnections = 32;
	server.keepAliveTimeout = 5000;
	server.on("error", () => {
		process.stderr.write("startup_rejected\n");
		process.exitCode = 1;
	});
}
try {
	main();
} catch {
	process.stderr.write("startup_rejected\n");
	process.exitCode = 1;
}
