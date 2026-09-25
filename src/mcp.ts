import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SessionService } from "./session-service.js";

const text = z.string().trim().min(1).max(200_000);
const id = z.string().uuid();
const model = z.string().trim().min(1).max(200);

function result(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}

async function call(action: () => Promise<unknown>) {
  try {
    return result(await action());
  } catch (error) {
    return {
      isError: true,
      content: [{ type: "text" as const, text: error instanceof Error ? error.message : "Unknown error" }],
    };
  }
}

export function createMcpServer(sessions: SessionService): McpServer {
  const server = new McpServer({ name: "model-agent-mcp", version: "0.1.0" });

  server.registerTool("agent_list_models", {
    description: "List model IDs currently advertised by CLIProxyAPI. A listed model may still fail if its credential or route is unavailable.",
    inputSchema: {},
  }, () => call(() => sessions.listModels()));

  server.registerTool("agent_start_task", {
    description: "Ask the selected model for implementation guidance or a patch. Cursor supplies repository context and applies and verifies any proposed changes.",
    inputSchema: { task: text, context: text.optional(), model: model.optional() },
  }, ({ task, context, model }) => call(() => sessions.start(task, context, model)));

  server.registerTool("agent_continue_task", {
    description: "Continue a model consultation using its server-side conversation history.",
    inputSchema: { session_id: id, message: text },
  }, ({ session_id, message }) => call(() => sessions.continue(session_id, message)));

  server.registerTool("agent_set_session_model", {
    description: "Select a different CLIProxyAPI model for future messages in this session. Prior conversation is retained.",
    inputSchema: { session_id: id, model },
  }, ({ session_id, model }) => call(() => sessions.setModel(session_id, model)));

  server.registerTool("agent_get_session", {
    description: "Get a session's model, status, timestamps, and short previews of prior turns.",
    inputSchema: { session_id: id },
  }, ({ session_id }) => call(() => sessions.get(session_id)));

  server.registerTool("agent_cancel_task", {
    description: "Cancel an in-flight request and close the session to future messages.",
    inputSchema: { session_id: id },
  }, ({ session_id }) => call(() => sessions.cancel(session_id)));

  return server;
}
