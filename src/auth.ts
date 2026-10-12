import {
	constants,
	closeSync,
	fstatSync,
	openSync,
	readFileSync,
} from "node:fs";
import { createRemoteJWKSet, customFetch, jwtVerify } from "jose";
import { SCOPES, type Principal, type Scope } from "./principal.js";
export interface AuthConfig {
	issuer: string;
	audience: string;
	clients: { id: string; subjects: string[]; scopes: Scope[] }[];
	resource: string;
}
export function loadAuthConfig(path: string): AuthConfig {
	const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const stat = fstatSync(fd);
		if (
			!stat.isFile() ||
			stat.nlink !== 1 ||
			(stat.mode & 0o077) !== 0 ||
			stat.uid !== process.getuid?.() ||
			stat.size > 16384
		)
			throw new Error("Invalid authentication configuration");
		const config = JSON.parse(readFileSync(fd, "utf8")) as AuthConfig;
		if (
			!config ||
			Object.keys(config).some(
				(key) => !["issuer", "audience", "resource", "clients"].includes(key),
			)
		)
			throw new Error("Invalid authentication configuration");
		const issuer = new URL(config.issuer),
			resource = new URL(config.resource);
		if (
			issuer.protocol !== "https:" ||
			!issuer.hostname.endsWith(".auth0.com") ||
			issuer.username ||
			issuer.password ||
			issuer.pathname !== "/" ||
			issuer.search ||
			issuer.hash ||
			config.issuer !== issuer.href ||
			resource.protocol !== "https:" ||
			resource.username ||
			resource.password ||
			resource.search ||
			resource.hash ||
			resource.pathname !== "/mcp" ||
			typeof config.audience !== "string" ||
			config.audience.length < 8 ||
			config.audience.length > 256 ||
			config.audience !== config.resource ||
			!Array.isArray(config.clients) ||
			!config.clients.length ||
			config.clients.length > 8
		)
			throw new Error("Invalid authentication configuration");
		const seen = new Set<string>();
		for (const c of config.clients) {
			if (
				!c ||
				Object.keys(c).some(
					(key) => !["id", "subjects", "scopes"].includes(key),
				) ||
				typeof c.id !== "string" ||
				!c.id ||
				c.id.length > 128 ||
				seen.has(c.id) ||
				!Array.isArray(c.subjects) ||
				!c.subjects.length ||
				c.subjects.length > 8 ||
				c.subjects.some((s) => typeof s !== "string" || !s || s.length > 256) ||
				!Array.isArray(c.scopes) ||
				!c.scopes.length ||
				c.scopes.some((s) => !SCOPES.includes(s))
			)
				throw new Error("Invalid authentication configuration");
			seen.add(c.id);
		}
		return config;
	} finally {
		closeSync(fd);
	}
}
export type Verify = (header: string | undefined) => Promise<Principal | null>;
export function createVerifier(
	config: AuthConfig,
	fetcher: typeof fetch = fetch,
): Verify {
	const keys = createRemoteJWKSet(
		new URL(".well-known/jwks.json", config.issuer),
		{
			timeoutDuration: 3000,
			cooldownDuration: 30000,
			cacheMaxAge: 300000,
			[customFetch]: async (url, options) => {
				if (
					String(url) !== new URL(".well-known/jwks.json", config.issuer).href
				)
					throw new Error("Rejected key endpoint");
				const response = await fetcher(url, {
					...options,
					redirect: "error",
					signal: AbortSignal.timeout(3000),
				});
				if (!response.ok || !response.body) throw new Error("Rejected keys");
				const reader = response.body.getReader();
				let size = 0;
				const chunks: Uint8Array[] = [];
				try {
					for (;;) {
						const item = await reader.read();
						if (item.done) break;
						size += item.value.length;
						if (size > 65536) throw new Error("Rejected keys");
						chunks.push(item.value);
					}
				} finally {
					await reader.cancel().catch(() => {});
				}
				const body = Buffer.concat(chunks);
				const parsed = JSON.parse(body.toString("utf8")) as {
					keys?: Record<string, unknown>[];
				};
				if (
					!Array.isArray(parsed.keys) ||
					!parsed.keys.length ||
					parsed.keys.length > 16
				)
					throw new Error("Rejected keys");
				const seen = new Set<string>();
				for (const key of parsed.keys) {
					if (
						key.kty !== "RSA" ||
						key.alg !== "RS256" ||
						key.use !== "sig" ||
						typeof key.kid !== "string" ||
						!key.kid ||
						key.kid.length > 128 ||
						seen.has(key.kid) ||
						typeof key.n !== "string" ||
						key.n.length > 2048 ||
						typeof key.e !== "string" ||
						key.e.length > 16 ||
						["d", "p", "q", "dp", "dq", "qi", "oth", "k"].some(
							(name) => name in key,
						)
					)
						throw new Error("Rejected keys");
					seen.add(key.kid);
				}
				return new Response(body, {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			},
		},
	);
	return async (header) => {
		if (
			!header ||
			header.length > 16384 ||
			!/^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(header)
		)
			return null;
		try {
			const { payload, protectedHeader } = await jwtVerify(
				header.slice(7),
				keys,
				{
					issuer: config.issuer,
					audience: config.audience,
					algorithms: ["RS256"],
					requiredClaims: ["sub", "iat", "exp", "azp", "scope"],
					clockTolerance: 0,
				},
			);
			if (
				!protectedHeader.kid ||
				payload.aud !== config.audience ||
				typeof payload.iat !== "number" ||
				typeof payload.exp !== "number" ||
				payload.exp - payload.iat > 600 ||
				payload.exp <= payload.iat ||
				payload.iat > Date.now() / 1000 ||
				typeof payload.sub !== "string" ||
				typeof payload.azp !== "string" ||
				typeof payload.scope !== "string" ||
				payload.scope.length > 512 ||
				payload.act ||
				payload.cnf ||
				payload.authorization_details ||
				(payload.client_id !== undefined && payload.client_id !== payload.azp)
			)
				return null;
			const client = config.clients.find(
				(c) =>
					c.id === payload.azp && c.subjects.includes(payload.sub as string),
			);
			const scopes = payload.scope.split(" ");
			if (
				!client ||
				!scopes.length ||
				scopes.some(
					(s) =>
						!SCOPES.includes(s as Scope) || !client.scopes.includes(s as Scope),
				)
			)
				return null;
			return Object.freeze({
				issuer: config.issuer,
				subject: payload.sub,
				clientId: payload.azp,
				scopes: Object.freeze(scopes as Scope[]),
			});
		} catch {
			return null;
		}
	};
}
