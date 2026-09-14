# .agents

Agent-facing documentation for this codebase. Rules are binding;
skills are procedures; references are background reading.

## Layout

- `rules/` binding conventions. Violating them fails review or CI.
- `skills/` task procedures with a `SKILL.md` per skill. Follow the
  steps; do not improvise around the safety checks.
- `references/` architecture notes and research. Read on demand.

## Index

### Rules

- `rules/style.md` code style, prose rules, comment policy
- `rules/architecture.md` module boundaries, layering, file size
- `rules/security.md` the audit checklist every feature must pass
- `rules/testing.md` test types, coverage floor, what must be tested

### Skills

- `skills/job-queue/` how the durable job queue works and how to add
  a job kind
- `skills/deploy-pipeline/` deploy lifecycle, executor protocol,
  rollback semantics
- `skills/safe-breakdown/` splitting a large file without losing
  code or behavior
- `skills/security-audit/` running the per-feature security pass
- `skills/ui-standards/` panel and status page UI conventions

### References

- `references/deploy-architecture.md` control plane vs executor
  split, wire protocol, threat model
- `references/coolify-notes.md` what Coolify/Dokku do, and where we
  deliberately differ
- `references/ai-mcp.md` AI provider adapter and MCP server design
  plus the threat model that gates it
