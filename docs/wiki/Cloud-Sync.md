# Cloud sync

Use Gubbins on more than one device? **Cloud sync** keeps them in step — through storage **you
own and control**, not a Gubbins server. There is no Gubbins account and no Gubbins backend; sync
goes through *your* folder or *your* drive.

**Where to find it:** the **Sync** screen (in the menu, when the module is enabled).

![The Sync screen: connection providers, backup, and push-to-bridge](images/sync.png)

## Where sync happens

Gubbins is **provider-agnostic**. You choose where the shared copy lives:

- **A local folder** — via your browser's **File System Access**, sync through a folder that's
  itself synced by Dropbox, OneDrive, a NAS, or similar.
- **Google Drive** — a backend-less, in-browser sign-in that stores the data in an
  **app-private** folder on your own Drive.

Each device reads and writes the shared copy, so your inventory follows you between them.

## How conflicts are handled

When two devices change things independently, Gubbins reconciles **per item, per field** — not as
one big all-or-nothing overwrite. If you edit one thing on your phone while another device edits
something *else*, both changes are kept. It's **only** when the *same* field of the *same* thing is
changed on two devices before they sync that Gubbins has to pick one, and it does so with
**last-write-wins** — the most recent change prevails — so syncing is safe without you refereeing
every difference.

### Reviewing overwritten edits

Last-write-wins means one side's change to that same field is set aside. So you never lose that
work silently, Gubbins **notices** when an edit *you* made since your last sync is overwritten this
way and lists it for you.

When it happens, a **Conflicts** section appears on the Sync screen. Open **Review…** to see each
one side by side — your version next to the version that was kept — and choose:

- **Keep current** — accept the version that won; the note is cleared.
- **Use my version** — put *your* edit back. It syncs to your other devices on the next sync.

The same applies if another device **deleted** something you'd just edited: it's listed so you can
restore your version instead of losing it.

> **ℹ️ Note**
> This review list is **per device** — it shows the edits *this* device lost. Only genuine
> same-field clashes appear; a device simply catching up on newer changes is not a conflict and is
> never listed.

> **💡 Tip**
> The local-folder option is the most flexible: point it at any folder your existing cloud tool
> already syncs, and Gubbins rides on top of the service you already trust.

> **ℹ️ Note**
> Sync moves your data through storage *you* control. Gubbins never sees it — there's no server in
> the middle. The Google Drive option uses Google's own sign-in and stays within an app-private
> folder. See [[Privacy & security|Privacy-and-Security]].

## Sync vs backup

> **ℹ️ Note**
> **Sync** keeps devices *continuously* in step. A **[[backup|Backup-and-Restore]]** is a
> *point-in-time* copy you can restore from. They complement each other — sync for day-to-day,
> backups for safety and history.

## Related pages

- **[[Backup & restore|Backup-and-Restore]]** — point-in-time copies.
- **[[How your data is stored|How-Your-Data-Is-Stored]]** — the local-first model.
- **[[Storage triage|Storage-Triage]]** — keeping storage healthy.
