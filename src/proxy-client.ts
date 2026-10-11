import { z } from "zod";

const modelsResponse = z.object({
	data: z
		.array(z.object({ id: z.string().min(1).max(200) }).passthrough())
		.max(128),
});

const completionResponse = z.object({
	choices: z
		.array(
			z
				.object({
					message: z.object({ content: z.string().nullable() }),
				})
				.passthrough(),
		)
		.min(1),
});

export type ChatMessage = {
	role: "system" | "user" | "assistant";
	content: string;
};

export interface ModelClient {
	listModels(signal?: AbortSignal): Promise<string[]>;
	complete(
		model: string,
		messages: ChatMessage[],
		signal: AbortSignal,
	): Promise<string>;
}

export class ProxyError extends Error {
	constructor(
		message: string,
		public readonly status?: number,
		public readonly code?: string,
	) {
		super(message);
		this.name = "ProxyError";
	}

	get modelUnavailable(): boolean {
		if (this.status === 401 || this.status === 403) return false;
		return (
			this.code === "model_not_found" ||
			this.code === "auth_not_found" ||
			this.code === "auth_unavailable" ||
			this.status === 429 ||
			this.status === 503
		);
	}
}

export class CLIProxyClient implements ModelClient {
	constructor(
		private readonly baseUrl: string,
		private readonly apiKey: string,
		private readonly maxTokens: number,
		private readonly timeoutMs: number,
		private readonly fetcher: typeof fetch = fetch,
	) {}

	async listModels(signal?: AbortSignal): Promise<string[]> {
		const data = await this.request("/v1/models", { method: "GET", signal });
		const parsed = modelsResponse.safeParse(data);
		if (!parsed.success)
			throw new ProxyError("CLIProxyAPI returned an invalid model list");
		return [...new Set(parsed.data.data.map((item) => item.id))].sort();
	}

	async complete(
		model: string,
		messages: ChatMessage[],
		signal: AbortSignal,
	): Promise<string> {
		const data = await this.request("/v1/chat/completions", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				model,
				messages,
				max_tokens: this.maxTokens,
				stream: false,
			}),
			signal,
		});
		const parsed = completionResponse.safeParse(data);
		if (!parsed.success || !parsed.data.choices[0]?.message.content) {
			throw new ProxyError("CLIProxyAPI returned no text response");
		}
		return parsed.data.choices[0].message.content;
	}

	private async readBounded(response: Response): Promise<unknown> {
		if (!response.body) throw new ProxyError("Invalid upstream response");
		const reader = response.body.getReader();
		const chunks: Uint8Array[] = [];
		let size = 0;
		let expired = false;
		const timeout = setTimeout(() => {
			expired = true;
			void reader.cancel();
		}, this.timeoutMs);
		timeout.unref();
		try {
			for (;;) {
				const part = await reader.read();
				if (part.done) break;
				size += part.value.length;
				if (size > 65536)
					throw new ProxyError("Upstream response limit reached");
				chunks.push(part.value);
			}
			if (expired) throw new ProxyError("Upstream deadline reached");
			return JSON.parse(Buffer.concat(chunks).toString("utf8"));
		} finally {
			clearTimeout(timeout);
			await reader.cancel().catch(() => {});
		}
	}

	private async request(path: string, init: RequestInit): Promise<unknown> {
		let response: Response;
		try {
			response = await this.fetcher(`${this.baseUrl}${path}`, {
				...init,
				redirect: "error",
				headers: { Authorization: `Bearer ${this.apiKey}`, ...init.headers },
				signal: init.signal
					? AbortSignal.any([init.signal, AbortSignal.timeout(this.timeoutMs)])
					: AbortSignal.timeout(this.timeoutMs),
			});
		} catch (error) {
			if (error instanceof Error && error.name === "AbortError") throw error;
			throw new ProxyError("CLIProxyAPI request failed or timed out");
		}
		if (!response.ok) {
			let code: string | undefined;
			try {
				const body = await this.readBounded(response);
				const parsed = z
					.object({ error: z.object({ code: z.string() }) })
					.safeParse(body);
				if (parsed.success) code = parsed.data.error.code;
			} catch {
				// Keep the HTTP status when the upstream error body is not JSON.
			}
			throw new ProxyError(
				`CLIProxyAPI returned HTTP ${response.status}`,
				response.status,
				code,
			);
		}
		try {
			return await this.readBounded(response);
		} catch {
			throw new ProxyError("CLIProxyAPI returned invalid JSON");
		}
	}
}
