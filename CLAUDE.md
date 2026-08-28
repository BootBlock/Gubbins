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

## Agent attribution on GitHub content (mandatory)

Anything **you** post or edit on GitHub on the maintainer's behalf must carry an attribution
trailer disclosing that an agent wrote it for @BootBlock. This applies to **every** GitHub
issue and pull-request **comment** *and* every issue/PR **description or body** you author or
edit — not just issues you action end-to-end. Attribution is disclosure, not internal process,
so it always stays (unlike the process/plumbing that must never leak — see
[public-repository hygiene](#public-repository-hygiene-mandatory)).

Append it as the **last lines**, after a `---` rule, wording the verb to match what you did:

```markdown
---
This <issue|pull request> was <actioned|opened|updated> by an agent on behalf of @BootBlock.
```

- **Comment on an issue you actioned end-to-end** → keep the exact wording the issue workflow
  uses: `This issue was actioned by an agent on behalf of @BootBlock.`
- **Issue/PR you opened** → use `opened`; a **body you edited** → `updated`; a **pull request**
  → `pull request` in place of `issue`.

The only time to omit it is when GitHub gives you no body to sign (e.g. adding a label). If in
doubt, include it. This does **not** apply to git commit messages — those carry the
`Co-Authored-By` trailer instead.

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

## The wiki must reflect user-facing changes (mandatory)

Gubbins has a user-facing **wiki** — staged in-repo under [docs/wiki](docs/wiki) and published
to the `BootBlock/Gubbins.wiki` repo. It documents every feature, concept, option and setting
for end users (plus the Bridge / Home Assistant integration surface). The taxonomy, page map and
house style live in [docs/todo/wiki_2026-07-11.md](docs/todo/wiki_2026-07-11.md) — the single
source of truth for what the wiki covers.

**Publishing is automatic — never hand-copy pages to the wiki repo.** `docs/wiki/` is the source
of truth; `.github/workflows/publish-wiki.yml` mirrors it to the wiki whenever a change lands on
`main`. Editing the wiki directly on GitHub is overwritten by the next publish. Run
`npm run wiki:check` to verify links and images resolve before pushing (CI runs it too); the
mechanics are in §7 of the plan doc.

**The rule — the same discipline as design tokens and i18n:** when a change **adds, removes or
alters anything a user sees or configures** — a feature, screen, capability, setting, option,
concept, or a piece of behaviour the wiki describes — the corresponding wiki page(s) under
`docs/wiki/` **must** be updated in the *same* change. A feature is not "done" until the wiki
reflects it.

- **New feature/screen/capability/setting** → add or update the relevant page, and add it to the
  page map in `docs/todo/wiki_2026-07-11.md` if it's a new topic. Where a screenshot would help,
  regenerate it (see below) rather than describing the UI in prose alone.
- **Changed behaviour, labels or options** → update the affected page(s) so the copy still
  matches the app; refresh any screenshot that now shows stale UI.
- **Removed feature** → remove or revise the page and its sidebar entry so the wiki never
  documents something that no longer exists.
- **Screenshots are generated, not hand-taken.** Run `node scripts/wiki-screenshots.mjs` against
  a running dev server (`npm run dev`) to (re)capture the cropped images into `docs/wiki/images/`.
  All sample data must stay **synthetic** (invented names, `example.com`) per the
  [public-repository hygiene](#public-repository-hygiene-mandatory) rule — never seed a screenshot
  with real people or data. Add a new capture step to that script when a new page needs an image.
- **House style:** every page follows the conventions in the plan doc — a one-line summary, a
  "where to find it" pointer, cropped screenshots with alt text, `> **💡 Tip** / **ℹ️ Note** /
  **⚠️ Heads-up**` box-outs where they genuinely help, and `[[Page-Name]]` cross-links. Keep it
  plain, user-facing and neutral — **no internal process, plumbing or agent detail** (the wiki is
  world-readable, exactly like the repo).

If a change is purely internal (refactor, tests, build) with **no** user-visible surface, the
wiki needs no update — the trigger is a change to what the user sees or does, not to the code.

## A "mirrors X" comment is a request for a test

Prose cannot hold two definitions together. A docstring saying a value, predicate, map or string
**mirrors**, **matches**, **is identical to** or **must stay in sync with** something elsewhere is
a promise the compiler does not check, the reader cannot verify, and the next edit quietly breaks —
and the drift is silent by construction, because the comment still reads as though it were true.
Issues #143, #156 and #254 were all this one habit.

**The rule — when you write, or find, a comment claiming parity between two definitions, do one of
these three things, in this order of preference:**

1. **Delete one of them.** Derive the second from the first so there is only one definition. The
   claim becomes true by construction and nothing can drift.
2. **Give the weaker seam the signal it is missing.** Where the two genuinely cannot share a
   definition — a TypeScript guard beside a SQL `CHECK`, a pure predicate beside a query — the
   usual cause is that one side lacks a fact the other has. Add it, then apply rule 1 or 3.
3. **Write the drift test the comment is asking for**, and name it in the comment so a reader can
   find what holds the claim up. Prefer driving *both* sides and comparing behaviour over
   comparing their source text: assert the same verdict from the guard and the real `CHECK`
   (`src/db/repositories/item/normalise-db-check.test.ts`), the same watermark from both write
   paths (`src/features/danger-zone/history-watermark-parity.test.ts`), or that every topic a
   discovery payload names is one the publisher actually publishes
   (`bridge/src/mqtt/publisher.test.ts`).

A parity test earns its place by *failing* when the claim is broken, so check that it does — mutate
one side and watch it go red before you commit. What it must never be is a restatement of the
comment in `expect()` form.

## Plan docs carry a status (`docs/todo/`)

The plan, backlog and audit documents in [docs/todo](docs/todo) are long-lived and
world-readable, and a **finished** plan reads exactly like a live one unless it says so. That is
how stale guidance gets followed — someone picks up a recipe from a plan that shipped months ago.

**The rule:** every `.md` under `docs/todo/` opens with a status banner directly after its
heading, and finished work is archived:

```markdown
> **Status:** 🟢 ACTIVE — open backlog; phases 1–2 shipped, phase 3 next.
```

- **`🟢 ACTIVE`** / **`📘 REFERENCE`** stay in `docs/todo/`; **`✅ COMPLETE`** / **`⛔ SUPERSEDED`**
  move to `docs/todo/done/`. The full definitions live in
  [docs/todo/README.md](docs/todo/README.md).
- **When an effort finishes, flip the banner and `git mv` it into `done/` in the same change.**
  Grep for inbound links first — `docs/dev/deferred-features.md` and `docs/dev/PHASE_HANDOVER.md`
  reference these plans by path — and update them, or the move strands them.
- **Never restate a plan doc's history to match current practice.** A past-tense record of what a
  phase actually ran is evidence; rewriting it to name today's command asserts something that
  never happened. Correct *live instructions*, and let records stand.
- A unit test (`src/lib/docs-todo-status.test.ts`) enforces the banner and the placement, so drift
  fails the build rather than review. It can't judge whether "COMPLETE" is *true* — that's yours.

## Dependency changes go through `npm run lock`

`npm install` on Windows writes a `package-lock.json` that `npm ci` then refuses, so the change
passes locally and fails every CI job with an error that names neither the cause nor the culprit:

```
npm error Missing: @emnapi/wasi-threads@1.2.3 from lock file
npm error Missing: tslib@2.8.1 from lock file
```

The cause is `@tailwindcss/oxide-wasm32-wasi`, one of the per-platform binaries `@tailwindcss/oxide`
fans out to. It declares `cpu: ["wasm32"]`, so npm on an x64 host skips it and drops its private
`@emnapi/*` entries while leaving the requirement on them in place. The same npm also strips the
`libc` markers that separate a glibc build of a native package from a musl one. Neither `--cpu`,
`--os`, `--include=optional` nor `--force` avoids it — the lockfile has to be produced on Linux.

**The rule — after any change to `package.json`'s dependencies, run `npm run lock`.** It re-resolves
the lockfile in a Linux container (Docker must be running), reseeding from the *committed* lockfile
so a bare `npm install` that already degraded the working copy is repaired rather than carried
forward, and then verifies the result with `npm ci --dry-run`. `npm run lock:check` verifies without
writing. Commit the lockfile it produces; never hand-edit one.

CI needs no extra wiring — its own `npm ci` is the same gate. The point of running it locally is to
fail in one command rather than in five red jobs.

## Every task runs in a worktree, and parallelises with sub-agents (mandatory)

Multiple agents edit this repo concurrently, so **every** task starts by creating a **new git
worktree** and doing all of its work there. This is not limited to issue work — it applies to
any task that touches repository content: code, tests, docs, wiki pages, plan docs, config.

- **The only exception is a task that touches no repo code at all** — e.g. filing a new GitHub
  issue, answering a question, reading/reviewing without editing, or a pure `gh` operation.
  Those may run in the primary checkout.
- Edit via worktree-relative absolute paths, never touch another agent's worktree, and expect
  `main` to have advanced while you worked.
- Merge back with `--no-ff`, then clean up: remove the `node_modules` junction **before**
  `git worktree remove` (see `feedback-worktree-junction-cleanup`).
- Running the app or tests from a worktree is supported via the committed
  `vite.worktree.config.ts` / `vitest.worktree.config.ts`.

**Use sub-agents where applicable to speed the work up.** When a task decomposes into
independent pieces — surveying several areas of the codebase, investigating parallel
hypotheses, or implementing changes that don't share files — dispatch them concurrently rather
than working serially. Keep to one agent per independent unit, give each enough context to
work without re-deriving what you already know, and reserve serial work for steps that
genuinely depend on an earlier result.

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
4. **Verify it works.** Typecheck with `npm run type-check` — **not** `npx tsc -b`, which builds the
   app project only and skips the bridge's separate tsconfig entirely. Run any tests the change
   touches; where the change has a runtime surface, drive it (the `verify` skill) rather than
   trusting types alone. If the change reaches anything the bridge imports (`bridge/**`, and much of
   `src/db` and the search/backup modules), also run `npm run smoke:bridge` — it is the only check
   that exercises Node's strip-only loader, which `tsc` and Vitest both bypass.
5. **Self-review, commit, then run `/auto-review high`.** Do a thorough **manual** self-review of the
   diff, fix what you find, and re-verify. Format the changed files (`npm run format`, or
   `npx prettier --write <files>`) so the pre-commit hook doesn't bounce the commit, and commit inside
   the worktree once clean. Then **run the custom `/auto-review high` skill** on the committed diff via
   the Skill tool — it **is** model-invocable, unlike the bundled `/code-review`, which the agent
   cannot call (`disable-model-invocation` + not on the Skill-tool allowlist). `/auto-review` reviews
   the working-tree diff against `main` with the same high-signal, find→validate rubric as
   `/code-review` (it is a maintained duplicate of the public source — see the memory note
   `auto-review-skill`), and it is the **mandated review gate** for issue work. Fix every confirmed
   finding and re-verify after each fix, committing the fixes.
6. **Do _not_ pause — land autonomously once `/auto-review high` is clean.** Once the change is
   implemented, verified, committed, and the step-5 `/auto-review high` pass has run with every
   confirmed finding fixed and re-verified, proceed **directly** to the landing mechanics below. Do
   **not** stop and hand off for a maintainer to run `/code-review` — the agent now runs the mandated
   review itself via `/auto-review high`, so there is no approval gate to wait on, and you must not
   repurpose `AskUserQuestion` as one. The *only* reason to stop is a genuine, specific question about
   *this* change — a real design or scope fork, a destructive or ambiguous choice, or something that
   can't be completed cleanly (see the note at the end of this list) — which you raise via
   `AskUserQuestion`.
7. **Landing mechanics — _only after_ the step-5 `/auto-review high` pass has run and every confirmed
   finding is fixed and re-verified:** merge the worktree branch into `main` with `--no-ff`, then
   `git push origin main` so the issue's referenced commits actually exist on GitHub. Clean up the
   worktree (remove the `node_modules` junction *before* `git worktree remove` — see
   `feedback-worktree-junction-cleanup`); leave other agents' worktrees alone. If you arrive here
   without that review having happened, go back to step 5 — do not merge.
8. **Comment, then close as completed** (only once the change has actually landed via step 7).
   Post a comment (`gh issue comment <id>`) describing *what* was done and *why* in plain
   user-facing terms. **Before posting, self-audit the drafted comment
   against these rules — the comment is world-readable and permanent:**

   - **Match your voice to who filed it — check the issue's author.** When the author is
     **@BootBlock**, that's the project's developer and maintainer, not an end user: write
     peer-to-peer. Don't thank them "for the report" and don't explain the feature back to them as
     if introducing it — state plainly what changed and why. For an issue filed by anyone else, a
     brief, neutral acknowledgement is fine. (The attribution trailer below stays regardless of who
     filed it.)
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

   **Then reconcile the issue's labels before closing.** The labels should describe what the
   change *actually* turned out to be, not what was assumed when it was filed. Using only the
   repo's existing label set, add any that now clearly apply (an area label such as `ui` /
   `bridge` / `schema`, or `bug` vs `enhancement` if the nature shifted) and remove any that no
   longer fit — `gh issue edit <id> --repo BootBlock/Gubbins --add-label <name> --remove-label
   <name>`. Don't invent new labels as part of closing; if the right label genuinely doesn't
   exist yet, note it rather than forcing a poor fit.

   Then `gh issue close <id> --repo BootBlock/Gubbins --reason completed`.

If any step can't be completed cleanly (the fix is larger than the issue implies, review surfaces
something structural, `main` conflicts non-trivially), stop and surface it rather than forcing the
workflow through — an issue URL authorises *this* workflow, not an unbounded change.

### Multi-line text goes through a file, not inline quoting

Multi-line commit messages, PR bodies, and issue/PR comments must be passed via a **file**, not
inline shell quoting: write the text to a file, then `git commit -F <file>` and
`gh … --body-file <file>`. Inline quoting for multi-line text is error-prone — a wrong here-string
delimiter can silently wrap the whole message in stray characters, and by the time it reaches a
pushed commit or a posted comment it is expensive or impossible to fix cleanly. A file sidesteps all
shell-quoting rules regardless of which shell runs the command.
