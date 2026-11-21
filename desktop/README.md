# Frigate desktop

An Electron app that opens Frigate servers in their own windows. It keeps a list of
servers, checks each one before saving it, and lets you trust a server's self-signed
certificate once instead of clicking through a warning on every visit.

The app doesn't contain a copy of Frigate's UI. Each window loads the UI from its server,
the same as a browser would, so:

- The UI always matches the server's version, however each server is upgraded.
- Nothing about Frigate's auth changes. The page, its API calls and its WebSockets stay on
  the server's origin, so the `SameSite=Lax` cookie and the CSRF check work as they do in
  a browser, and Frigate never has to answer cross-origin requests.
- Remote access works as is. A Connect or Tailscale address from Settings, Remote access
  is added like any other.

```
Server list (local page, preload bridge) ──IPC──▶ main process ──▶ servers.json
                                                      │
                                                      ├─ check: throwaway session ──▶ server
                                                      └─ window per server: persistent
                                                         session, no preload ──▶ server's UI
```

## Adding a server

An address without a scheme gets `https://` and Frigate's sign-in port, 8971, so
`frigate.local` becomes `https://frigate.local:8971/`. An address with a scheme keeps its
port, for servers behind a reverse proxy.

Before saving, the app asks the server two things as a signed-out visitor, in a session
that is thrown away afterwards:

1. `GET api/auth/first_time_login`, which Frigate answers without sign-in on every port.
   Anything else isn't Frigate.
2. `GET api/profile`. A 401 means sign-in is required. An answer as `anonymous` with the
   `admin` role means this is the internal port, which is refused even if it was moved off
   5000: it trusts every request as an admin. Any other user means auth is off; the server
   is saved with a "No sign-in required" badge.

Redirects aren't followed. When the same path moved to another address, such as `http://`
to `https://`, the app suggests that address instead.

Opening a saved server runs the same check first, and updates the sign-in badge and
certificate from the answer.

## Certificates

Frigate creates a self-signed certificate unless it's given one. When the system doesn't
trust a server's certificate, the app shows its SHA-256 fingerprint and asks. Trusting it
pins that exact certificate to that server's host: only certificates the system trusts, or
the pinned one, are accepted for the server, and the pin is never used for another host.

To compare the fingerprint with the server's certificate (the self-signed one lives in
`/config/tls`):

```
docker exec frigate openssl x509 -noout -fingerprint -sha256 -in /config/tls/fullchain.pem
```

When the certificate changes, the app stops and shows the new fingerprint with a warning
before trusting it. This is caught by the check before a window opens. If the certificate
changes while a window is open, that window's session has already turned it down, and
Chromium keeps that decision for the session until the app restarts, so the app asks for a
restart after you trust it.

## Server windows

- Each server has its own persistent session (`persist:server-<id>`), so sign-ins never mix.
  Removing a server deletes its session data.
- Server pages get no preload, no Node.js, and the Chromium sandbox.
- Windows stay on the server's origin. Links elsewhere open in the system browser, and pages
  the UI opens in a new tab get their own window. Sign-in through a proxy on another origin
  (Authelia and similar) isn't supported yet for that reason.
- Permissions are limited to the server's origin: fullscreen, writing to the clipboard, and
  the microphone for two-way talk. Notifications are denied, because the UI would try web
  push, which Electron doesn't support.
- When a window fails to load, it closes and the server list shows why.

## Develop

```
npm ci
npm start           # build and run
npm run typecheck
npm test            # unit tests
npm run e2e         # build, then drive the app against a stand-in Frigate
```

The end-to-end tests launch the real app with Playwright against a local HTTPS server that
has a self-signed certificate made the way Frigate makes one. `FRIGATE_DESKTOP_USER_DATA`
points the app at a throwaway profile. On Linux without a display, run them under
`xvfb-run`.

Not done yet: packaging and signing, auto-update, native notifications, and signing in to
the relay to list your servers.
