import { McpServer } from "@modelcontextprotocol/server";
import { toolSchemas } from "./protocol.js";
import type { Principal } from "./principal.js";
import type { Audit } from "./audit.js";
import type { SessionService } from "./session-service.js";

const clientInstructions =
	"Before the first model invocation for a user task, display this exact user-visible sentence with the selected model ID: 『Model Agent MCPをmodel ○○で使います。』 Replace ○○ with the model ID. If the task call omits model, use agent_list_models to learn default_model, then display the sentence before agent_start_task. For an existing session, use agent_get_session to learn its model before the first agent_continue_task. Never silently invoke a model. If a result includes fallback_from, tell the user the request fell back to CLIProxyAPI model auto; do not claim to know the concrete model chosen by auto.";

function result(value: unknown) {
	return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}

async function call(
	action: () => Promise<unknown>,
	audit: Audit,
	correlation: string,
) {
	try {
		await audit.record("tool_started", correlation);
		const value = await action();
		if (Buffer.byteLength(JSON.stringify(value)) > 32768)
			throw new Error("Response rejected");
		const failed =
			typeof value === "object" &&
			value !== null &&
			"status" in value &&
			(value.status === "error" || value.status === "unknown");
		await audit.record(failed ? "tool_error" : "tool_succeeded", correlation);
		return { ...result(value), ...(failed ? { isError: true } : {}) };
	} catch {
		try {
			await audit.record("tool_error", correlation);
		} catch {
			/* Fail closed; never expose the disk error. */
		}
		return {
			isError: true,
			content: [{ type: "text" as const, text: "Operation rejected" }],
		};
	}
}

export function createMcpServer(
	sessions: SessionService,
	principal: Principal,
	audit: Audit,
	correlation: string,
): McpServer {
	const server = new McpServer(
		{ name: "model-agent-mcp", version: "0.1.0" },
		{ instructions: clientInstructions },
	);

	server.server.registerCapabilities({ tools: { listChanged: false } });

	server.registerTool(
		"agent_list_models",
		{
			_meta: { securitySchemes: [{ type: "oauth2", scopes: ["model:list"] }] },
			description:
				"List model IDs currently advertised by CLIProxyAPI. A listed model may still fail if its credential or route is unavailable.",
			inputSchema: toolSchemas.agent_list_models,
		},
		() => call(() => sessions.listModels(principal), audit, correlation),
	);

	server.registerTool(
		"agent_set_default_model",
		{
			_meta: { securitySchemes: [{ type: "oauth2", scopes: ["model:admin"] }] },
			description:
				"Set the shared default model for new tasks when model is omitted. Existing sessions keep their model. This setting resets to DEFAULT_MODEL on server restart.",
			inputSchema: toolSchemas.agent_set_default_model,
		},
		({ model }) =>
			call(
				() => sessions.setDefaultModel(principal, model),
				audit,
				correlation,
			),
	);

	server.registerTool(
		"agent_start_task",
		{
			_meta: { securitySchemes: [{ type: "oauth2", scopes: ["model:start"] }] },
			description:
				"Before calling, visibly announce 'Model Agent MCPをmodel ○○で使います。' with the selected model ID. Ask the model for implementation guidance or a patch. The calling MCP client supplies repository context and applies and verifies proposed changes.",
			inputSchema: toolSchemas.agent_start_task,
		},
		({ task, context, model }) =>
			call(
				() => sessions.start(principal, task, context, model),
				audit,
				correlation,
			),
	);

	server.registerTool(
		"agent_continue_task",
		{
			_meta: {
				securitySchemes: [{ type: "oauth2", scopes: ["model:continue"] }],
			},
			description:
				"Continue a model consultation using its server-side conversation history. If this is the first model invocation for the user task, announce the session model visibly before calling.",
			inputSchema: toolSchemas.agent_continue_task,
		},
		({ session_id, message }) =>
			call(
				() => sessions.continue(principal, session_id, message),
				audit,
				correlation,
			),
	);

	server.registerTool(
		"agent_set_session_model",
		{
			_meta: { securitySchemes: [{ type: "oauth2", scopes: ["model:set"] }] },
			description:
				"Select a different CLIProxyAPI model for future messages in this session. Prior conversation is retained.",
			inputSchema: toolSchemas.agent_set_session_model,
		},
		({ session_id, model }) =>
			call(
				() => sessions.setModel(principal, session_id, model),
				audit,
				correlation,
			),
	);

	server.registerTool(
		"agent_get_session",
		{
			_meta: { securitySchemes: [{ type: "oauth2", scopes: ["model:get"] }] },
			description:
				"Get a session's model, status, timestamps, and short previews of prior turns.",
			inputSchema: toolSchemas.agent_get_session,
		},
		({ session_id }) =>
			call(() => sessions.get(principal, session_id), audit, correlation),
	);

	server.registerTool(
		"agent_cancel_task",
		{
			_meta: {
				securitySchemes: [{ type: "oauth2", scopes: ["model:cancel"] }],
			},
			description:
				"Cancel an in-flight request and close the session to future messages.",
			inputSchema: toolSchemas.agent_cancel_task,
		},
		({ session_id }) =>
			call(() => sessions.cancel(principal, session_id), audit, correlation),
	);

	return server;
}
