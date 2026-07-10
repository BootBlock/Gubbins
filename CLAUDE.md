# Gubbins — working conventions

> 🔒 **NEVER COMMIT SECRETS.** This repository is **public**. No API keys, tokens,
> passwords, private keys, connection strings, or personal data may ever enter the working
> tree, a commit, or git history. Read the section below before adding any credential-shaped
> value or committing changes.

> ⚠️ **USE DESIGN TOKENS, NOT HARD-CODED VALUES.** This is the one rule that is easy to
> break and hard to spot in review. Read the section below before adding any colour,
> spacing, radius, easing, or other visual value.

## No secrets in the repository (mandatory)

This is a **public** repository. Committing a secret is treated as a build-breaking error —
secrets are effectively permanent once pushed (they live in history and may be scraped within
seconds), so the only safe rule is to never let one in.

**Hard rules — these are not negotiable:**

- **Never** write an API key, token, password, secret, private key, certificate, OAuth
  client secret, session cookie, or connection string into any tracked file — including
  source, tests, fixtures, docs, comments, config, and commit messages. Use an obvious
  placeholder (`<YOUR_API_KEY>`, `sk-xxxx`) when an example is genuinely needed.
- **Never** commit real personal data: private email addresses, phone numbers, real names
  tied to private accounts, internal hostnames, or IP addresses. Use the GitHub `noreply`
  identity (`BootBlock@users.noreply.github.com`), `example.com` / `*.test` domains, and
  `localhost` in examples and tests.
- **Secrets belong in `.env` only.** `.env` and `.env.*` are git-ignored (keep
  `.env.example` with placeholder values only). Read configuration from the environment at
  runtime — never inline it.
- **Never** commit data artefacts that may carry real content: `*.sqlite`/`*.db`, database
  dumps, exported vaults/archives, `.pem`/`.key`/`.pfx`/`.p12`/keystores, or `id_rsa*`.
- **Before every commit, self-audit the diff.** Run `git diff --cached` and scan for
  anything credential-shaped or personal. If a secret is in doubt, leave it out and ask.
- **If a secret is ever committed, stop.** Treat it as compromised: it must be rotated/revoked
  at the source, and the history scrubbed — removing it in a later commit is **not**
  sufficient. Surface this immediately rather than quietly continuing.

## Public-repository hygiene (mandatory)

Everything here — code, comments, commit messages, branch names, docs, and history — is
**world-readable and permanent**. Write it as if a stranger will read it tomorrow, because
they can.

- **Stay professional and neutral.** No profanity, disparaging remarks, jokes at anyone's
  expense, or venting in code, comments, or commit messages. No TODOs that name or blame a
  person.
- **No internal-only references.** Don't embed private ticket IDs, internal wiki/Jira/Slack
  URLs, internal hostnames, server names, or other infrastructure details a stranger
  shouldn't see. Describe the *what* and *why*, not internal plumbing.
- **Protect everyone's privacy, not just the maintainer's.** Never commit real data about
  any third party — customers, testers, colleagues. Fixtures and sample data must be
  synthetic (`example.com` / `*.test`, made-up names, placeholder values).
- **Dependency & IP hygiene.** Don't paste code from sources with an incompatible or unknown
  licence; prefer writing it or using a properly-attributed, licence-compatible dependency.
  Vet new dependencies (popularity, maintenance, licence) before adding them, and keep the
  dependency surface minimal. This repo is licensed **MIT** (see [LICENSE](LICENSE)) — keep
  `package.json`'s `license` field and any added licence headers consistent with it, and
  don't introduce text implying a different licence.
- **Keep the ignore rules tight.** Before committing a new kind of generated or local file,
  confirm it belongs in the repo; if it's a build artefact, local cache, or could contain
  real data, add it to `.gitignore` instead.

## Design tokens are mandatory where one exists

Every colour and motion value in the UI must come from a **design token**, never a raw
hex / `rgb()` / `oklch()` literal or an ad-hoc Tailwind palette class (`text-red-500`,
`bg-blue-600`, …). Tokens are defined in [src/styles/index.css](src/styles/index.css) and
exposed as Tailwind utilities + the Foundry primitives.

Use them **where possible and appropriate**:

| Need | Use | Not |
| --- | --- | --- |
| Destructive / delete / remove action | `variant="destructive"` (Foundry `Button`) or the `destructive` / `text-destructive` token | `bg-red-600`, `text-red-500`, raw hex |
| Primary / call-to-action | `variant="primary"` or the `primary` token | `bg-indigo-600` |
| Surfaces, borders, muted text | `bg-card` / `border-border` / `text-muted-foreground` | `bg-zinc-900`, `#1e1e1e` |
| Success / warning / danger glyphs | `text-glyph-*` tokens | raw colour literals |
| Signature easing | the `ease-emphasized` token | `cubic-bezier(...)` inline |
| Animation | a `gubbins-*` keyframe + `animate-*` utility | inline `@keyframes` / one-off durations |

**Rules of thumb**

- Reach for a **Foundry primitive** first (`Button`, `Surface`, `Modal`, …) — its variants
  already wire the right tokens, so `variant="destructive"` is preferred over manually
  composing `bg-destructive text-destructive-foreground`.
- If a token *doesn't* exist for a genuinely new semantic role, **add the token** to
  `src/styles/index.css` (both the light and dark blocks) rather than hard-coding the value
  at the call site. One definition, themable in one place, dark-mode-correct for free.
- A raw colour/easing literal in a component is a smell — it bypasses theming, dark mode,
  and the reduced-motion catch-all. Only acceptable when no token could reasonably apply.

This keeps the app themable, dark-mode-correct, and accessible (the reduced-motion and
contrast handling all hang off the tokens).

## Controls & spacing: no hand-rolled bodges

The same discipline extends to **layout, spacing and controls**, not just colour and motion.
A raw spacing/sizing value — or a hand-rolled control where a token or Foundry primitive
already exists — is a smell for the same reason a raw colour is: it silently diverges from
the system, drops the wiring the primitive gives you for free, and is easy to miss in review.

- **Label→control spacing uses the field-gap tokens.** A form field's label sits above its
  control at `mb-field-gap` (10px), or `mb-field-gap-compact` (8px) for the denser `text-xs`
  labels in nested editors. Never hand-roll the gap with a raw sub-token value (`space-y-1`,
  `flex flex-col gap-1`, `mb-1`, …) — that leaves the label crowding the control. Use
  `gap-field-gap-compact` / `space-y-field-gap-compact` when the field is a flex column or a
  stack rather than a block label.
- **Prefer a Foundry primitive over hand-rolling.** A labelled input belongs in `FormField`
  (it wires implicit label association, `aria-invalid` / `aria-describedby` error text and
  the hint badge); a control is `Input` / `Select` / `Textarea`; a dialog is `Modal`; a
  dropdown is `Menu`; a screen header is `PageHeader` (+ the global `AppNav`). Re-styling a
  bare `<button>` / `<input>` that duplicates a primitive's variants, focus ring, sizing
  (`h-10`) or ARIA is a bodge. If a genuinely new primitive is needed, add it to
  [src/components/foundry](src/components/foundry) rather than one-off styling at the call site.
- **Don't skip accessibility to save a few lines.** No interactive `<div>` / `<span>` without
  a role + keyboard handler, no icon-only button without an `aria-label`, no error text
  outside a `role="alert"`, no live status outside `LiveRegion`, no decorative icon without
  `aria-hidden`, and every screen keeps its `<main id="main-content">` + skip-link wiring.

When a fix introduces a token-based Tailwind utility, remember **unknown utilities fail
silently** (no CSS, no error) — verify it actually emits by building the CSS and grepping the
output before trusting it.

## User-facing strings are translated (i18n)

Every user-facing string goes through the typed `t()` seam ([src/features/i18n](src/features/i18n)),
not a hard-coded literal — the same discipline as design tokens: a raw string bypasses translation,
silently diverges, and is easy to miss in review. `en.json` is the single source of truth for the
English copy; other languages (currently `de.json`) are override catalogs.

**The rule — when you add or change any user-facing string, include its translated equivalent too:**

- **Route it through `t()`.** Add a key to
  [src/features/i18n/catalogs/en.json](src/features/i18n/catalogs/en.json) and render it with
  `const t = useT(); … {t('some.key')}` (see the memory note `i18n-typed-catalog-seam`). This covers
  visible text **and** accessibility strings: `aria-label`, `title`, `alt`, `placeholder`, tooltip
  content, live-region announcements — a screen-reader user gets the same language as a sighted one.
- **Add the translation to *every* shipped catalog in the same change.** A key added to `en.json`
  **must** also be added to `de.json` (and any future catalog) with a real translation — never leave
  it English-only there. The catalog tests enforce this (they assert full pilot coverage + that every
  `{placeholder}` is preserved), so a missing or malformed translation fails the build, not review.
- **Keep the English value byte-identical to any code-side reference.** Where a data registry keeps an
  English string beside its key (`NAV_DESTINATIONS[].label`, `DASHBOARD_WIDGETS[].title`), the
  `en.json` value must equal it — a drift test asserts this, and the identity is what keeps existing
  screen tests (which assert English copy) green.
- **Pluralize and interpolate through the seam, never by hand.** A count-dependent message uses
  `key.one` / `key.other` variants selected by `t('key', { vars: { count } })`; a value spliced into a
  sentence is a `{placeholder}` var — do not concatenate strings or hand-roll `n === 1 ? … : …`.
- **Scope reality:** only a slice is converted so far (global chrome, Dashboard, About). New strings in
  a not-yet-converted screen still *should* be added via `t()` so that screen is ready to translate,
  but the hard, build-enforced rule above applies to every string that goes through a catalog.
  Untranslated keys fall back to English, so nothing breaks — but "add the string, skip the
  translation" is not acceptable for a catalog key.

## Actioning a GitHub issue (workflow)

When the maintainer gives you a Gubbins issue URL —
`https://github.com/BootBlock/Gubbins/issues/<id>` — with no other instruction, treat it as a
request to **action that issue end-to-end** using the workflow below. (Bare `#<id>` or "issue
<id>" in the Gubbins context means the same.) If the message clearly wants only discussion —
"what do you think of…", "should we…", "explain #<id>" — answer instead; when in doubt, ask.

The structural steps here (worktree, code review, merge mechanics) are **internal process**.
They must **never** leak into anything world-readable — not the issue comment, commit messages,
branch names, or code. An end user reading the issue should see only *what* changed and *why*,
never the plumbing. This is the [public-repository hygiene](#public-repository-hygiene-mandatory)
rule applied to issue handling.

**The workflow, in order:**

1. **Read the issue.** `gh issue view <id> --repo BootBlock/Gubbins --json title,body,labels,comments`.
   Understand what's actually being asked; locate the relevant code before changing anything.
2. **Work in a git worktree — always.** Other agents edit this repo concurrently, so every issue
   task runs in its own worktree (see the memory note `gubbins-concurrent-agents-worktrees`): edit
   via worktree-relative absolute paths, never touch another agent's worktree, and expect `main` to
   have advanced. This is required even though the issue itself won't say so.
3. **Implement the fix following every project convention** above — design tokens, i18n `t()`,
   accessibility wiring, Foundry primitives, and the no-secrets / public-hygiene rules. Match the
   surrounding code's style.
4. **Verify it works.** Typecheck (`npx tsc -b`) and run any tests the change touches; where the
   change has a runtime surface, drive it (the `verify` skill) rather than trusting types alone.
5. **Code review before committing.** Run `/code-review high` on the diff and **fix every confirmed
   finding** before proceeding. Re-verify after fixing. Commit inside the worktree once clean.
6. **Checkpoint — pause here.** Before any outward-facing, hard-to-undo step, stop and give the
   maintainer a concise summary (what changed, review outcome, files touched) and **wait for the
   go-ahead**. Do not merge, push, or close the issue until approved.
7. **On approval, land it:** merge the worktree branch into `main` with `--no-ff`, then
   `git push origin main` so the issue's referenced commits actually exist on GitHub. Clean up the
   worktree (remove the `node_modules` junction *before* `git worktree remove` — see
   `feedback-worktree-junction-cleanup`); leave other agents' worktrees alone.
8. **Comment, then close as completed.** Post a comment (`gh issue comment <id>`) describing *what*
   was done and *why* in plain user-facing terms. **Before posting, self-audit the drafted comment
   against these rules — the comment is world-readable and permanent:**

   - **No personally identifiable information about anyone — third parties *or* the maintainer.**
     Never include a real private email address, a real name tied to a private account, phone
     numbers, internal hostnames or IP addresses, or any third party's data. Use the GitHub
     `noreply` identity / the public `@BootBlock` handle / `example.com` placeholders only. (This
     is the [no-secrets](#no-secrets-in-the-repository-mandatory) and
     [public-hygiene](#public-repository-hygiene-mandatory) rules applied to the comment.)
   - **No internal development process, strategy, or tooling, and nothing an end user shouldn't
     see.** Keep out worktree / code-review / branch / merge mechanics, internal test or file-tool
     names, private tickets, CI/infra details, and the agent's own reasoning or strategy. Describe
     the *what* and *why* of the change, never the plumbing that produced it.
   - **High-level, durable public references are fine** (the repo is public): the affected
     feature, and optionally a commit SHA or a file link. Prefer these over process detail.
   - **Always append this exact trailer** as the last lines (agent attribution is disclosure, not
     internal process — it stays):

     ```markdown
     ---
     This issue was actioned by an agent on behalf of @BootBlock.
     ```

   Then `gh issue close <id> --repo BootBlock/Gubbins --reason completed`.

If any step can't be completed cleanly (the fix is larger than the issue implies, review surfaces
something structural, `main` conflicts non-trivially), stop and surface it rather than forcing the
workflow through — an issue URL authorises *this* workflow, not an unbounded change.
