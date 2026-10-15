# Security

## One optional password, no accounts

Afflatus is made for one person on their own machine or home network. It has no accounts. Until you set a password (Settings › Interface › Access), **whoever can reach its port can use it**: your library, your settings, your linked folders and your GPU, through your ComfyUI.

With a password set:

- Every API route and the live event stream need a signed-in device, except the health probe (`/api/health`, which then says only that it is alive), the sign-in page's own routes, and the one-time address ComfyUI fetches a model download from (it carries its own token). The page's files are open: they hold no data. `/metrics` stays open for a scraper (counts, no library content).
- The password is kept as a salted scrypt hash; a device holds a random token in an HttpOnly, SameSite=Lax cookie (Secure over https), and the database only its SHA-256. A remembered device stays signed in for the days set (30 by default), another until 12 h without use.
- Wrong tries are limited per address (5, then a wait of 1, 5, then 15 minutes) and over all addresses at once (30 a minute: everyone waits a minute), so that a proxy that hides the addresses cannot be used to try a list.
- "From this computer" (on by default) lets requests from the machine itself in without the password: only from a loopback address, asked by a loopback name, carrying no forwarding header. A proxy on the same machine that sends neither (nginx's default) would count as this computer: turn the option off when you put one in front. In Docker nothing is exempt.
- A forgotten password is reset with a 6-digit code sent to Telegram or written to the console and `data/logs/afflatus.log` (valid 10 minutes, once, 5 wrong entries burn it). Without the page: `reset-password` (with Afflatus stopped) or `AFFLATUS_RESET_PASSWORD=1` at a start removes the password and every session.
- It protects the network side, not the files on the disk: those are your account's and your disk's to protect.

What it does to keep that boundary where you put it:

- It listens on `127.0.0.1` unless `HOST` says otherwise.
- It answers only to its own host names (loopback, `HOST`, the host of `PUBLIC_URL`, and `ALLOWED_HOSTS`). This stops DNS rebinding: a web page cannot point one of its names at your machine and drive Afflatus from your browser.
- It refuses writes from another site's page, a page on another port of the same machine included (ComfyUI's own page, where any custom node's script runs): every request that changes something must carry a JSON body, a file upload or Afflatus's own header, which a plain form cannot send, and one a browser says comes from another site, cross-site or same-site, is refused.
- It refuses reads from such a page too: a page elsewhere cannot make your browser run a backup, a scan or a whole library read. Only a link followed and an item's picture, video or sound shown in a page get through.
- No page may show Afflatus in a frame (`X-Frame-Options: DENY`, `frame-ancestors 'none'`): a click inside a frame would count as your own.
- Linked folders are limited to `LINK_ROOTS` once Afflatus listens on the network, and system folders are never linked.
- Nothing leaves your machine unless you turn on a download or a lookup.
- A download is fetched from the internet only: an address inside your network (this machine, ComfyUI's, your router, a cloud's metadata address) is refused, on every redirect too. A stand-in site allowed for the tests and the demo is allowed by its host and port, never the whole machine.
- The designer's stored API key goes only to the server it was typed for: pointing the language model at another address (another scheme, host or port) drops the key until you type it again.
- Releases are signed. A bundle installs an update only when the release's `SHA256SUMS.txt` carries a valid Ed25519 signature by the release key, whose public half is built into Afflatus (`apps/server/src/releaseKey.ts`; the private half is a secret of the release workflow, never in the repository), and when the archive's SHA-256 is the one that signed list gives. Anything else is refused before it is unpacked, and nothing changes. The new version is unpacked beside the running one and must pass its own start check before Afflatus switches to it. The key is part of the app: no setting or environment variable changes it.
- Updates are done only from the computer Afflatus runs on. Updating, going back to the previous version and bringing a 0.3.0 library over are accepted only from a loopback address, and never through a proxy that says whom it forwards for: other computers on your network see that a new version is out, and nothing more. The daily check for a new version is one request to GitHub with nothing about you in it; a switch in Settings → About turns it off.

What it does **not** do:

- It does not tell people apart. Anyone who can open the page (or knows the password) can do everything you can.
- It is not meant to face the internet. **Never publish it as it is.** If you want to reach it from outside, put a reverse proxy with its own authentication in front (an SSO proxy, basic auth, a VPN such as WireGuard or Tailscale), and name the proxy's host in `ALLOWED_HOSTS`.

## Supported versions

Only the latest release gets fixes. Afflatus is 0.x: update to the newest version before reporting.

## Reporting a vulnerability

Please report security problems **privately**, through GitHub's [private vulnerability reporting](https://github.com/bardak971/afflatus/security/advisories/new) (Security tab → Report a vulnerability). Do not open a public issue for them.

Useful to include: the version, how Afflatus was run (bundle, Docker, Helm, source; `HOST` and the other settings that matter), the steps to reproduce, and what an attacker gains.

Without a password set, "someone on my network can use Afflatus" is expected behaviour, not a vulnerability. In scope are, for example: a way past the password's lock or its try limits, a way past the host check or the cross-site checks, a way to make Afflatus install an update the release key did not sign, reading or writing files outside the data folder and the linked folders, running commands on the host, or a hostile workflow, preset or model file that does more than it should when imported.

This is a one-person project. Expect a first answer within a week, and a fix in a release as soon as it is ready; you will be credited in the release notes unless you would rather not be.
