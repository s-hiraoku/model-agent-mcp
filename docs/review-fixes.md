# Independent review findings and regression evidence

This change is source-only. It changes neither the deployed service nor Auth0/Funnel/Docker settings, credentials, OS permissions or paid-model allowance.

| Finding | Final behavior | Regression evidence |
| --- | --- | --- |
| Synchronous audit I/O under unauthenticated flood | One isolated filesystem worker; 32 pending acknowledged entries (hard configurable ceiling 64); five-second ACK deadline; rejected admission uses fixed-memory counters, never immediate I/O. | `async-audit.test.ts`: queue overflow, 100,000 suppressed events, saturation, cooldown, sticky failures, real isolated writer. `protocol-http.test.ts`: 500 unauthenticated requests yield exactly 240 detail records and 380 suppressed events. |
| Native response lifetime / SDK listener | Explicit finite-method dispatch; `subscriptions/listen` refused, `tools.listChanged=false`; SDK response creation and body bounded, 64 KiB output, finite socket flush. | `protocol-http.test.ts`: installed SDK baseline returns HTTP 200 SSE and remains open; four protected listeners are refused and normal tools/list still succeeds; stalled/oversized streams fail. |
| cancel + continue / setModel race | Short per-session locks serialize admission/state changes; final write rechecks cancellation; provider wait does not hold the lock needed to cancel. | `security.test.ts`: idle-session Promise.all(cancel first, continue/setModel) cannot revive or add a provider call. Existing active-provider abort regression remains. |
| Rejected start consumes invisible session capacity | Model admission and concurrency reservation precede insertion; failure frees the reservation. | `security.test.ts`: 40 busy rejections and 40 rate rejections leave only the original session; a later accepted start can use the remaining slot. |
| Deadline classified as success | Deadline returns `unknown`, `isError` and `tool_error`; explicit local cancellation remains a successful cancel operation. Unconfirmed provider slots remain occupied until the provider settles. | `security.test.ts`: deadline MCP output/audit, hung providers and explicit cancel. |
| SDK rejects before registered callback | Bounded protocol inspection emits fixed `tool_error` for malformed UUID/unknown tool and `transport_error` for malformed JSON without saving payload. | `protocol-http.test.ts`: actual HTTP 200 SDK isError/JSON-RPC error responses are audited before callbacks; malformed JSON is classified separately. |

The original cancel race was reproduced with both cancel+continue and cancel+setModel: each returned two fulfilled operations and left the session ready. The SDK listener was reproduced locally with the installed SDK, a JSON-RPC envelope, `Mcp-Method: subscriptions/listen`, version 2026-07-28, fixed client metadata and toolsListChanged=true. No real endpoint was probed.

## Audit failure and aggregation contract

HTTP admission counters run before audit I/O. At most 120 requests per minute enter detailed processing, with four concurrent HTTP exchanges. Filesystem operations run off the HTTP event loop; actions await acknowledgement of their before-action record. Queue saturation rejects the action without growing the queue. Worker startup/write/exit/ACK failure permanently latches unavailable for that process, rejects pending records, stops the writer and summary timer, and denies later admission without retrying writes. Repair/restart requires an operator decision. A failed after-action record cannot undo an action already performed; do not blindly replay model calls.

Suppressed records use a fixed enum map and counters capped at 65,535. One summary at most per ten seconds contains only fixed category counts, dropped count, saturation flag and a fixed anomaly flag (20 or more suppressed events). Saturated counts are lower bounds. Unacknowledged summary counts remain bounded in process memory; they are not automatically replayed. Process failure/restart can lose the last unflushed counters. Rotation/retention still caps three private files of 256 KiB; filesystem inspection touches only the fixed log/archive names. Worker environment is empty: upstream and incoming authentication credentials are not copied into it. Acknowledgement means the operating-system write completed, not an fsync durability guarantee.

Authentication, subject/client ownership, old-token rejection and separate upstream credentials remain unchanged. Production migration and OS isolation remain unverified.

## SDK outcome follow-up

The native HTTP wrapper records fixed `transport_error` for SDK responses with status 400 or greater. `protocol-http.test.ts` covers unsupported version, malformed envelope, unacceptable Accept and media-type preflight rejection. No version, header, envelope, payload or SDK error text is saved. Authentication denial and callback tool errors retain their separate classifications.
