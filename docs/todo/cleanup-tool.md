# Disk cleanup tool — specification

> **Status:** 🟢 ACTIVE — design notes for a **separate** application; nothing here ships as part of Gubbins.

A small Windows utility — **C# 14 / .NET 10 / WinUI 3** — that finds and reclaims wasted disk space
on a developer workstation, with a safety model good enough to trust unattended.

> **Scope note.** This is **not a Gubbins feature** and shares no code with it — different language,
> different runtime, different repository. The document lives here only because the findings below
> were gathered while working in this repository, and would otherwise be lost.
>
> **It is staged to move.** When the tool gets its own repository this file moves there wholesale and
> is deleted from `docs/todo/`. Nothing in Gubbins links to it, so the move strands nothing; note
> only that `docs/todo/` carries a status-banner convention enforced by a unit test, which this
> document satisfies while it is here and will not need once it leaves.

---

## 1. Why

Windows' built-in Disk Cleanup and Storage Sense understand Windows' own caches. They know nothing
about the things that actually fill a developer's drive: package manager caches, toolchain
downloads, per-workspace editor state, container disk images, IntelliSense databases. Those are the
bulk of the waste, and each needs its own knowledge to clear safely.

The evidence below comes from auditing one real workstation (Windows 11, ~330 GB system drive) that
had reached **5.6 GB free**. Targeted cleanup of three package-manager caches recovered **22.9 GB**
in a few minutes, without touching a single piece of user data.

---

## 2. Goals and non-goals

**Goals**

- Attribute disk usage to a *named cause*, not just a path — "Gradle build cache", not `~\.gradle`.
- Classify every candidate by how safe it is to delete, and be explicit about what "safe" means.
- Prefer a tool's own eviction command over deleting its folder.
- Never delete without a preview, and never delete something irreplaceable without saying so.
- Be fast enough to scan a full drive without the user walking away.

**Non-goals**

- Not a general file manager, duplicate finder, or uninstaller.
- No automatic/scheduled deletion in v1. Nothing is removed without explicit confirmation.
- Not a Windows component cleaner — `WinSxS` and `Windows\Installer` are deliberately out of scope
  (see §6).

---

## 3. The core model: safety tiers

Everything the tool knows about is one of four kinds. **This distinction is the product** — the
sizes are easy to compute, the classification is the part that takes knowledge.

| Tier | Meaning | Deletion consequence | Default |
| --- | --- | --- | --- |
| **1 — Regenerable cache** | Content that a tool re-creates on demand, byte-for-byte or equivalently. | A slower next build. Nothing is lost. | Offered, pre-selected |
| **2 — Regenerable, with cost** | Re-created, but only by re-downloading gigabytes or re-indexing for minutes. | Time and bandwidth. | Offered, not pre-selected |
| **3 — User data** | Logs, histories, saved sessions. Looks like cache, *is not*. | **Gone permanently.** | Shown, never pre-selected, explicit warning |
| **4 — Do not touch** | Config, credentials, live application state, anything the tool cannot prove is idle. | Breakage. | Excluded from the UI entirely |

### The mistake this model exists to prevent

During the audit, ~11 GB of VS Code `workspaceStorage` was initially classified as cache. It is
mostly **AI chat session history** (`chatSessions`, `chatEditingSessions`) — a permanent record of
past conversations, sitting in a directory whose name and location strongly suggest "cache".

Nothing about its path, size or shape distinguishes it from genuinely disposable state. Only
knowing what the subfolder *contains* does. **A size-ranked directory list would have recommended
deleting it, and the user would have silently lost months of history.** Tier 3 exists because that
class of error is invisible until it is irreversible.

---

## 4. Evidence: what actually consumed the space

Observed on one workstation; sizes will vary, but the *shape* generalises. Paths use
`%USERPROFILE%` / `%LOCALAPPDATA%` conventions.

### 4.1 Verified reclaimed — Tier 1 (this cleanup: 22.9 GB)

| Source | Observed | Correct reclaim method | Notes |
| --- | --- | --- | --- |
| NuGet global packages + HTTP cache | ~10 GB | `dotnet nuget locals all --clear` | Also clears `v3-cache`, plugins cache and `NuGetScratch` — more than deleting `.nuget\packages` alone |
| Gradle caches + wrapper distributions | ~7 GB | Delete `.gradle\caches`, `.gradle\wrapper` | **Not** the whole `.gradle` folder — see §5.2 |
| npm cache | ~2.4 GB | `npm cache clean --force` | |

### 4.2 Strong candidates — Tier 1/2, not yet actioned

| Source | Observed | Tier | Notes |
| --- | --- | --- | --- |
| `%LOCALAPPDATA%\Microsoft\vscode-cpptools` | 6.0 GB | 1 | C++ IntelliSense databases; rebuilt on next open |
| `%LOCALAPPDATA%\Android` | 6.7 GB | 2 | SDK platforms + emulator images. Huge re-download; only offer if the toolchain looks unused |
| `%USERPROFILE%\.platformio` | 5.7 GB | 2 | Embedded toolchains; same reasoning |
| `%USERPROFILE%\.cache` | 3.8 GB | 1 | Mixed tool caches; needs per-subfolder rules |
| `%LOCALAPPDATA%\uv` | 3.5 GB | 1 | Python (uv) package cache |
| `%LOCALAPPDATA%\Temp`, `C:\Windows\Temp` | 5.4 GB | 1 | See §5.3 — needs exclusions and an age filter |
| Docker build cache | ~0.9 GB | 1 | `docker builder prune`; see §5.4 for the VHDX trap |

### 4.3 Tier 3 — user data wearing a cache costume

| Source | Observed | What it really is |
| --- | --- | --- |
| `%APPDATA%\Code\User\workspaceStorage` | 11.3 GB | Per-workspace editor state, **dominated by AI chat history**. Largest single workspace ~4 GB, of which ~3.3 GB was `chatSessions` |
| `%APPDATA%\Code\User\History` | 1.1 GB | Local file history (an undo record) |
| Agent/assistant session directories | ~1.7 GB | Conversation history and persistent memory. Deleting loses context permanently |

Per-workspace folders can be pruned individually, which makes a good UI: list workspaces by size
and last-modified, let the user drop dormant ones and keep recent ones. The last-modified date is
the single most useful signal here.

### 4.4 Tier 4 / out of scope

| Source | Observed | Why excluded |
| --- | --- | --- |
| `C:\Windows\WinSxS` | 16.1 GB | Never safe to delete manually. Only `DISM /StartComponentCleanup` may touch it, and `/ResetBase` blocks update rollback |
| `C:\Windows\Installer` | 12.5 GB | Orphaned MSI patches. Deleting the wrong file breaks repair *and* uninstall, permanently |
| `C:\ProgramData\Package Cache` | 6.7 GB | Visual Studio installer cache; removing breaks repair/modify |
| `pagefile.sys` | 5.0 GB | System-managed |
| Application VM disk images (e.g. `*.vhdx` under a packaged app) | 8.1 GB | Live application state |

---

## 5. Hard-won rules

These are the findings that cost the most to learn. Each should be a design constraint, not a
guideline.

### 5.1 Prefer the tool's own eviction command

`dotnet nuget locals all --clear` cleared four separate locations, two of which were not under
`.nuget` at all. A path-based cleaner would have missed ~3 GB. Where a package manager offers an
official cache command, call it and parse the result; fall back to path deletion only when none
exists.

### 5.2 Config lives next to cache — target subfolders, never roots

- `%USERPROFILE%\.gradle` contains `caches` and `wrapper` (disposable) alongside
  `gradle.properties` (user config, **may contain signing keys and credentials**).
- `%USERPROFILE%\.nuget` may contain `NuGet.Config` beside the `packages` cache. On the audited
  machine the config lived in `%APPDATA%\NuGet` instead — **so its location cannot be assumed**;
  probe both.

Rule: **never delete a tool's root directory.** Enumerate known-disposable children explicitly, and
treat anything unrecognised as Tier 4.

### 5.3 Temp is not free real estate

Blanket-clearing `%LOCALAPPDATA%\Temp` is the classic mistake. Observed: an active agent session
held 344 MB of live working files there, and 34 editor processes plus 4 Node processes held open
handles. Requirements:

- Exclude paths belonging to running processes.
- Apply an age filter (default: older than 7 days) rather than deleting everything.
- Treat "access denied" as normal and skip silently — a locked file is the OS protecting live state.

### 5.4 Freeing space inside a virtual disk does not free it on the host

Docker's `docker_data.vhdx` grows but never shrinks on its own. `docker system prune` frees space
*inside* the image while the host file stays the same size. Reclaiming it needs a separate compact
step (`Optimize-VHD`, or the vendor's own disk-cleanup). **Report the two numbers separately** or
the user will prune, see no change, and lose trust in the tool.

### 5.5 Recursive enumeration is too slow to be the scanner

Measuring a handful of profile subtrees with naive recursive directory enumeration **exceeded a
10-minute timeout** during this audit. A full-drive scan on that basis is unusable. The scanner
must:

- Read the **NTFS Master File Table** directly (or the USN journal) rather than walking directories.
- Fall back to parallel enumeration with a bounded worker pool only where MFT access is unavailable.
- Cache results with invalidation, so re-opening the tool is instant.
- Stream partial results to the UI — never block on a complete scan.

### 5.6 Verify the negative after acting

After deleting, assert that the things that should have survived *did*: config files, protected
directories, live session state. The audit confirmed six such paths explicitly. This is cheap and
turns "I think it worked" into evidence — and it catches an over-broad rule on the first run rather
than the hundredth.

---

## 6. Platform and architecture

### 6.1 Toolchain (decided)

| Choice | Value |
| --- | --- |
| Language | **C# 14** |
| Runtime | **.NET 10** (LTS) |
| UI framework | **WinUI 3**, via the Windows App SDK |
| Target framework | `net10.0-windows10.0.19041.0` (both projects) |
| Deployment | **Unpackaged** — see the note below |
| Minimum OS | Windows 10 1809 / Windows 11 |

`LangVersion` needs no explicit setting: the .NET 10 SDK defaults to C# 14. Pin it only if a
future SDK bump must not silently change language semantics.

`Cleanup.Core` stays free of any UI dependency, but still targets `net10.0-windows` rather than
plain `net10.0` — the scanner P/Invokes Win32 for MFT access, so there is no meaningful portable
subset to preserve. It is testable as an ordinary class library.

### 6.2 Project layout

```
Cleanup.Core/          ← no UI dependency; unit-testable
  Scanning/            MFT reader, size aggregation, cancellation
  Providers/           one class per known cache (NuGet, Gradle, npm, Docker, VS Code, …)
  Safety/              tier classification, process/lock detection, exclusion rules
  Execution/           dry-run planner, executor, post-verification
Cleanup.App/           ← WinUI 3 shell, MVVM over Core
```

**Provider model.** Each source implements a common contract:

```csharp
interface ICleanupProvider {
    string Name { get; }               // "Gradle build cache"
    SafetyTier Tier { get; }
    Task<bool> IsPresentAsync();
    Task<long> EstimateBytesAsync(CancellationToken ct);
    Task<CleanupPlan> PlanAsync(CancellationToken ct);   // exact paths / command, never executed here
    Task<CleanupResult> ExecuteAsync(CleanupPlan plan, IProgress<double> p, CancellationToken ct);
    Task<VerificationResult> VerifyAsync(CleanupPlan plan);  // §5.6 — assert survivors
}
```

Adding support for a new cache is then one class plus tests, and the safety model applies uniformly.

### 6.3 Platform notes

- WinUI 3 is fine for this, but **unpackaged** deployment is simpler here: a packaged app runs
  virtualised against `%LOCALAPPDATA%` in ways that complicate reading other apps' caches.
- Ship **self-contained** rather than framework-dependent. A disk-cleanup tool is exactly the thing
  someone reaches for on a machine that is too full to install a runtime, so requiring a separate
  .NET 10 install would defeat it at the moment of need. (NativeAOT is not an option — WinUI 3 does
  not support it.)
- MFT reading requires **administrator**; the app should run unelevated by default, scan what it
  can, and request elevation only for the fast scanner and for `C:\Windows\Temp`.
- Enable **long path** support (`\\?\` prefixes or the manifest opt-in). Node and NuGet trees
  routinely exceed `MAX_PATH`, and this is the most likely source of silent partial deletions.
- Deletion should be genuinely parallel — these trees are hundreds of thousands of small files, and
  wall-clock time is dominated by per-file overhead, not bytes.

---

## 7. UX principles

- **Group by cause, sort by size, colour by tier.** The first screen answers "what is eating my
  disk", not "what folders exist".
- **Every row states what happens on next use**: "re-downloads on next build (~10 GB)" is more
  useful than a checkbox.
- **Tier 3 requires typed confirmation**, and says plainly what is unrecoverable.
- **Dry run is the default action.** The primary button previews; deleting is the second step.
- **Show free space before and after**, prominently. It is the only number the user came for.
- **Age is a first-class column** for per-workspace and per-project data — "last touched 5 months
  ago" drives the decision more than size does.

---

## 8. Open questions

1. **Detecting an unused toolchain.** Android SDK and PlatformIO are 12 GB combined and pure waste
   *if* idle. Last-access times are unreliable on NTFS by default — is there a better signal?
2. **Per-workspace attribution for editor state.** `workspaceStorage` folders are opaque hashes;
   the mapping to a real path lives in each folder's `workspace.json`. Worth confirming this is
   stable across editor versions before depending on it.
3. **Should Tier 2 re-download estimates be measured or declared?** Showing "≈10 GB to restore"
   changes decisions, but measuring it accurately is hard.
4. **Undo.** Probably genuinely impossible for these sizes — Recycle Bin is not viable at 10 GB.
   If so, say so in the UI rather than implying reversibility.

---

## 9. Deliberately excluded

Windows component cleanup (`WinSxS`, `Windows\Installer`, installer package caches). These are
large and tempting — ~35 GB on the audited machine — but the failure modes are severe (broken
uninstall, unbootable rollback) and the safe operations are already exposed by `DISM` and the
vendors' own tooling. A tool that is trusted for developer caches should not stake that trust on
Windows servicing internals.
