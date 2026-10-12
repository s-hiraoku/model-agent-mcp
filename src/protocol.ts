import { z } from "zod";
import type { Audit } from "./audit.js";
const text = z.string().trim().min(1).max(8192),
	id = z.string().uuid(),
	model = z.string().trim().min(1).max(200);
export const toolSchemas = {
	agent_list_models: z.strictObject({}),
	agent_set_default_model: z.strictObject({ model }),
	agent_start_task: z.strictObject({
		task: text,
		context: text.optional(),
		model: model.optional(),
	}),
	agent_continue_task: z.strictObject({ session_id: id, message: text }),
	agent_set_session_model: z.strictObject({ session_id: id, model }),
	agent_get_session: z.strictObject({ session_id: id }),
	agent_cancel_task: z.strictObject({ session_id: id }),
};
const methods = new Set([
	"server/discover",
	"initialize",
	"notifications/initialized",
	"ping",
	"tools/list",
	"tools/call",
]);
/** Observe SDK pre-callback rejection without logging payload or dispatching unsupported methods. */
export async function protocolAdmission(
	body: unknown,
	header: string | undefined,
	audit: Audit,
	correlation: string,
): Promise<boolean> {
	if (!body || typeof body !== "object" || Array.isArray(body)) {
		await audit.record("transport_error", correlation);
		return false;
	}
	const envelope = body as Record<string, unknown>;
	const legacy = envelope.jsonrpc === "2.0";
	const method = header ?? envelope.method;
	if (
		typeof method !== "string" ||
		!methods.has(method) ||
		(header && legacy && header !== envelope.method)
	) {
		await audit.record("resource_rejected", correlation);
		return false;
	}
	if (method === "tools/call") {
		const params = (legacy ? envelope.params : envelope) as
			| Record<string, unknown>
			| undefined;
		const name = params?.name;
		if (
			typeof name !== "string" ||
			!Object.hasOwn(toolSchemas, name) ||
			!toolSchemas[name as keyof typeof toolSchemas].safeParse(
				params?.arguments ?? {},
			).success
		)
			await audit.record("tool_error", correlation);
	}
	return true;
}
export async function boundedResponse(
	response: Response,
	timeoutMs = 45000,
): Promise<Uint8Array> {
	if (!response.body) return new Uint8Array();
	const reader = response.body.getReader();
	let size = 0;
	const chunks: Uint8Array[] = [];
	let timer: NodeJS.Timeout | undefined;
	const deadline = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => {
			void reader.cancel().catch(() => {});
			reject(new Error("Response rejected"));
		}, timeoutMs);
	});
	const reading = (async () => {
		for (;;) {
			const item = await reader.read();
			if (item.done) break;
			size += item.value.length;
			if (size > 65536) throw new Error("Response rejected");
			chunks.push(item.value);
		}
		return Buffer.concat(chunks);
	})();
	try {
		return await Promise.race([reading, deadline]);
	} finally {
		clearTimeout(timer);
		void reader.cancel().catch(() => {});
	}
}
export async function exchangeResponse(
	work: Promise<Response>,
	timeoutMs = 45000,
): Promise<Response> {
	let expired = false;
	let timer: NodeJS.Timeout | undefined;
	void work.then(
		(response) => {
			if (expired) void response.body?.cancel().catch(() => {});
		},
		() => {},
	);
	const deadline = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => {
			expired = true;
			reject(new Error("Response rejected"));
		}, timeoutMs);
	});
	try {
		return await Promise.race([work, deadline]);
	} finally {
		clearTimeout(timer);
	}
}
