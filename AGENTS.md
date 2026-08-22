# Agent instructions

This file is the cross-agent (AGENTS.md) entry point. The full working conventions live in
[CLAUDE.md](CLAUDE.md) — **read it before making changes.** This file is deliberately a pointer,
not a copy: it repeats in full only the rules whose cost of being missed is unrecoverable, and
links the rest.

## Mandatory rules — the complete list

Every rule below is mandatory. The first four are spelled out on this page; the rest are one
click away and are **equally binding** — "I only read AGENTS.md" is not a defence.

| Rule | Where |
| --- | --- |
| Work in a git worktree — **before your first edit** | 🌳 below |
| No secrets in the repository | 🔒 below |
| Public-repository hygiene | 🌐 below |
| Attribution on GitHub issues and PRs you write | ✍️ below |
| Design tokens, not hard-coded colour/motion values | [CLAUDE.md](CLAUDE.md#design-tokens-are-mandatory-where-one-exists) |
| Foundry primitives and spacing tokens — no hand-rolled controls | [CLAUDE.md](CLAUDE.md#controls--spacing-no-hand-rolled-bodges) |
| User-facing strings go through `t()`, translated in **every** catalog | [CLAUDE.md](CLAUDE.md#user-facing-strings-are-translated-i18n) |
| The wiki reflects user-facing changes, in the same change | [CLAUDE.md](CLAUDE.md#the-wiki-must-reflect-user-facing-changes-mandatory) |
| Plan docs under `docs/todo/` carry a status banner | [CLAUDE.md](CLAUDE.md#plan-docs-carry-a-status-docstodo) |
| Dependency changes go through `npm run lock` | [CLAUDE.md](CLAUDE.md#dependency-changes-go-through-npm-run-lock) |
| The GitHub issue workflow, end to end | [CLAUDE.md](CLAUDE.md#actioning-a-github-issue-workflow) |

**Adding a rule to CLAUDE.md? It belongs in that table too.** A unit test
(`src/lib/agent-guide-parity.test.ts`) fails the build if a CLAUDE.md section is missing from
this index, if a rule reproduced below drifts from its source, or if the counts above go stale —
this page fell a month behind once, and drift is not something review reliably catches.

## 🌳 Every task runs in a git worktree (mandatory)

**This rule gates your first action, which is why it is repeated here rather than only linked.**

Multiple agents edit this repo concurrently, so **every** task starts by creating a **new git
worktree** and doing all of its work there. This is not limited to issue work — it applies to
any task that touches repository content: code, tests, docs, wiki pages, plan docs, config.
Editing the primary checkout directly can destroy another agent's in-flight work.

- **The only exception is a task that touches no repo code at all** — e.g. filing a new GitHub
  issue, answering a question, reading/reviewing without editing, or a pure `gh` operation.
  Those may run in the primary checkout.
- Edit via worktree-relative absolute paths, never touch another agent's worktree, and expect
  `main` to have advanced while you worked.
- Merge back with `--no-ff`, then clean up: remove the `node_modules` junction **before**
  `git worktree remove`.
- Running the app or tests from a worktree is supported via the committed
  `vite.worktree.config.ts` / `vitest.worktree.config.ts`.

## 🔒 No secrets in the repository (mandatory)

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

## 🌐 Public-repository hygiene (mandatory)

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

## ✍️ Attribution on GitHub content (mandatory)

Anything **you** post or edit on GitHub on the maintainer's behalf must disclose that an agent
wrote it. This covers **every** issue and pull-request **comment**, and every issue/PR
**description or body** you author or edit. Attribution is disclosure, not internal process, so
it always stays — unlike the plumbing that must never leak (see above).

Append it as the **last lines**, after a `---` rule, wording the verb to match what you did
(`actioned` / `opened` / `updated`, and `pull request` in place of `issue`):

```markdown
---
This issue was actioned by an agent on behalf of @BootBlock.
```

Omit it only when GitHub gives you no body to sign (e.g. adding a label); if in doubt, include
it. This does **not** apply to git commit messages — those carry a `Co-Authored-By` trailer
instead. Full detail in
[CLAUDE.md](CLAUDE.md#agent-attribution-on-github-content-mandatory).

## ⚠️ Use design tokens, not hard-coded values

Every colour and motion value in the UI must come from a **design token**, never a raw hex /
`rgb()` / `oklch()` literal or an ad-hoc Tailwind palette class. See the full table and rules
in [CLAUDE.md](CLAUDE.md#design-tokens-are-mandatory-where-one-exists).
