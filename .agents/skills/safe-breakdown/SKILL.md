---
name: safe-breakdown
description: >
  Split a large file into smaller modules without losing code,
  behavior, or tests. Use whenever check:files flags a file or a
  module is approaching its size ceiling.
---

## Method

1. Baseline first: run the file's existing tests plus `pnpm check`
   and record green. If no tests cover the file, write smoke tests
   for its public surface before moving anything.
2. Map responsibilities by reading top to bottom. Group functions
   that share a private helper or a data shape. Seams are where a
   group touches the rest only through its exported signature.
3. Pick the largest cohesive group. Move it verbatim into a new
   file named for its responsibility. Do not rename, reorder, or
   reformat while moving. Moves are text surgery only.
4. Fix imports mechanically: the original file imports what it still
   uses, the new file exports what the original still needs. Keep
   the original file's public API identical so callers do not change.
5. Run tests + svelte-check + eslint after every single move. If
   anything fails, revert that move, not the whole split.
6. Repeat per group until under the ceiling. One move per verified
   step; never batch two moves before testing.
7. Final pass: delete now-unused imports, run prettier, update the
   check:files exception list if the file was listed.

## Rules

- Public API shape stays identical. Callers never edit in the same
  commit as a split.
- No behavior changes inside a split commit. Renames, refactors, and
  fixes are separate commits.
- Moved code is verbatim. If a moved function needs an edit, split
  first, verify, then edit in a follow-up.
- Keep a copy of the original file until the split is verified
  (git does this; do not also delete history via squash mid-split).
