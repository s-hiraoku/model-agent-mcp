import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { SessionService } from "./session-service.js";

const text = z.string().trim().min(1).max(200_000);
const id = z.string().uuid();
const model = z.string().trim().min(1).max(200);
const clientInstructions = "Before the first model invocation for a user task, display this exact user-visible sentence with the selected model ID: 『Model Agent MCPをmodel ○○で使います。』 Replace ○○ with the model ID. If the task call omits model, use agent_list_models to learn default_model, then display the sentence before agent_start_task. For an existing session, use agent_get_session to learn its model before the first agent_continue_task. Never silently invoke a model. If a result includes fallback_from, tell the user the request fell back to CLIProxyAPI model auto; do not claim to know the concrete model chosen by auto.";

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
  const server = new McpServer({ name: "model-agent-mcp", version: "0.1.0" }, { instructions: clientInstructions });

  server.registerTool("agent_list_models", {
    description: "List model IDs currently advertised by CLIProxyAPI. A listed model may still fail if its credential or route is unavailable.",
    inputSchema: z.object({}),
  }, () => call(() => sessions.listModels()));

  server.registerTool("agent_set_default_model", {
    description: "Set the shared default model for new tasks when model is omitted. Existing sessions keep their model. This setting resets to DEFAULT_MODEL on server restart.",
    inputSchema: z.object({ model }),
  }, ({ model }) => call(() => sessions.setDefaultModel(model)));

  server.registerTool("agent_start_task", {
    description: "Before calling, visibly announce 'Model Agent MCPをmodel ○○で使います。' with the selected model ID. Ask the model for implementation guidance or a patch. The calling MCP client supplies repository context and applies and verifies proposed changes.",
    inputSchema: z.object({ task: text, context: text.optional(), model: model.optional() }),
  }, ({ task, context, model }) => call(() => sessions.start(task, context, model)));

  server.registerTool("agent_continue_task", {
    description: "Continue a model consultation using its server-side conversation history. If this is the first model invocation for the user task, announce the session model visibly before calling.",
    inputSchema: z.object({ session_id: id, message: text }),
  }, ({ session_id, message }) => call(() => sessions.continue(session_id, message)));

  server.registerTool("agent_set_session_model", {
    description: "Select a different CLIProxyAPI model for future messages in this session. Prior conversation is retained.",
    inputSchema: z.object({ session_id: id, model }),
  }, ({ session_id, model }) => call(() => sessions.setModel(session_id, model)));

  server.registerTool("agent_get_session", {
    description: "Get a session's model, status, timestamps, and short previews of prior turns.",
    inputSchema: z.object({ session_id: id }),
  }, ({ session_id }) => call(() => sessions.get(session_id)));

  server.registerTool("agent_cancel_task", {
    description: "Cancel an in-flight request and close the session to future messages.",
    inputSchema: z.object({ session_id: id }),
  }, ({ session_id }) => call(() => sessions.cancel(session_id)));

  return server;
}
