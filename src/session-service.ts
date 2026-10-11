import { randomUUID } from "node:crypto";
import {
	ProxyError,
	type ChatMessage,
	type ModelClient,
} from "./proxy-client.js";
import { ownerKey, requireScope, type Principal } from "./principal.js";
import type { Session, SessionStore } from "./session-store.js";

const SYSTEM_PROMPT =
	"You are an implementation adviser. You cannot inspect or edit the user's repository or run commands. Use only the context provided. For code changes, propose concrete changes or a unified diff with file paths. State assumptions and never claim tests were run. The calling MCP client owns repository inspection, edits, verification, and git.";

export class SessionError extends Error {}

type TaskResult = {
	session_id: string;
	model: string;
	status: string;
	response?: string;
	error?: string;
	fallback_from?: string;
};

export class SessionService {
	private readonly active = new Map<string, AbortController>();
	private readonly pending = new Set<string>();
	private readonly admissions = new Map<
		string,
		{ window: number; calls: number }
	>();
	private globalWindow = 0;
	private globalCalls = 0;

	constructor(
		private readonly store: SessionStore,
		private readonly client: ModelClient,
		private defaultModel: string,
		private readonly options: {
			maxConcurrent?: number;
			maxCalls?: number;
			maxTurns?: number;
			timeoutMs?: number;
			allowFallback?: boolean;
		} = {},
	) {}

	async listModels(
		principal: Principal,
	): Promise<{ default_model: string; models: string[] }> {
		requireScope(principal, "model:list");
		this.admit(ownerKey(principal));
		const key = `list:${randomUUID()}`;
		const controller = new AbortController();
		this.active.set(key, controller);
		try {
			const models = await this.bounded(
				key,
				this.client.listModels(controller.signal),
				controller,
			);
			if (models.length > 128 || models.some((m) => Buffer.byteLength(m) > 200))
				throw new SessionError("Model list limit reached");
			return { default_model: this.defaultModel, models };
		} finally {
			if (!this.pending.has(key)) this.active.delete(key);
		}
	}

	async setDefaultModel(
		principal: Principal,
		model: string,
	): Promise<{ default_model: string }> {
		requireScope(principal, "model:admin");
		this.checkText(model);
		this.defaultModel = model;
		return { default_model: model };
	}

	async start(
		principal: Principal,
		task: string,
		context?: string,
		model?: string,
	): Promise<TaskResult> {
		requireScope(principal, "model:start");
		this.checkText(task, context, model);
		const now = new Date().toISOString();
		const session: Session = {
			id: randomUUID(),
			owner: ownerKey(principal),
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

	async continue(
		principal: Principal,
		id: string,
		message: string,
	): Promise<TaskResult> {
		requireScope(principal, "model:continue");
		const session = await this.requireSession(principal, id);
		if (session.status === "cancelled")
			throw new SessionError("Session is cancelled");
		return this.run(session, message);
	}

	async setModel(
		principal: Principal,
		id: string,
		model: string,
	): Promise<{ session_id: string; model: string }> {
		requireScope(principal, "model:set");
		const session = await this.requireSession(principal, id);
		if (session.status === "cancelled")
			throw new SessionError("Session is cancelled");
		if (this.active.has(id)) throw new SessionError("Session is busy");
		this.checkText(model);
		session.model = model;
		session.updatedAt = new Date().toISOString();
		await this.store.put(session);
		return { session_id: id, model };
	}

	async get(principal: Principal, id: string): Promise<object> {
		requireScope(principal, "model:get");
		const session = await this.requireSession(principal, id);
		return {
			session_id: session.id,
			model: session.model,
			status: session.status,
			created_at: session.createdAt,
			updated_at: session.updatedAt,
			turn_count: session.messages.filter((message) => message.role === "user")
				.length,
			history_summary: session.messages.map((message) => ({
				role: message.role,
				preview: message.content.slice(0, 200),
			})),
		};
	}

	async cancel(
		principal: Principal,
		id: string,
	): Promise<{ session_id: string; status: string }> {
		requireScope(principal, "model:cancel");
		const session = await this.requireSession(principal, id);
		this.active.get(id)?.abort();
		session.status = "cancelled";
		session.updatedAt = new Date().toISOString();
		await this.store.put(session);
		return { session_id: id, status: "cancelled" };
	}

	private async bounded<T>(
		key: string,
		work: Promise<T>,
		controller: AbortController,
	): Promise<T> {
		this.pending.add(key);
		let abandoned = false;
		void work.then(
			() => {
				this.pending.delete(key);
				if (abandoned) this.active.delete(key);
			},
			() => {
				this.pending.delete(key);
				if (abandoned) this.active.delete(key);
			},
		);
		let timer: NodeJS.Timeout | undefined;
		const deadline = new Promise<never>((_resolve, reject) => {
			timer = setTimeout(() => {
				controller.abort();
				reject(new SessionError("Deadline reached"));
			}, this.options.timeoutMs ?? 30000);
		});
		try {
			return await Promise.race([work, deadline]);
		} catch (error) {
			abandoned = this.pending.has(key);
			throw error;
		} finally {
			clearTimeout(timer);
		}
	}

	private checkText(...values: (string | undefined)[]) {
		if (
			values.some(
				(value) =>
					value !== undefined &&
					(typeof value !== "string" ||
						!value.trim() ||
						Buffer.byteLength(value) > 8192),
			)
		)
			throw new SessionError("Input limit reached");
	}
	private admit(owner: string) {
		const now = Date.now();
		if (now - this.globalWindow > 60000) {
			this.globalWindow = now;
			this.globalCalls = 0;
		}
		for (const [key, entry] of this.admissions)
			if (now - entry.window > 60000) this.admissions.delete(key);
		const entry = this.admissions.get(owner) ?? { window: now, calls: 0 };
		if (
			this.active.size >= (this.options.maxConcurrent ?? 1) ||
			this.globalCalls >= (this.options.maxCalls ?? 20) ||
			entry.calls >= (this.options.maxCalls ?? 20) ||
			(!this.admissions.has(owner) && this.admissions.size >= 64)
		)
			throw new SessionError("Call limit reached");
		entry.calls++;
		this.globalCalls++;
		this.admissions.set(owner, entry);
	}

	private async requireSession(
		principal: Principal,
		id: string,
	): Promise<Session> {
		const session = await this.store.get(id);
		if (!session || session.owner !== ownerKey(principal))
			throw new SessionError("Operation rejected");
		return session;
	}

	private async run(session: Session, input: string): Promise<TaskResult> {
		this.checkText(input);
		if (
			session.messages.length >= (this.options.maxTurns ?? 16) * 2 ||
			Buffer.byteLength(JSON.stringify(session.messages)) +
				Buffer.byteLength(input) +
				Buffer.byteLength(session.context ?? "") >
				65536
		)
			throw new SessionError("History limit reached");
		if (this.active.has(session.id)) throw new SessionError("Session is busy");
		this.admit(session.owner);
		const controller = new AbortController();
		this.active.set(session.id, controller);

		session.status = "running";
		session.updatedAt = new Date().toISOString();
		let fallbackFrom: string | undefined;
		try {
			await this.store.put(session);
			const messages: ChatMessage[] = [
				{
					role: "system",
					content: `${SYSTEM_PROMPT}${session.context ? `\n\nRepository context supplied by the calling MCP client:\n${session.context}` : ""}`,
				},
				...session.messages,
				{ role: "user", content: input },
			];
			let response: string;
			try {
				response = await this.bounded(
					session.id,
					this.client.complete(session.model, messages, controller.signal),
					controller,
				);
			} catch (error) {
				if (
					!this.options.allowFallback ||
					!(error instanceof ProxyError && error.modelUnavailable) ||
					session.model === "auto" ||
					controller.signal.aborted
				)
					throw error;
				fallbackFrom = session.model;
				response = await this.bounded(
					session.id,
					this.client.complete("auto", messages, controller.signal),
					controller,
				);
				if (!controller.signal.aborted) session.model = "auto";
			}
			if (controller.signal.aborted) {
				session.status = "cancelled";
				return {
					session_id: session.id,
					model: session.model,
					status: "cancelled",
				};
			}
			if (
				Buffer.byteLength(response) > 16384 ||
				Buffer.byteLength(JSON.stringify(session.messages)) +
					Buffer.byteLength(input) +
					Buffer.byteLength(response) +
					Buffer.byteLength(session.context ?? "") >
					65536
			)
				throw new SessionError("Response limit reached");
			session.messages.push(
				{ role: "user", content: input },
				{ role: "assistant", content: response },
			);
			session.status = "ready";
			return {
				session_id: session.id,
				model: session.model,
				status: "ready",
				response,
				...(fallbackFrom && { fallback_from: fallbackFrom }),
			};
		} catch {
			if (controller.signal.aborted) {
				session.status = "cancelled";
				return {
					session_id: session.id,
					model: session.model,
					status: "cancelled",
				};
			}
			session.status = "error";
			return {
				session_id: session.id,
				model: session.model,
				status: "error",
				error: "Upstream operation failed",
				...(fallbackFrom && { fallback_from: fallbackFrom }),
			};
		} finally {
			session.updatedAt = new Date().toISOString();
			if (!this.pending.has(session.id)) this.active.delete(session.id);
			await this.store.put(session);
		}
	}
}
