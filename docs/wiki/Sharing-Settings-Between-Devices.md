# Sharing settings between devices

Cloud sync keeps your **inventory** in step across devices. It can keep your **settings** in step
too — your theme, units, thresholds, saved searches and so on — so a preference you change on one
device shows up on the others. It is **off by default**, and you choose which settings take part.

**Where to find it:** the **Sync** screen → **Shared settings**.

## Turning it on

Tick **Share settings between my devices**, then choose which groups of settings to share. The
groups are the same ones the [[backup picker|Backup-and-Restore]] uses, so *Appearance & theme*,
*Alerts & thresholds*, *Saved searches* and the rest are each in or out on their own.

Every device makes this choice **for itself**. That matters more than it might sound:

- A device with sharing **off** neither sends its settings nor takes anyone else's. It is completely
  unaffected — including a device that has never turned it on.
- A device can share *some* groups and not others. A tablet on the workshop bench can take your
  colour scheme and alert thresholds from the desktop while keeping its own dashboard layout and
  label template, simply by unticking those two groups.

> **💡 Tip**
> If a phone and a desktop want genuinely different layouts, that's what the per-group ticks are
> for — share *Appearance & theme* and untick *Dashboard*. You don't have to choose between all and
> nothing.

## Which settings can be shared

Nearly all of them. The exceptions are the ones that describe **one machine** rather than how you
like to work, and they are never shared however you set the ticks:

- the **bridge address** and its **access token** — the token is a secret and never travels
  anywhere, by any route;
- **kiosk mode** and the **connected scale** — properties of where a device is standing;
- **dismissed prompts** and **snooze reminders** — a note about what *this* device has already been
  told.

These live in the **This device** group, which the sharing picker does not offer at all. (A backup
*can* carry them if you deliberately tick it there — a one-off file is a different question from a
standing arrangement.)

## Turning it on for the first time

**The device you turn it on from publishes its current settings** on its next sync. So start from
whichever device already has things the way you want them, then turn it on elsewhere.

After that first exchange, the rule is the same one sync uses everywhere else: for each individual
setting, **the device that changed it most recently wins**. Because each setting is tracked
separately, changing your theme on a phone does not disturb a threshold you tuned on a desktop —
both changes survive.

> **ℹ️ Note**
> Settings travel on a **sync**, not instantly. Change something on one device, sync it, then sync
> the other, and the change lands. The Sync screen says how many settings it brought in.

## Turning it off again

Unticking a group — or the whole feature — stops this device **sending and taking** those settings
from that moment. It does not reach across to your other devices: they keep the settings they
already have, and any device still sharing carries on with the others.

What was already shared stays in the shared copy until some device changes it again. New
[[backups|Backup-and-Restore]] you make will not carry a group you've unticked in the backup
picker, so unticking there is what keeps a setting out of a file you intend to share with someone.

> **⚠️ Heads-up**
> Resetting **Dashboard layout** or **Saved searches** from [[Danger zone|Danger-Zone-Erasing-Data]]
> while you're sharing that group resets it on your other devices too, when they next sync — that's
> what sharing means. Turn sharing off first if you only meant to reset this one. Resetting **App
> preferences** is different: the sharing choice is itself one of the preferences it resets, so
> sharing simply switches off here and your other devices are left alone.

## If a setting doesn't arrive

- **Check both devices have the group ticked.** Receiving is opt-in just as sending is.
- **Check both have synced** since the change was made — one sync sends, the other receives.
- **A setting from a newer version of Gubbins is ignored** rather than applied, so an older device
  is never left with a value it can't use. Update it and the setting arrives.

## Related pages

- **[[Cloud sync|Cloud-Sync]]** — how devices meet, and how clashes are resolved.
- **[[Backup & restore|Backup-and-Restore]]** — moving settings through a file instead.
- **[[Appearance & theming|Appearance-and-Theming]]** — most of what the *Appearance* group covers.
- **[[Privacy & security|Privacy-and-Security]]** — what travels, and what never does.
