export interface Config {
  host: string;
  port: number;
  mcpBearerToken: string;
  proxyBaseUrl: string;
  proxyApiKey: string;
  defaultModel: string;
  maxTokens: number;
  timeoutMs: number;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function positiveInteger(value: string, name: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const proxyBaseUrl = required(env, "CLIPROXY_BASE_URL").replace(/\/+$/, "");
  const parsedUrl = new URL(proxyBaseUrl);
  if (!["http:", "https:"].includes(parsedUrl.protocol) || parsedUrl.pathname !== "/" || parsedUrl.search || parsedUrl.hash) {
    throw new Error("CLIPROXY_BASE_URL must be an HTTP(S) origin without a path");
  }
  return {
    host: env.HOST || "0.0.0.0",
    port: positiveInteger(env.PORT || "8765", "PORT"),
    mcpBearerToken: required(env, "MCP_BEARER_TOKEN"),
    proxyBaseUrl,
    proxyApiKey: required(env, "CLIPROXY_API_KEY"),
    defaultModel: required(env, "DEFAULT_MODEL"),
    maxTokens: positiveInteger(env.MODEL_MAX_TOKENS || "4096", "MODEL_MAX_TOKENS"),
    timeoutMs: positiveInteger(env.CLIPROXY_TIMEOUT_MS || "120000", "CLIPROXY_TIMEOUT_MS"),
  };
}
