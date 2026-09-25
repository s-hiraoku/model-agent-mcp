import { z } from "zod";

const modelsResponse = z.object({
  data: z.array(z.object({ id: z.string().min(1) }).passthrough()),
});

const completionResponse = z.object({
  choices: z.array(z.object({
    message: z.object({ content: z.string().nullable() }),
  }).passthrough()).min(1),
});

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

export interface ModelClient {
  listModels(): Promise<string[]>;
  complete(model: string, messages: ChatMessage[], signal: AbortSignal): Promise<string>;
}

export class ProxyError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = "ProxyError";
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

  async listModels(): Promise<string[]> {
    const data = await this.request("/v1/models", { method: "GET" });
    const parsed = modelsResponse.safeParse(data);
    if (!parsed.success) throw new ProxyError("CLIProxyAPI returned an invalid model list");
    return [...new Set(parsed.data.data.map((item) => item.id))].sort();
  }

  async complete(model: string, messages: ChatMessage[], signal: AbortSignal): Promise<string> {
    const data = await this.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages, max_tokens: this.maxTokens, stream: false }),
      signal,
    });
    const parsed = completionResponse.safeParse(data);
    if (!parsed.success || !parsed.data.choices[0]?.message.content) {
      throw new ProxyError("CLIProxyAPI returned no text response");
    }
    return parsed.data.choices[0].message.content;
  }

  private async request(path: string, init: RequestInit): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetcher(`${this.baseUrl}${path}`, {
        ...init,
        headers: { Authorization: `Bearer ${this.apiKey}`, ...init.headers },
        signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(this.timeoutMs)]) : AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw error;
      throw new ProxyError("CLIProxyAPI request failed or timed out");
    }
    if (!response.ok) throw new ProxyError(`CLIProxyAPI returned HTTP ${response.status}`, response.status);
    try {
      return await response.json();
    } catch {
      throw new ProxyError("CLIProxyAPI returned invalid JSON");
    }
  }
}
