import type { ChatMessage } from "./proxy-client.js";

export type SessionStatus = "running" | "ready" | "error" | "cancelled";

export interface Session {
  id: string;
  model: string;
  context?: string;
  messages: ChatMessage[];
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;
}

export interface SessionStore {
  get(id: string): Promise<Session | undefined>;
  put(session: Session): Promise<void>;
}

export class MemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, Session>();

  async get(id: string): Promise<Session | undefined> {
    return this.sessions.get(id);
  }

  async put(session: Session): Promise<void> {
    this.sessions.set(session.id, session);
  }
}
