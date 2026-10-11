export const SCOPES = [
	"model:list",
	"model:admin",
	"model:start",
	"model:continue",
	"model:set",
	"model:get",
	"model:cancel",
] as const;
export type Scope = (typeof SCOPES)[number];
export interface Principal {
	issuer: string;
	subject: string;
	clientId: string;
	scopes: readonly Scope[];
}
export function ownerKey(principal: Principal): string {
	return JSON.stringify([
		principal.issuer,
		principal.subject,
		principal.clientId,
	]);
}
export function requireScope(principal: Principal, scope: Scope): void {
	if (
		!principal?.issuer ||
		!principal.subject ||
		!principal.clientId ||
		!principal.scopes.includes(scope)
	)
		throw new Error("Operation rejected");
}
