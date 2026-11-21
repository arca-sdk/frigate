# Remote access relay

The relay is the hosted control plane behind Frigate's **Connect** remote access route
(see `docs/docs/configuration/remote_access.md`). It links Frigate servers to user
accounts and gives each linked Frigate a Cloudflare tunnel and a hostname. It is a
Cloudflare Worker with a D1 database, and people sign in with [Clerk](https://clerk.com).

The relay is not in the path of Frigate traffic. Browsers reach a Frigate through
Cloudflare's edge and that Frigate's tunnel; the relay only creates, repairs, and
removes tunnels.

```
Browser ──https──▶ Cloudflare edge ──tunnel──▶ cloudflared in Frigate ──▶ nginx :8971 (login required)
                         ▲
Frigate ──link, sync──▶ relay (this Worker) ──Cloudflare API──▶ tunnels and DNS records
Account owner ──Clerk session──▶ relay pages: approve links, list and remove Frigates
```

## How linking works

Linking follows the OAuth device authorization grant (RFC 8628):

1. Frigate asks for a link request with its name and the local origin its tunnel should
   forward to (`POST /v1/link-requests`). It gets a secret device code and a short user
   code such as `BCDF-GHJK`.
2. The admin opens `/link?code=BCDF-GHJK`, signs in, checks that the code matches the one
   Frigate shows, and approves it.
3. Frigate polls `POST /v1/link-requests/token` with its device code. After approval, the
   relay creates a remotely managed tunnel named `<prefix>-<instance id>`, points its
   ingress at the Frigate's origin, adds a proxied CNAME `<instance id>.<zone>` for it, and
   returns the hostname, the tunnel token, and an instance secret.
4. Frigate runs `cloudflared` with the token and uses the instance secret for later calls.

Afterwards Frigate calls `POST /v1/instance/sync` when it starts and when Cloudflare rejects
its connector. The sync repairs a tunnel that was deleted, follows a changed origin (for
example after TLS is turned off), and hands out a new token when the tunnel was replaced.
Every 30 minutes Frigate checks `GET /v1/instance`; a 401 means the instance was removed
and Frigate stops its connector.

Each step records the Cloudflare resources it created before moving on, so a request that
fails part way is resumed by the next poll or sync rather than duplicated. Setup and removal
of one instance take a short lease on it, so they never overlap: a removal that finds a setup
in progress revokes the instance's access at once and leaves its tunnel and hostname to the
scheduled job, which runs every 15 minutes, finishes removals that failed part way, and
cleans up links that were approved but never collected. Approved codes that have not been
collected yet count against the account's instance limit.

## Trust model

- **Frigate's login protects every instance.** Tunnels only reach the authenticated port,
  and Frigate refuses to link while its authentication is off. The relay never has a
  session on any Frigate.
- **The relay controls where a tunnel forwards.** Tunnels are remotely managed, so whoever
  holds the relay's Cloudflare token could point a Frigate's tunnel at another port on that
  Frigate's host. Treat the Cloudflare API token as the most sensitive secret here.
- **Secrets are stored hashed.** Device codes and instance secrets are 256-bit random values
  and only their SHA-256 digests are stored. Tunnel tokens are fetched from Cloudflare when
  needed and never stored by the relay.
- **Approval binds a Frigate to the approving account.** The approval page shows the
  Frigate's name and code, and codes expire after 10 minutes. As with any device flow,
  someone who tricks an admin into approving their code links their own server to that
  admin's account; it gains no access to the admin's Frigates.
- **Pages cannot be framed** (`X-Frame-Options: DENY`), so the approve button cannot be
  clickjacked, and Clerk session tokens issued for another origin are rejected.

## Before you deploy

- **Cloudflare's terms.** Frigate streams camera video and recordings through the tunnel.
  Cloudflare's Service-Specific Terms limit serving video and other large files through its
  CDN outside its paid media products. Review them for your plan, and how many users you
  expect, before offering this widely.
- **Abuse.** Any account can link a server, and each server gets a hostname under your zone.
  Someone could link a server that is not Frigate and host content under your domain.
  Restrict sign-ups in Clerk if this relay is not meant for the public, and see
  [removing an instance](#remove-an-instance) below.
- **Tunnel limits.** Cloudflare limits how many tunnels one account can have. Check your
  account's limit; `MAX_INSTANCES_PER_USER` caps each user.

## Deploy

You need a Cloudflare account with two zones (they can be the same zone, but a separate
one keeps user hostnames apart from your own site):

- an API zone for the relay itself, such as `relay.example.com`
- a tunnel zone for Frigate hostnames, such as `example-tunnels.net`. Hostnames are one
  label below it (`<16 characters>.example-tunnels.net`), which Cloudflare's Universal SSL
  certificate covers.

### 1. Clerk

1. Create a Clerk application and choose the sign-in methods you want.
2. For a production instance, finish Clerk's domain setup for the relay's domain.
3. Note the publishable key (`pk_...`) and secret key (`sk_...`).
4. To restrict who can link servers, use Clerk's allowlist or restricted sign-up mode.

The relay pages load Clerk's JavaScript from the Frontend API in the publishable key and
pass the session token to the relay, which verifies it with the secret key and checks it
was issued for the relay's origin.

### 2. Cloudflare API token

Create an API token with:

- **Account / Cloudflare Tunnel / Edit** for the account
- **Zone / DNS / Edit** for the tunnel zone

### 3. Configure and deploy the Worker

```sh
cd relay
npm ci
npx wrangler login
npx wrangler d1 create remote-access-relay   # paste the database_id into wrangler.jsonc
```

In `wrangler.jsonc`, set:

| Variable                 | Value                                                                    |
| ------------------------ | ------------------------------------------------------------------------ |
| `SERVICE_NAME`           | The name shown on the relay pages                                        |
| `PUBLIC_URL`             | The relay's own URL, such as `https://relay.example.com`                 |
| `TUNNEL_ZONE_NAME`       | The tunnel zone, such as `example-tunnels.net`                           |
| `CLOUDFLARE_ACCOUNT_ID`  | The account that owns the tunnels                                        |
| `CLOUDFLARE_ZONE_ID`     | The tunnel zone's ID                                                     |
| `CLERK_PUBLISHABLE_KEY`  | Clerk's publishable key                                                  |
| `TUNNEL_NAME_PREFIX`     | Prefix for tunnel names; use a different one per deployment in an account |
| `MAX_INSTANCES_PER_USER` | How many Frigate servers one account can link                            |

Add a route or custom domain for the Worker on the API zone, for example with
`"routes": [{ "pattern": "relay.example.com", "custom_domain": true }]`.

Then set the secrets and deploy. `npm run deploy` applies D1 migrations first:

```sh
npx wrangler secret put CLOUDFLARE_API_TOKEN
npx wrangler secret put CLERK_SECRET_KEY
npm run deploy
```

Until every setting is present the API answers `503 relay_not_configured`.

### 4. Point Frigate at the relay

Set `REMOTE_ACCESS_RELAY_URL` in `frigate/const.py` to the relay's `https` URL before
building the image, or set the `FRIGATE_REMOTE_ACCESS_RELAY_URL` environment variable on a
Frigate container. Frigate ignores a plain `http` URL unless it points at the same machine,
as with `wrangler dev`. Without a URL, Frigate shows Connect as unavailable and Tailscale
still works.

## Operate

### Remove an instance

Account owners remove their own servers on the relay's main page. To remove one yourself,
revoke it and let the scheduled job delete its tunnel and DNS record within 15 minutes:

```sh
npx wrangler d1 execute remote-access-relay --remote \
  --command "UPDATE instances SET state = 'deleting', secret_hash = NULL WHERE hostname = 'k3m9x2p4q7r8s5t6.example-tunnels.net'"
```

The Frigate notices at its next check and shows that it was removed.

### Logs

Workers observability is on in `wrangler.jsonc`. Failed Cloudflare calls are logged with
the instance id; secrets, tokens, and device codes never are.

## API reference

All bodies are JSON. Errors are `{"error": "<code>", "message": "<text>"}`.

| Route                                    | Caller           | Purpose                                                                 |
| ---------------------------------------- | ---------------- | ----------------------------------------------------------------------- |
| `GET /v1/info`                           | anyone           | Service name and Clerk settings for the pages                            |
| `POST /v1/link-requests`                 | Frigate          | `{name, origin: {scheme, host, port}}` → device code, user code, URLs    |
| `POST /v1/link-requests/token`           | Frigate          | `{device_code}` → credentials, or `authorization_pending`, `slow_down`, `access_denied`, `expired_token`, `provisioning_failed` |
| `GET /v1/link-requests/:code`            | signed-in user   | Name and status of a link request                                        |
| `POST /v1/link-requests/:code/approve`   | signed-in user   | Approve; `instance_limit_reached` at the account limit                    |
| `POST /v1/link-requests/:code/deny`      | signed-in user   | Decline                                                                  |
| `GET /v1/instance`                       | Frigate (secret) | The instance; 401 once it was removed                                    |
| `POST /v1/instance/sync`                 | Frigate (secret) | `{origin, name?, include_token?}` → repairs the tunnel, maybe a new token; `503 busy` while another change is in progress |
| `DELETE /v1/instance`                    | Frigate (secret) | Unlink and delete the tunnel and hostname                                |
| `GET /v1/me/instances`                   | signed-in user   | The account's instances with online status                               |
| `DELETE /v1/me/instances/:id`            | signed-in user   | Remove one                                                               |

Frigate authenticates with `Authorization: Bearer <instance id>.<secret>`; people with
`Authorization: Bearer <Clerk session token>`. The origin host must be an IP address; the
relay never resolves names on a Frigate's behalf.

## Develop

```sh
npm ci
npm test            # vitest in the Workers runtime, with D1
npm run typecheck   # generates worker-configuration.d.ts, then tsc
```

Tests use a real D1 database and replace only the Cloudflare API and Clerk, at the
interfaces in `src/cloudflare.ts` and `src/auth.ts`.
