# Contributing to Gubbins

Thanks for your interest in Gubbins. Bug reports, feature requests and ideas are genuinely
welcome — but please read the next section **before** you write any code, so you don't spend
effort on something that is unlikely to land.

Everyone taking part is expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Please open an issue, not a pull request

**Pull requests are unlikely to be accepted.** This is not a judgement on the quality of your
work — it is a consequence of what this project is and how it is developed.

Gubbins is a personal project before it is a community one. It is built for its maintainer's own
inventory and published in case anyone else finds it useful; it is not run as a collaborative
development effort and is not looking for co-maintainers. That is not a closed door — the ideas
you bring genuinely do shape it — but it does mean patches are not the currency here.

Gubbins moves at an extremely high rate of change. `main` advances continuously — often by
hundreds of commits in a single day — and much of the codebase is touched by work happening in
parallel. Development is heavily AI-assisted — but that does not mean code is merged unexamined:
landed work is audited from several independent angles and has to clear the automated gates that
guard `main`. See [AI-assisted development](README.md#ai-assisted-development) in the README for
what that involves. In practice the pace means:

- An external pull request goes stale very quickly — frequently before it can be reviewed.
- The area you changed has often already been rewritten, refactored, or reworked by in-flight
  work by the time the PR is looked at.
- Reconciling a divergent branch against a fast-moving `main` usually costs more than
  reimplementing the change directly.

So the most effective way to get something into Gubbins is **not** to send a patch. It is to
**describe what you want, and let it be implemented against the current state of the tree.**

If you open a PR anyway, expect it to be closed with thanks — and, where the underlying idea is
a good one, expect the change itself to be implemented separately and land on `main`. Being
closed is not a rejection of the idea.

## What is genuinely useful

These are the contributions that have the most impact here:

| You want to… | Do this |
| --- | --- |
| Report a bug | Open a [bug report](https://github.com/BootBlock/Gubbins/issues/new?template=bug_report.yml) |
| Suggest a feature or change | Open a [feature request](https://github.com/BootBlock/Gubbins/issues/new?template=feature_request.yml) |
| Ask a question or float an idea | Start a [discussion](https://github.com/BootBlock/Gubbins/discussions) |
| Report a security vulnerability | **Privately** — see [SECURITY.md](SECURITY.md) |

A good issue is worth far more than a patch. The more precisely a problem or a desired
behaviour is described, the faster and more accurately it can be implemented.

### Writing a good bug report

- **Check the latest build first.** Given the rate of change above, a bug you hit last week may
  already be fixed — retest on <https://bootblock.github.io/Gubbins/> before reporting. Only the
  latest `main` and the current deployed build are supported.
- What you did, what you expected, and what actually happened.
- The browser and OS, and whether you were using the optional bridge.
- The version or commit shown in the app, if you have it.
- A screenshot, if the problem is visual.
- **Never** paste real personal data, credentials, or a real backup file into an issue — this
  repository and its issues are public and permanent. Redact, or use invented sample data.

### Writing a good feature request

- The problem you're trying to solve, not just the solution you have in mind.
- How you'd use it in practice — a concrete example of your own inventory or workflow helps a
  great deal.
- Whether it's a gap in something that exists, or something entirely new.

## Reporting security issues

Please **do not** open a public issue for a security vulnerability. Use GitHub's private
vulnerability reporting — the full process is in [SECURITY.md](SECURITY.md).

## Running Gubbins locally

You do not need to run Gubbins locally to file a good issue — the hosted build at
<https://bootblock.github.io/Gubbins/> is enough for most reports. If you do want to run it from
source, see the **Development** section of the [README](README.md) for the quick start, the
launcher options, and the Node version requirements (the test suites need a newer Node than the
build does).

## If you do send a pull request anyway

That's your call — the repository is public and MIT-licensed, and forking is entirely
welcome. But please be aware of the above, and keep it small and self-contained if you do:

- One focused change. Large or sweeping PRs have essentially no chance of landing.
- Follow the conventions already in the tree — design tokens rather than raw colour values,
  translated strings through the `t()` seam, Foundry primitives rather than hand-rolled
  controls, and accessibility wired up. The [pull request template](.github/pull_request_template.md)
  lists the checks.
- No secrets, credentials, or personal data in the diff — see the note in the bug-report
  section above; it applies doubly to code.
- `npm run type-check` and the relevant tests should pass.

## Forking

Gubbins is [MIT-licensed](LICENSE). You are free to fork it, change it, and run your own
version — no permission needed. If the direction you want differs from the direction here, a
fork is a perfectly good outcome and not something to feel awkward about.

## Licence

By contributing, you agree that your contributions are licensed under the
[MIT Licence](LICENSE), the same terms as the rest of the project.
