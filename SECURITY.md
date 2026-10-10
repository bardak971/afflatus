# Security

## There is no login, by design

Afflatus is made for one person on their own machine or home network. It has no accounts and no password: **whoever can reach its port can use it**. That means your library, your settings, your linked folders and your GPU, through your ComfyUI.

What it does to keep that boundary where you put it:

- It listens on `127.0.0.1` unless `HOST` says otherwise.
- It answers only to its own host names (loopback, `HOST`, the host of `PUBLIC_URL`, and `ALLOWED_HOSTS`). This stops DNS rebinding: a web page cannot point one of its names at your machine and drive Afflatus from your browser.
- It refuses cross-site writes: every request that changes something must carry a JSON body, a file upload or Afflatus's own header, which a plain form on another site cannot send.
- Linked folders are limited to `LINK_ROOTS` once Afflatus listens on the network, and system folders are never linked.
- Nothing leaves your machine unless you turn on a download or a lookup.

What it does **not** do:

- It does not tell people on your network apart. Anyone who can open the page can do everything you can.
- It is not meant to face the internet. **Never publish it as it is.** If you want to reach it from outside, put a reverse proxy with its own authentication in front (an SSO proxy, basic auth, a VPN such as WireGuard or Tailscale), and name the proxy's host in `ALLOWED_HOSTS`.

## Supported versions

Only the latest release gets fixes. Afflatus is 0.x: update to the newest version before reporting.

## Reporting a vulnerability

Please report security problems **privately**, through GitHub's [private vulnerability reporting](https://github.com/bardak971/afflatus/security/advisories/new) (Security tab → Report a vulnerability). Do not open a public issue for them.

Useful to include: the version, how Afflatus was run (bundle, Docker, Helm, source; `HOST` and the other settings that matter), the steps to reproduce, and what an attacker gains.

Since there is no login, "someone on my network can use Afflatus" is expected behaviour, not a vulnerability. In scope are, for example: a way past the host check or the cross-site write check, reading or writing files outside the data folder and the linked folders, running commands on the host, or a hostile workflow, preset or model file that does more than it should when imported.

This is a one-person project. Expect a first answer within a week, and a fix in a release as soon as it is ready; you will be credited in the release notes unless you would rather not be.
