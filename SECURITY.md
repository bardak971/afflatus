# Security

## One optional password, no accounts

Afflatus is made for one person on their own machine or home network. It has no accounts. Until you set a password (Settings › Interface › Access), **whoever can reach its port can use it**: your library, your settings, your linked folders and your GPU, through your ComfyUI.

With a password set:

- Every API route and the live event stream need a signed-in device, except the health probe (`/api/health`, which then says only that it is alive), the sign-in page's own routes (small JSON bodies only), and the one-time address ComfyUI fetches a model download from (it carries its own token). The page's files are open: they hold no data. `/metrics` needs a session or the metrics token made in Access, sent by Prometheus as a Bearer token. A stream whose session ends is closed within a minute.
- The password is kept as a salted scrypt hash; a device holds a random token in an HttpOnly, SameSite=Lax cookie (Secure over https), and the database only its SHA-256. Behind a TLS proxy on another machine, name that proxy's address in `TRUST_PROXY` (or set an https `PUBLIC_URL`): its `X-Forwarded-Proto` is then believed and the cookie is Secure; otherwise that header is believed only from this machine. A remembered device stays signed in for the days set (30 by default), another until 12 h without use.
- Wrong tries are limited per address (5, then a wait of 1, 5, then 15 minutes) and over all addresses at once (30 a minute: everyone waits a minute), so that a proxy that hides the addresses cannot be used to try a list. Checks run one at a time, so a burst sent at once is counted try by try. The trade-off: someone trying from many addresses, or anyone behind a shared proxy, can keep the owner's own sign-in waiting. Devices already signed in go on, and the owner is told on Telegram and in Settings › Access when it happens.
- "From this computer" lets requests from the machine itself in without the password. It is off by default and cannot be turned on while Afflatus listens on loopback only (the default `HOST`): then anyone reaching it from elsewhere comes through something on this computer that forwards connections (a port proxy, `ssh -R`, WSL's forwarding, a reverse proxy), which looks exactly like this computer. Listening on the network, it can be turned on; a request counts only from a loopback address, asked by a loopback name, with no forwarding header, but any forwarder or reverse proxy on the machine still makes every visitor look local. In Docker nothing is exempt.
- A forgotten password is reset with a code of 10 characters (Crockford's base32, some 50 bits, shown `K7M2P-9XQ4R`) sent to Telegram (in a group chat, every member sees it) or written to the console and `data/logs/afflatus.log`. A code is valid 10 minutes, once, and only in the browser that asked for it (a cookie of its own): a code typed elsewhere finds nothing, and nobody can spend or replace the owner's. At most 8 wait at once, and a waiting code is never put aside for a new one. Five wrong entries burn that browser's code; codes are limited per address, pause for 15 minutes after 20 wrong entries overall, and are refused for the rest of the day after 100 (the command line still resets). The owner is told on Telegram and in Access when more than 3 codes are asked for in an hour, or when any wrong code is entered.
- Telegram's bot and chat, where codes and alarms go, change only with a sign-in of the last 10 minutes or the password; once changed, no code goes to Telegram for 24 h, and the chat before is told. Without the page: `reset-password` (with Afflatus stopped) or `AFFLATUS_RESET_PASSWORD=1` at a start removes the password and every session.
- Changing the Access settings (From this computer, where codes go, the new-device notice, the metrics token) needs a sign-in of the last 10 minutes or the password.
- Cookies do not tell ports apart: another web app on the same host name (ComfyUI on another port, say) receives Afflatus's cookies and can set cookies Afflatus receives. The session cookie is HttpOnly, and a session cookie that comes twice is taken for none; still, prefer a host name of its own for Afflatus when it faces a network.
- It protects the network side, not the files on the disk: those are your account's and your disk's to protect.

What it does to keep that boundary where you put it:

- It listens on `127.0.0.1` unless `HOST` says otherwise.
- It answers only to its own host names (loopback, `HOST`, the host of `PUBLIC_URL`, and `ALLOWED_HOSTS`). This stops DNS rebinding: a web page cannot point one of its names at your machine and drive Afflatus from your browser.
- It refuses writes from another site's page, a page on another port of the same machine included (ComfyUI's own page, where any custom node's script runs): every request that changes something must carry a JSON body, a file upload or Afflatus's own header, which a plain form cannot send, and one a browser says comes from another site, cross-site or same-site, is refused.
- It refuses reads from such a page too: a page elsewhere cannot make your browser run a backup, a scan or a whole library read. Only a link followed and an item's picture, video or sound shown in a page get through.
- No page may show Afflatus in a frame (`X-Frame-Options: DENY`, `frame-ancestors 'none'`): a click inside a frame would count as your own.
- Linked folders are limited to `LINK_ROOTS` once Afflatus listens on the network or the request comes from another device (through a proxy or tunnel on the same machine too), and system folders are never linked.
- Nothing leaves your machine unless you turn on a download or a lookup.
- A download is fetched from the internet only: an address inside your network (this machine, ComfyUI's, your router, a cloud's metadata address, an IPv4 address written as IPv6) is refused, on every redirect too, and checked again on the address a name resolves to when the connection is made, so that a public name pointing inside your network is refused as well. A stand-in site allowed for the tests and the demo is allowed by its host and port, never the whole machine.
- A backup (Settings › Storage) leaves out the keys and tokens of the settings: the RunPod key, the Civitai and Hugging Face tokens, the language models' API keys, the ComfyUIs' lock tokens, the Telegram bot token and the Discord webhook. A backup with them is made only on the computer Afflatus runs on, as the lock token is copied there only.
- A ComfyUI locked by Afflatus's node pack refuses every call without its token, which Afflatus sends in a header, its websocket's included (never in an address, which a proxy in front may log). "No token needed from this PC" lets in a call from a loopback address, asked by a loopback name (not another site's name pointed at 127.0.0.1), through no proxy, and from no page but ComfyUI's own and Afflatus's: not a page another program serves on another port.
- A model name ComfyUI gives is read on the disk only inside its models folder: a name that leads out of it ("..", an absolute path) is not opened, nor hashed.
- The designer's stored API key goes only to the server it was typed for: pointing the language model at another address (another scheme, host or port) drops the key until you type it again.
- Releases are signed. A bundle installs an update only when the release's `SHA256SUMS.txt` carries a valid Ed25519 signature by the release key, whose public half is built into Afflatus (`apps/server/src/releaseKey.ts`; the private half is a secret of the release workflow, never in the repository), and when the archive's SHA-256 is the one that signed list gives. Anything else is refused before it is unpacked, and nothing changes. The new version is unpacked beside the running one and must pass its own start check before Afflatus switches to it. The key is part of the app: no setting or environment variable changes it.
- Updates are done only from the computer Afflatus runs on. Updating, going back to the previous version and bringing a 0.3.0 library over are accepted only from a loopback address, and never through a proxy that says whom it forwards for: other computers on your network see that a new version is out, and nothing more. The daily check for a new version is one request to GitHub with nothing about you in it; a switch in Settings → About turns it off.

Agents (MCP), at `/mcp` (see [docs/mcp.md](docs/mcp.md)):

- A client signs in with a personal token made in Settings › Interface › Access › Agents (MCP), shown once and kept as its SHA-256, with or without a password set: `/mcp` without a valid token answers 401. A token works on `/mcp` only, never on the API, `/metrics` or as a page's sign-in, and a page's session never works on `/mcp`. The host check and the refusal of other sites' pages apply to `/mcp` as to the rest.
- Each token has its scopes (Look; Make; Spend on rented GPUs, off unless ticked; Manage), renders an hour, a spend cap a month on top of the app's caps, an end, and an activity list of every call, refused ones included (kept 30 days). Making a token and changing its scopes, limits or end, or revoking it, need a sign-in of the last 10 minutes or the password.
- Never reached through MCP, whatever the scopes: the password, tokens, Lock, sign-outs, the Access settings, where codes go, adding a machine or changing a machine's address, secrets (said set or not, never read nor written), folders on the disk, Show in folder, erasing for good, Get ffmpeg, updates, ComfyUI restarts, and accepting a licence. No answer carries a path on the disk.
- An agent reads what it is shown and can be misled by it (a page, a model's description, a prompt in a picture). A workflow it imports waits for your Approve in Studio › Workflows, which names the nodes that read or write a path or fetch an address; a file it brings from an address is fetched as downloads are (the internet only), read only as a real picture, video or sound, one at a time and within a size and a daily budget.

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
