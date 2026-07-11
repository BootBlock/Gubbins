# Cloud sync

Use Gubbins on more than one device? **Cloud sync** keeps them in step — through storage **you
own and control**, not a Gubbins server. There is no Gubbins account and no Gubbins backend; sync
goes through *your* folder or *your* drive.

**Where to find it:** the **Sync** screen (in the menu, when the module is enabled).

## Where sync happens

Gubbins is **provider-agnostic**. You choose where the shared copy lives:

- **A local folder** — via your browser's **File System Access**, sync through a folder that's
  itself synced by Dropbox, OneDrive, a NAS, or similar.
- **Google Drive** — a backend-less, in-browser sign-in that stores the data in an
  **app-private** folder on your own Drive.

Each device reads and writes the shared copy, so your inventory follows you between them.

## How conflicts are handled

When two devices change things independently, Gubbins reconciles with **last-write-wins** — the
most recent change to each piece of data prevails — so syncing is safe without you refereeing
every difference.

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
