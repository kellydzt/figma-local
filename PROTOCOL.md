# Figma Local · internal contract

Zero third-party runtime dependencies. Node >=22, native Figma development plugin.
Local HTTP service binds 127.0.0.1:38474. Bearer pairing token required for all
`/v1/*` routes; only Figma/null and loopback origins accepted. The server does
not start, focus or modify Figma on its own.

## Transport

- `POST /v1/connect` `{sessionId, document:{id,name,fileKey?}}` registers a live plugin.
- `POST /v1/poll` `{sessionId}` long-polls (20s) for `{job:null}` or
  `{job:{id,method,params}}`. Polling is also the heartbeat.
- `POST /v1/result` `{sessionId,operationId,ok,result?,error?}` completes that
  session's issued operation. Error is `{message,...}`.
- `GET /v1/sessions` -> `{sessions:[{sessionId,document,lastSeen,busy,uncertainOperations}]}`.
- `POST /v1/operations` `{sessionId,documentId,method,params,operationId?}` ->
  operation record immediately. The caller generates a UUID when omitted.
- `GET /v1/operations/:id` -> operation record (export bytes omitted by default;
  `?result=1` retrieves full bytes for client-side file saving).
- `POST /v1/operations/:id/ack` `{note}` explicitly acknowledges a reviewed
  failed/unknown write. It never retries or undoes it. Running jobs cannot be acknowledged.
- `GET /health` -> `{name:'figma-local',version:'0.1.0'}` (no secrets).

Record: `{id,sessionId,documentId,method,params,status,createdAt,updatedAt,
result?,error?,requiresReview?,acknowledgedAt?,acknowledgement?}`. Status is
queued/running/completed/failed/unknown. Reads are `inspect`, `fonts`, `export`;
all other methods are writes. One active job per document. Unknown/failed writes
requiring review block further writes, but allow reads when no job is active.
Timeout never implies safe retry; a running timeout stays active until a late
result or session loss. Persist records atomically; restart marks unfinished
jobs unknown. Reconnecting must not clear review barriers for the same document.
Same operation ID and same document/method/params returns the original record;
changed payload conflicts. Session ID is excluded from this content comparison.
Simultaneous connections claiming the same document ID are rejected (except an
idempotent reconnect of the same session). Clients explicitly choose a session.

## Plugin runtime

`plugin/runtime.js` is a self-contained IIFE exposing
`globalThis.FigmaLocalRuntime.execute(figma, method, params)`.
It returns JSON-serializable data, throws Error on failure, never closes plugin.

- `inspect`: `{nodeIds?:string[],depth?:number,maxNodes?:number}`. Default current
  page summary/selection; bounded traversal, report truncation. Include actual
  fonts/style/lineHeight, layout/padding/sizing, fills/strokes/effects.
- `fonts`: `{family?:string}` -> available font family/style list (bounded).
- `create`: `{template:'button'|'pill'|'browser',pageId?,name?,x?,y?,...options}`.
  Geist default, exact requested font/style required. Returns created root and
  child IDs + dimensions. Native editable nodes; no destructive replacement.
- `update`: `{nodeIds:string[],props:{...}}` with small explicit property allowlist
  including padding shorthand, font, text, fill, width/height, cornerRadius,
  layout mode and sizing. Prevalidate all targets/fonts before editing where feasible.
- `page.create`: `{name}` -> `{id,name}`; explicitly selects new page.
- `export`: `{nodeId,format?:'PNG'|'SVG',scale?:number}` ->
  `{nodeId,format,mime,data:<base64>,width,height}`. Bound scale/output size.
- `run`: `{code:string}` async JS body, `figma` native API; advanced local escape
  hatch, NOT a security sandbox. Returned value must be bounded JSON data. No host eval.

Normal create/update/run should preserve original page/selection unless script
explicitly changes them. Create uses pageId or current page, at supplied x/y.
Failure may be partial; never claim general rollback. Main plugin handles dispatch,
identity and transport UI; runtime only handles Figma calls.

## CLI / MCP

`node cli.mjs setup|start|sessions|call METHOD FILE|operation ID|ack ID NOTE|mcp`.
`call` accepts `--session ID --document ID --id UUID --out PATH --wait MS`.
Config at `.local/config.json` holds port/token; generated paired plugin at
`.local/plugin/manifest.json` with fixed path. Both ignored by Git.
CLI prints JSON and saves export bytes to local file, returns path metadata only.
MCP stdio wraps the same client; no separate state/transport implementation.
