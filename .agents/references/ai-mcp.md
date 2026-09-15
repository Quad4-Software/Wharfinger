# AI features and MCP: design and threat model

## Posture

Everything in this file is opt-in and off by default. The panel
works identically with `[ai]` absent. No code path may degrade or
nag when AI is disabled.

## Provider adapter

- OpenAI chat-completions wire format only for v1. That covers
  OpenAI, Azure proxies, Ollama (`/v1/chat/completions`), LM Studio,
  llama.cpp, LiteLLM, and most gateways.
- Config: `[ai] enabled, base_url, model, api_key, max_tokens,
temperature, timeout_ms, mcp_enabled`. api_key resolves ${VAR}
  at load like every other config secret and is never rendered in
  prompts or logs.
- `base_url` gets `/chat/completions` appended, preserving any
  versioned path prefix (`/v1`).
- Calls route through the egress dispatcher with redirect: manual
  and a streamed, size-capped response body. The egress guard blocks
  link-local and cloud metadata targets by default; loopback and
  RFC1918 are allowed so local models work without extra flags.
  `monitor.allow_link_local` remains the only way to reach a model
  on a link-local address.
- No streaming in v1: request/response only, with a hard token cap.

## Local models

- Ollama: `base_url = "http://127.0.0.1:11434/v1"`, any pulled model
  name in `model`, `api_key` may be empty.
- LM Studio: `base_url = "http://127.0.0.1:1234/v1"`, model id from
  the server tab.
- llama.cpp `llama-server`: `base_url = "http://127.0.0.1:8080/v1"`.
- A remote provider key is just `api_key = "${OPENAI_API_KEY}"` with
  `base_url = "https://api.openai.com/v1"`.

## Panel surfaces

- `ai.use` gates `POST /admin/api/ai/ask` (12/min per user) and
  `POST /admin/api/ai/suggest` (8/min per user). Both 404 when AI
  is disabled and audit successful calls.
- The assistant card lives on the incidents page and can be focused
  on a single incident. Answers render as text with a generated
  label and the sources list.
- Suggested actions resolve through a fixed kind catalog to real
  audited admin routes; the UI shows a confirm dialog and calls the
  route itself. The model output never executes anything.

## Data rules

- Prompt assembly is a fixed template plus an allowlist of fields
  (service name, status, latency, uptime, incident titles and
  updates, agent name/version/posture). Never: sealed values,
  tokens, chat bodies, full monitored page content, env names or
  values.
- Monitored content is sanitized (control chars, tag and quote
  metacharacters stripped, length-capped) and wrapped in double
  quotes as data, never concatenated into instruction position.
- The system prompt states the quoted-as-data contract and forbids
  emitting secrets.

## MCP server

- `POST /api/mcp` speaks single-request JSON-RPC; notifications get
  202, GET gets 405. Gated on `[ai].mcp_enabled`, off by default.
- Auth: `qs_` API key with the existing `read` scope, resolved by
  hash. No static god tokens.
- v1 tools are read-only and compiled in: list_services,
  get_service, list_incidents, list_agents, list_jobs. No runtime
  tool mutation, no remote tool descriptions. Output is bounded
  sanitized JSON under the same allowlist rules as prompts.
- Treat all MCP tool output as untrusted toward the model: it can
  contain monitored names and error strings that a hostile service
  name could weaponize as prompt injection. Tool descriptions tell
  the model to treat fields as data.

## Known attack classes to keep out

- Tool poisoning: never load tool descriptions from remote servers.
- Rug pull: tool list is static per build; there is nothing to swap.
- Confused deputy: MCP tokens are scoped read-only and cannot call
  admin mutations.
- Prompt injection via monitored data: quoted-as-data policy plus
  no instruction-position interpolation.
- Secret exfiltration: allowlisted prompt fields; sealed material
  is structurally unavailable to the adapter.
- Egress abuse: provider calls run through the same dispatcher that
  blocks metadata endpoints; response bodies are capped.
