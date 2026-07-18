# About & diagnostics

The **About** screen tells you which version of Gubbins you're running, where to find the project
and its help, and — behind the **Diagnostics** panel — a summary of this device that's worth
attaching when you report a problem.

**Where to find it:** **Settings → App → About Gubbins**.

## What's on the About screen

| Section | What it tells you |
| --- | --- |
| **About Gubbins** | The **version** you're running and its **build date** — the two facts almost every support question needs. |
| **Project & support** | Links to this wiki, the source repository, and the issue tracker. |
| **Author** | Who makes Gubbins. |
| **Privacy** | The short version of the local-first promise — see [[Privacy & security\|Privacy-and-Security]]. |
| **AI-assisted development** | A note that AI tooling was used in building the app. |
| **Diagnostics** | A collapsible panel of environment details — see below. |
| **Licence & disclaimer** | Gubbins is MIT-licensed and provided "as is". |

> **ℹ️ Note**
> About is always available. Unlike most screens it can't be hidden in [[Modular UI|Modular-UI]],
> so the version number and the diagnostics stay reachable no matter how far you have pared the
> interface back.

## Diagnostics

Open the **Diagnostics** panel and press **Refresh** to gather a snapshot of this device and this
copy of Gubbins. It reports:

- **App** — version and build date.
- **Device & browser** — browser signature, platform, language, time zone, viewport and screen
  size, and whether you're **online**.
- **How it's running** — [[installed as an app or in a browser tab|Installing-Gubbins]], your
  [[colour scheme and background effect|Appearance-and-Theming]], and whether reduced motion is on.
- **Size of your data** — how many items, locations, projects, contacts, categories and tags you
  have, plus the storage used and the database size — headline totals that
  [[storage triage|Storage-Triage]] breaks down in detail.

Once gathered, two buttons appear:

- **Copy to clipboard** — the whole snapshot as text, ready to paste anywhere.
- **Open issue on GitHub** — starts a bug report with the snapshot already filled in. You still
  describe what went wrong before submitting.

### Reporting a problem

1. Reproduce the problem, or note exactly what you did.
2. Open **About → Diagnostics** and press **Refresh**.
3. Press **Open issue on GitHub**, then describe what you expected and what happened instead.

> **💡 Tip**
> Gather the diagnostics *after* the problem happens, in the same session. Details like viewport
> size, online state and storage headroom are captured at the moment you press **Refresh**, and
> those are often the ones that explain the fault.

### What diagnostics do *and don't* include

Diagnostics follow the same rules as the rest of Gubbins — see
[[Privacy & security|Privacy-and-Security]]:

- **Nothing is gathered automatically.** The panel is empty until you press **Refresh**, and the
  snapshot only exists on your device.
- **Nothing is sent anywhere on its own.** It leaves your device only if *you* copy it or open the
  pre-filled issue.
- **Your inventory is never included.** Only counts — "42 items" — never names, notes, photos,
  values or anything else you have entered.

> **⚠️ Heads-up**
> A GitHub issue is **public**. Gubbins reduces your time zone to a plain UTC offset in the
> pre-filled report so it doesn't narrow down where you are — but the text is still yours to
> review before you submit it.

## Related pages

- **[[FAQ & troubleshooting|FAQ-and-Troubleshooting]]** — try this first; many problems have a
  known answer.
- **[[Privacy & security|Privacy-and-Security]]** — what does and doesn't leave your device.
- **[[Storage triage|Storage-Triage]]** — the full breakdown behind the storage and database
  figures.
- **[[Installing Gubbins|Installing-Gubbins]]** — installing the app and granting persistent
  storage.
