# Style rules

Binding for all code, docs, comments, commit messages, and user-facing
strings in this repo.

## Prose and comments

- Plain ASCII only. No curly quotes, no decorative arrows, no emojis.
- No em dashes. No en dashes used as punctuation. Use a comma, colon,
  or period instead.
- No semicolons in prose.
- No backticks around identifiers in code comments. Write the name
  bare.
- No AI slop: no "delve", "seamless", "leverage", "robust solution",
  "it is important to note", no filler hedging, no marketing voice.
  Say what the code does or what the reader must do, nothing else.
- Comments explain why, not what. Do not narrate the next line.
- Do not add or remove comments unless the task requires it.

## Code

- TypeScript strict everywhere. No `any` without a comment justifying
  it. Prefer `unknown` + narrowing.
- Svelte 5 runes. No legacy `$:` blocks in new code.
- One component per concern. Compose; do not grow god files.
- Server-only code never enters client bundles. Shared types and pure
  functions live in `src/lib/shared/` or `src/lib/utils/`.
- Fixed argv for subprocesses. Never build shell strings from data.
- All SQL parameterized. All fetched HTML/text treated as hostile.
- Errors are handled at sensible boundaries. Do not wrap every call
  in try/catch; do not swallow errors silently either.

## Go (agent/)

- stdlib first. Third-party deps need justification in the PR.
- Collectors degrade gracefully: missing tools omit the section.
- Every collector has a timeout and bounded output.
- gofmt, go vet, go test -race are the gate.

## Formatting

- Prettier for TS/Svelte/MD. gofmt for Go. Both are CI-enforced.
- LF endings, UTF-8, trailing newline, no trailing whitespace.
