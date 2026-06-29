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
  dependency surface minimal. This repo ships as `UNLICENSED` (all rights reserved) — don't
  add headers or text implying a different licence.
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
