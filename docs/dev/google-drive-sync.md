# Google Drive cloud sync

Gubbins can synchronise through **Google Drive** as a real cloud provider, alongside the
existing local-folder (File System Access) and in-memory providers. It plugs into the same
provider-agnostic `CloudProvider` engine (§7), so the conflict resolution, tombstones and
gauge Delta-CRDT are all unchanged — Drive is just where the versioned snapshot lives.

The whole sync payload is stored as a single JSON file, `gubbins-sync.json`, in Drive's
hidden, **app-private `appDataFolder`**. With the least-privilege `drive.appdata` scope,
Gubbins can see and touch *only* that folder — never any of your other Drive files.

> This is an **optional** feature. With no client id configured the Google Drive option is
> simply hidden and the rest of the app is unaffected.

## Why this design (backend-less, no SDK)

Gubbins is a static PWA (GitHub Pages) with no server, and §1.2 forbids bundling a cloud
SDK. So it uses the OAuth 2.0 **implicit flow** via a top-level redirect:

1. You click **Google Drive…**; the tab navigates to Google's consent screen.
2. Google redirects back to the app with a short-lived **access token in the URL fragment**
   (fragments are never sent to a server — the token stays on your device).
3. The app lifts the token out of the URL *before the router mounts*, stores it, and you are
   connected.

There is **no client secret** and **no token exchange**, so no backend is needed and no
Google JavaScript is loaded. The only network calls are `fetch`es to
`https://www.googleapis.com` (the Drive REST API), which is why the production
Content-Security-Policy adds exactly that one `connect-src` entry. The consent step is a
navigation, not a fetch, so it needs no CSP allowance.

### Known limitations (by design)

- **~1-hour sessions.** The implicit flow issues no refresh token, so when the access token
  expires the app shows a one-click **Reconnect Google Drive** prompt (a fresh consent
  redirect). This keeps the app backend-less. A persistent-session variant would require a
  server to hold the OAuth client secret and perform token exchange.
- **Token at rest.** The short-lived access token is stored device-local in `localStorage`
  (mirroring the existing Home-Assistant bridge token). It is never synced and is cleared on
  Disconnect. Treat the device as you would any signed-in session.
- **No profile/email scope.** Gubbins requests only `drive.appdata`, so the connection is
  labelled simply "Google Drive" — it never reads who you are.

## One-time setup (Google Cloud Console)

You need your own OAuth client id (it is public, not a secret — it ships in the client
bundle by design).

1. Go to the [Google Cloud Console](https://console.cloud.google.com/) and create (or pick)
   a project.
2. **APIs & Services → Library →** enable **Google Drive API**.
3. **APIs & Services → OAuth consent screen:** configure it (External is fine for personal
   use), and add your Google account under **Test users** while the app is in "Testing".
   Add the **`.../auth/drive.appdata`** scope.
4. **APIs & Services → Credentials → Create credentials → OAuth client ID:**
   - Application type: **Web application**.
   - **Authorised JavaScript origins:** your app origin(s), e.g.
     - `https://YOURNAME.github.io`
     - `http://localhost:5173`
   - **Authorised redirect URIs:** the app URL **including the `/Gubbins/` base and a
     trailing slash** (this must match `origin + import.meta.env.BASE_URL` exactly):
     - `https://YOURNAME.github.io/Gubbins/`
     - `http://localhost:5173/Gubbins/`
5. Copy the generated **Client ID**.

## Build configuration

Set the client id as a build-time environment variable (see `.env.example`):

```bash
# .env (git-ignored)
VITE_GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
```

- **Local dev:** `npm run dev` picks up `.env` automatically; the redirect URI resolves to
  `http://localhost:5173/Gubbins/`.
- **Production (GitHub Pages):** provide `VITE_GOOGLE_CLIENT_ID` to the build (e.g. a CI
  secret exposed to `vite build`). It is inlined at build time. The public deployment in
  this repository ships **without** a client id, so Google Drive is hidden there until a
  maintainer configures one — which is the correct posture for a public repo (no secrets in
  source).

## How to use

1. Open **Cloud Sync & backups** (the Sync screen).
2. Click **Google Drive…**, choose your account, and grant access.
3. You return to the Sync screen, connected. Click **Sync now** to exchange changes.
4. Repeat on your other devices (signed into the same Google account) — they reconcile
   through the same `appDataFolder` snapshot.
5. **Disconnect** stops syncing and clears the stored token; your local inventory and the
   Drive snapshot are left in place.

## Implementation map

| Concern | File |
| --- | --- |
| Public config (client id, scope, redirect URI) | `src/features/sync/providers/google-config.ts` |
| OAuth (pure parse/build + redirect/token glue) | `src/features/sync/providers/google-oauth.ts` |
| Drive REST client (`fetch`-based, no SDK) | `src/features/sync/providers/google-drive-api.ts` |
| `CloudProvider` adapter + connect/reconnect | `src/features/sync/providers/google-drive-provider.ts` |
| Redirect completion (runs before the router) | `src/main.tsx` |
| CSP `connect-src` allowance | `src/sw.ts` |
| Handshake UI | `src/features/sync/SyncScreen.tsx` |

The pure logic (URL building, fragment parsing, token validity, the REST request shapes) is
unit-tested with a fake `fetch`; only the thin redirect/storage glue touches the browser.
The OAuth flow itself can only be exercised against real Google servers, so it is **not**
covered by the headless smoke — which instead asserts the unconfigured-build state (the
button is present but disabled).
