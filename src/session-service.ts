import { randomUUID } from "node:crypto";
import { ProxyError, type ChatMessage, type ModelClient } from "./proxy-client.js";
import type { Session, SessionStore } from "./session-store.js";

const SYSTEM_PROMPT = "You are an implementation adviser. You cannot inspect or edit the user's repository or run commands. Use only the context provided. For code changes, propose concrete changes or a unified diff with file paths. State assumptions and never claim tests were run. The calling MCP client owns repository inspection, edits, verification, and git.";

export class SessionError extends Error {}

type TaskResult = { session_id: string; model: string; status: string; response?: string; error?: string; fallback_from?: string };

export class SessionService {
  private readonly active = new Map<string, AbortController>();

  constructor(
    private readonly store: SessionStore,
    private readonly client: ModelClient,
    private defaultModel: string,
  ) {}

  async listModels(): Promise<{ default_model: string; models: string[] }> {
    return { default_model: this.defaultModel, models: await this.client.listModels() };
  }

  async setDefaultModel(model: string): Promise<{ default_model: string }> {
    this.defaultModel = model;
    return { default_model: model };
  }

  async start(task: string, context?: string, model?: string): Promise<TaskResult> {
    const now = new Date().toISOString();
    const session: Session = {
      id: randomUUID(),
      model: model ?? this.defaultModel,
      context,
      messages: [],
      status: "ready",
      createdAt: now,
      updatedAt: now,
    };
    await this.store.put(session);
    return this.run(session, task);
  }

  async continue(id: string, message: string): Promise<TaskResult> {
    const session = await this.requireSession(id);
    if (session.status === "cancelled") throw new SessionError("Session is cancelled");
    return this.run(session, message);
  }

  async setModel(id: string, model: string): Promise<{ session_id: string; model: string }> {
    const session = await this.requireSession(id);
    if (session.status === "cancelled") throw new SessionError("Session is cancelled");
    if (this.active.has(id)) throw new SessionError("Session is busy");
    session.model = model;
    session.updatedAt = new Date().toISOString();
    await this.store.put(session);
    return { session_id: id, model };
  }

  async get(id: string): Promise<object> {
    const session = await this.requireSession(id);
    return {
      session_id: session.id,
      model: session.model,
      status: session.status,
      created_at: session.createdAt,
      updated_at: session.updatedAt,
      turn_count: session.messages.filter((message) => message.role === "user").length,
      history_summary: session.messages.map((message) => ({ role: message.role, preview: message.content.slice(0, 200) })),
    };
  }

  async cancel(id: string): Promise<{ session_id: string; status: string }> {
    const session = await this.requireSession(id);
    this.active.get(id)?.abort();
    session.status = "cancelled";
    session.updatedAt = new Date().toISOString();
    await this.store.put(session);
    return { session_id: id, status: "cancelled" };
  }

  private async requireSession(id: string): Promise<Session> {
    const session = await this.store.get(id);
    if (!session) throw new SessionError("Session not found");
    return session;
  }

  private async run(session: Session, input: string): Promise<TaskResult> {
    if (this.active.has(session.id)) throw new SessionError("Session is busy");
    const controller = new AbortController();
    this.active.set(session.id, controller);
    session.status = "running";
    session.updatedAt = new Date().toISOString();
    let fallbackFrom: string | undefined;
    try {
      await this.store.put(session);
      const messages: ChatMessage[] = [
        { role: "system", content: `${SYSTEM_PROMPT}${session.context ? `\n\nRepository context supplied by the calling MCP client:\n${session.context}` : ""}` },
        ...session.messages,
        { role: "user", content: input },
      ];
      let response: string;
      try {
        response = await this.client.complete(session.model, messages, controller.signal);
      } catch (error) {
        if (!(error instanceof ProxyError && error.modelUnavailable) || session.model === "auto" || controller.signal.aborted) throw error;
        fallbackFrom = session.model;
        response = await this.client.complete("auto", messages, controller.signal);
        if (!controller.signal.aborted) session.model = "auto";
      }
      if (controller.signal.aborted) return { session_id: session.id, model: session.model, status: "cancelled" };
      session.messages.push({ role: "user", content: input }, { role: "assistant", content: response });
      session.status = "ready";
      return { session_id: session.id, model: session.model, status: "ready", response, ...(fallbackFrom && { fallback_from: fallbackFrom }) };
    } catch (error) {
      if (controller.signal.aborted) return { session_id: session.id, model: session.model, status: "cancelled" };
      session.status = "error";
      return {
        session_id: session.id,
        model: session.model,
        status: "error",
        error: error instanceof Error ? error.message : "Unknown upstream error",
        ...(fallbackFrom && { fallback_from: fallbackFrom }),
      };
    } finally {
      session.updatedAt = new Date().toISOString();
      this.active.delete(session.id);
      await this.store.put(session);
    }
  }
}
