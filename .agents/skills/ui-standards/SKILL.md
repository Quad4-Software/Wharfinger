---
name: ui-standards
description: >
  Panel and status page UI conventions: layout, states, feedback,
  accessibility. Use when building or modifying any page or
  component.
---

## Conventions

- Semantic Tailwind tokens only (`bg-card`, `text-fg`, `text-faint`,
  `border-edge`, `text-up/down/degraded`). No raw hex or palette
  utilities in markup.
- Loading: shaped skeletons matching final layout, never bare
  spinners or "Loading..." text.
- Empty: icon + one-line explanation + primary action. Distinguish
  "nothing exists" from "filters hide everything".
- Feedback: every mutation ends in a toast or inline result. Failed
  actions keep user input intact.
- Filters stay visible as removable chips while active.
- KPI strips hold 4-6 tiles; meaningful color is reserved for state
  and alerts.
- Keyboard: every action reachable by keyboard, focus-visible rings,
  Escape closes modals and drawers.
- `aria-busy` during reloads, `aria-expanded` on disclosure
  controls, `aria-label` on icon-only buttons.
- `prefers-reduced-motion` respected; no mandatory animation.
- Mobile: drawer nav, stacked cards, tables collapse or scroll
  horizontally with a visible affordance.
- New interactive elements get correct `type="button"` so they never
  submit forms by accident.
