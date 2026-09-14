# AI features and MCP: design and threat model

## Posture

Everything in this file is opt-in and off by default. The panel
works identically with `[ai]` absent. No code path may degrade or
nag when AI is disabled.

## Provider adapter

- OpenAI chat-completions wire format only for v1. That covers
  OpenAI, Azure proxies, Ollama (`/v1/chat/completions`), LM Studio,
  llama.cpp, LiteLLM, and most gateways.
- Config: `[ai] enabled, base_url, model, api_key (sealed),
max_tokens, temperature, timeout`.
- Calls route through the egress dispatcher. `base_url` is validated
  like any outbound target; local model endpoints need an explicit
  allow (`ai.allow_local`) since the egress guard blocks loopback
  and link-local by default.
- No streaming in v1: request/response only, with a hard token cap.

## Data rules

- Prompt assembly is a fixed template plus an allowlist of fields
  (service name, check kind, error class, counts). Never: sealed
  values, tokens, chat bodies, full monitored page content, audit
  IPs beyond the first octet, env names or values.
- Monitored content that must be summarized is stripped of markup
  and quoted as data, never concatenated into instruction position.
- Model output is rendered as text and labeled generated. It can
  propose actions; execution is a normal authenticated API call
  from a user click, with the usual audit entry.

## MCP server

- Separate opt-in surface: stdio binary or loopback listener, never
  the public mux.
- v1 tools are read-only: list_services, get_service_status,
  list_incidents, list_agents, get_audit_summary.
- Auth: scoped `qs_` API key with a new `mcp.read` scope, or OAuth
  2.1 resource-server mode later. No static god tokens.
- Tool list is compiled in and static. No runtime tool mutation, no
  remote tool descriptions. Output is bounded JSON with the same
  allowlist rules as prompts.
- Treat all MCP tool output as untrusted toward the model: it can
  contain monitored names and error strings that a hostile service
  name could weaponize as prompt injection. Keep descriptions
  instructing the model to treat fields as data.

## Known attack classes to keep out

- Tool poisoning: never load tool descriptions from remote servers.
- Rug pull: tool list is static per build; there is nothing to swap.
- Confused deputy: MCP tokens are scoped read-only and cannot call
  admin mutations.
- Prompt injection via monitored data: quoted-as-data policy plus
  no instruction-position interpolation.
- Secret exfiltration: allowlisted prompt fields; sealed material
  is structurally unavailable to the adapter.
