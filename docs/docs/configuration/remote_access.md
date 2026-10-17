---
id: remote_access
title: Remote Access
---

import NavPath from "@site/src/components/NavPath";

# Remote Access

Remote access makes Frigate reachable from outside your home network without forwarding ports on your router or running your own reverse proxy. Open <NavPath path="Settings > Remote access" /> as an admin to set it up. There are two routes, and you can use either or both:

| Route         | Who can reach Frigate                            | What you need                                         |
| ------------- | ------------------------------------------------ | ----------------------------------------------------- |
| **Connect**   | Any browser, using a private `https` address     | An account on the remote access service               |
| **Tailscale** | Only devices signed in to your Tailscale tailnet | A [Tailscale](https://tailscale.com) account (free tier is fine) |

Both routes lead to Frigate's authenticated port (`8971` by default), so every remote visitor sees Frigate's login page and needs a Frigate account. Neither route ever exposes the unauthenticated internal port (`5000`).

## Before you start

- [Authentication](authentication.md) must be enabled. Connect refuses to start while it is turned off, because the address works from anywhere, and it stops at once if authentication is turned off later.
- Turn on [login failure rate limiting](authentication.md#login-failure-rate-limiting) and add `127.0.0.1/32` to `trusted_proxies`. Both routes reach Frigate from inside its container, so without that entry every remote visitor shares one address and the rate limit locks everyone out at once. With it, the limit applies to each visitor's real address.

```yaml
auth:
  failed_login_rate_limit: "1/second;5/minute;20/hour"
  trusted_proxies:
    - 127.0.0.1/32
```

## Connect

Connect gives Frigate an address such as `https://k3m9x2p4q7r8s5t6.example-tunnels.net`. Frigate runs Cloudflare's `cloudflared` connector, which keeps an outbound connection to Cloudflare open, so nothing needs to be opened on your router and it works behind carrier-grade NAT.

To set it up:

1. Go to <NavPath path="Settings > Remote access" />.
2. Under **Connect**, enter a name for this Frigate and select **Set up**.
3. Select **Open sign-in page**, sign in or create an account, and check that the page shows the same code as Frigate. Select **Link**.
4. Frigate finishes on its own within a few seconds and shows its address.

The link survives restarts and image updates; it is stored in `/config/.remote_access`. To stop using it, select **Turn off**. That removes this Frigate from your account and its address stops working. If you set it up again later, it gets a new address.

The **Manage account** link opens the remote access service's account page, which lists every Frigate linked to your account and lets you remove one even if it is offline. A Frigate that was removed from the account shows that on its Remote access page and raises a notice.

### How traffic flows

Browsers connect to Cloudflare, which forwards the request through the tunnel to Frigate. The remote access service only creates the tunnel and its address; it does not see or relay your video. Cloudflare terminates TLS for the address, so it can technically see the traffic, as with any Cloudflare-proxied site. If that is not acceptable for your cameras, use Tailscale instead.

### Live view over Connect

The tunnel carries HTTP and websockets, so MSE and jsmpeg live views, recordings, and the rest of the UI work normally. WebRTC needs a direct UDP path to go2rtc and does not pass through the tunnel, so keep live view on MSE (the default) when using Connect.

## Tailscale

The Tailscale route adds Frigate to your tailnet as its own device, named `frigate`, and shares it over `https` with [Tailscale Serve](https://tailscale.com/kb/1312/serve). Only devices signed in to your tailnet can reach it, and traffic is end-to-end encrypted between your device and Frigate.

To set it up:

1. Go to <NavPath path="Settings > Remote access" />.
2. Under **Tailscale**, select **Turn on**, then **Sign in to Tailscale**, and approve the device in the page that opens.
3. If your tailnet does not have HTTPS certificates enabled yet, Frigate shows **Turn on https**. Follow it and enable HTTPS for the tailnet.
4. Frigate shows its tailnet address, such as `https://frigate.tail1234.ts.net`.

Tailscale runs inside the Frigate container in userspace networking mode, so it needs no extra container privileges, devices, or ports. Its identity is stored in `/config/.remote_access/tailscale`, so it stays signed in across restarts.

- **Turn off** stops sharing Frigate and stops the Tailscale node, but keeps it signed in for next time.
- **Sign out of Tailscale** also signs the node out of your tailnet. Remove the old `frigate` machine from the Tailscale admin console afterwards if you no longer want it listed.

If you already run Tailscale on the host and prefer to use it, you can keep doing so with `tailscale serve` on the host as described in [advanced configuration](advanced/system.md#base-path); the built-in route is independent of it.

To reach Frigate over WebRTC through Tailscale, add Frigate's Tailscale address as a WebRTC candidate as described in [WebRTC extra configuration](live.md#webrtc-extra-configuration).

## Troubleshooting

| What you see                                                     | What to do                                                                                                                                 |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| "This Frigate has no remote access service configured."           | This build has no remote access service. Set `FRIGATE_REMOTE_ACCESS_RELAY_URL` to the service's URL, or use Tailscale.                       |
| "Could not reach the remote access service"                       | Check that Frigate's host can reach the internet, then try again.                                                                          |
| Connect shows **Not connected** with an error from Cloudflare      | Outbound connections to Cloudflare on port 7844 (UDP and TCP) may be blocked by a firewall. Frigate keeps retrying and requests a new tunnel if Cloudflare rejects the old one. |
| "This Frigate was removed from its remote access account"          | It was removed from the account page. Select **Set up again** to link it, or **Forget** to clear it.                                        |
| Tailscale stays on **Setting up https**                            | Enable HTTPS certificates for your tailnet in the Tailscale admin console under DNS. Frigate retries every minute.                          |
| Tailscale shows **Waiting for an admin of your tailnet to approve** | Your tailnet requires device approval. Approve the `frigate` machine in the Tailscale admin console.                                       |

Remote access logs to the Frigate log under `frigate.remote_access`. For more detail, set that logger to `debug` in the [logger settings](advanced/system.md#logging), which includes the output of `cloudflared` and `tailscaled`.
