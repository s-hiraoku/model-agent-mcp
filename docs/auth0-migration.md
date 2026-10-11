# Reviewed migration to dedicated Auth0 authorization

This source change does not change a running server, publish an endpoint, create an Auth0 API/application/grant, issue a credential, or restart Docker. The old shared Bearer deployment remains a separate deployment risk until an explicit migration. There is no legacy Bearer fallback in this source. Missing Auth0 configuration denies every MCP request.

Before deployment, obtain approval for a dedicated HTTPS model MCP resource/API audience, exact issuer, exact client IDs, exact verified subjects, and each client's allowed scopes. The model audience must equal its canonical resource and differ from the Hub audience. Use RS256 access tokens with a lifetime of at most 600 seconds. `model:admin` changes the global default and must be granted separately; ordinary clients should never receive it. Every session operation additionally matches issuer, subject and client together, with no administrator ownership bypass.

Create an operator-owned, non-symlink, mode 0600 private JSON file outside the repository and select it with `MODEL_AUTH0_CONFIG`. Example (dummy values only):

```json
{
  "issuer": "https://example.us.auth0.com/",
  "audience": "https://model.example/mcp",
  "resource": "https://model.example/mcp",
  "clients": [{
    "id": "APPROVED_CLIENT",
    "subjects": ["VERIFIED_SUBJECT"],
    "scopes": ["model:list", "model:start", "model:continue", "model:set", "model:get", "model:cancel"]
  }]
}
```

Do not paste access tokens into configuration. Incoming Auth0 tokens never become upstream credentials. CLIProxyAPI uses its own existing, separately managed `CLIPROXY_API_KEY`; redirects are refused. Automatic model fallback is disabled in production. No price or free allowance is inferred from model names.

Before opening a route, test the actual proxy's Host/Origin preservation and duplicated headers, then authenticated success and each denied issuer/audience/client/subject/scope case. Forwarded IP headers are deliberately ignored. Existing Funnel/Docker listeners are not proof of these checks. Validate the dedicated audience against a Hub token and confirm that each server rejects the other's token.

## Resource and audit policy

The process admits at most 120 MCP HTTP requests/minute, 4 active HTTP exchanges, 32 KiB request JSON, and 16 KiB native server headers. Model operations admit 20 calls/minute globally and per owner, one concurrent provider call, 30-second service deadlines, 128 sessions globally, 32 per owner, 15-minute inactive TTL, 16 turns, 8 KiB input fields, 64 KiB history, 16 KiB model responses, and 32 KiB serialized tool results. Upstream bodies are streamed with a 64 KiB ceiling. A provider that ignores abort retains its uncertain concurrency slot until it settles; a timeout is not evidence that remote execution stopped. Limits and sessions are process-local and reset at restart, not a durable billing quota. Sessions are intentionally ephemeral and are not copied across users or restarts.

Production startup requires a private audit directory (`MODEL_AUDIT_DIRECTORY`, default `runtime/audit`). Logs contain only fixed category, UTC time and server-issued random request ID: never subject/client IDs, tokens, argument/result text, raw URL, raw session ID, IP, or exception stack. Three files at most, 256 KiB each; archived files older than 24 hours are removed on activity. Twenty rejection/error events within a minute append a local `anomaly` event; no external notification is sent. Counters saturate and reset by minute. Disk/permission/symlink failures deny admission or the tool action. If an after-action audit fails, the already performed operation cannot be undone; the result is reported as rejected, and callers must not blindly retry model calls.

Run the source checks before deployment. Deployment approval must separately cover endpoint/scope/data, existing route replacement, process restart, paid-model allowance ($0 means no paid invocation), and real proxy behavior. OS-level isolation of the existing model service has not been verified. This code is not an OS sandbox and grants no shell/filesystem tools to a model.
