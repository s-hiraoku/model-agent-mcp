import type { ChatMessage } from "./proxy-client.js";

export type SessionStatus = "running" | "ready" | "error" | "cancelled";

export interface Session {
	id: string;
	owner: string;
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
	constructor(
		private readonly maxSessions = 128,
		private readonly ttlMs = 900000,
		private readonly now = Date.now,
	) {}
	private sweep() {
		for (const [id, session] of this.sessions) {
			if (
				session.status !== "running" &&
				this.now() - Date.parse(session.updatedAt) >= this.ttlMs
			)
				this.sessions.delete(id);
		}
	}

	count() {
		this.sweep();
		return this.sessions.size;
	}
	async get(id: string): Promise<Session | undefined> {
		this.sweep();
		const session = this.sessions.get(id);
		return session ? structuredClone(session) : undefined;
	}

	async put(session: Session): Promise<void> {
		this.sweep();
		if (
			!this.sessions.has(session.id) &&
			(this.sessions.size >= this.maxSessions ||
				[...this.sessions.values()].filter((s) => s.owner === session.owner)
					.length >= 32)
		)
			throw new Error("Session limit reached");
		this.sessions.set(session.id, structuredClone(session));
	}
}
