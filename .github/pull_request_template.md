<!-- What does this change do, and why? -->

## Summary



## Checklist

- [ ] Colours and motion come from **design tokens** — no raw hex / `rgb()` / ad-hoc palette classes.
- [ ] Spacing and controls use Foundry primitives and the field-gap tokens — no hand-rolled bodges.
- [ ] User-facing strings go through `t()`, with translations added to **every** shipped catalog.
- [ ] Accessibility is wired up — roles, labels, keyboard handlers, live regions, `aria-hidden` on decorative icons.
- [ ] No secrets or personal data in the diff (self-audited with `git diff`).
- [ ] Typecheck passes (`npm run type-check` — covers the app, the bridge *and* the browser extension) and the relevant tests are updated and green.
