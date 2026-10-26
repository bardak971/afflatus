"""A lock on this ComfyUI: once set, every route of its server needs this machine's token.

ComfyUI has no login of its own. One reachable from other machines (`--listen`, a rented instance) runs whatever is
sent to it, and ComfyUI-Manager installs whatever it is asked to: in 2026 a botnet took ComfyUIs left open on the
internet that way. Locked, the server answers nothing to a caller without the token, ComfyUI-Manager's routes and the
websocket included.

Nothing is locked until Afflatus (or the instance's start settings) locks it: installing or updating the pack leaves a
ComfyUI open as it was. The lock is kept as the token's hash in `afflatus-lock.json`, in ComfyUI's user folder (never the
token itself), read again whenever the file changes, so locking, renewing and unlocking need no restart.

Three ways in:
  - `Authorization: Bearer <token>`, which Afflatus sends on every call;
  - `?token=<token>` on /ws only, for a WebSocket that cannot carry a header (a browser's; Afflatus before 0.5.0): an
    address can end up in the logs of a proxy in front, so Afflatus now sends the header on its socket too;
  - the `afflatus_lock_<port>` cookie the login page sets: a value made from the token, never the token, HttpOnly and
    SameSite=Lax; and taken only from ComfyUI's own page (below). It names the login it was given to: one opened from
    Afflatus is that Afflatus sign-in's, and holds while Afflatus says that sign-in does (below); one made by pasting the
    token holds as long as the token. SameSite does not tell ports apart: a page served by any other
    program of the same computer (localhost:3000) is the "same site" as localhost:8188, and its browser would send the
    cookie with a request of that page's own (a plain-text POST to /prompt needs no preflight). So the cookie counts only
    on a request the browser says is same-origin (Sec-Fetch-Site), or one whose Origin is ComfyUI's own address.
And, when the lock says so ("no token needed from this PC"), a call made on this computer: from a loopback address,
through no proxy (a proxy on the same machine would make the whole internet "this computer"), to a loopback name (a
name of another site's that resolves to 127.0.0.1 would make a page of that site "this computer": DNS rebinding), and
not sent by a page of another origin: a page open in this computer's browser calls from loopback too, whatever served
it, so only ComfyUI's own page and Afflatus's (the address it locked from) count, not one of another program on
another port of the same computer.

A login opened from Afflatus (Open ComfyUI) is tied to the Afflatus sign-in that asked for it: signing that device out,
Sign out everywhere, a new password, or the sign-in's own end ends its ComfyUI login too. ComfyUI cannot ask Afflatus (a
rented pod does not reach the computer Afflatus runs on), so Afflatus tells it: the logins still good, sent with each
login code, at each sign-out, and every minute (POST /afflatus/logins), kept in `afflatus-logins.json` next to the lock.
A login Afflatus has not named for LEASE_S is refused: a sign-out Afflatus could not tell (ComfyUI did not answer then,
and Afflatus stopped before it could) ends by that time at the latest, and with Afflatus away for longer, ComfyUI's page
asks for a login again (Open ComfyUI from Afflatus, or the token). Refusing is the safe side: a login that holds while
nobody can say whether its sign-in still does is what this is here to end.

Routes (a JSON body only, which a page of another site cannot send without asking first):
  GET  /afflatus/lock    → {locked, local, fixed}
  POST /afflatus/lock    {token, local, origin?}  → locks with this token (the first lock: anyone; after: only through
                               the lock); `origin` is Afflatus's page (http://localhost:8721), let in by "from this PC"
  POST /afflatus/unlock  → opens it again
  POST /afflatus/login-code  {login?, keep?}  → {code}: a one-time code for /afflatus/login?code=, a minute long, so that
                               Afflatus can open ComfyUI's page logged in without the token ever being in an address;
                               the login it gives is `login`'s (one of `keep`, the logins still good); with none (an
                               Afflatus before 0.7.1), the token's
  POST /afflatus/logins  {keep}  → the logins still good, all others ended (Afflatus's sign-ins, as ids made from them)
  GET  /afflatus/login[?code=&next=], POST /afflatus/login (a form with the token)  → the login page; `next`, a path of
                               this server, is where a login lands (a workflow Afflatus opened in ComfyUI)

Ways out, when the lock itself is the problem: delete `afflatus-lock.json` from ComfyUI's user folder, or start ComfyUI
with AFFLATUS_LOCK=off. AFFLATUS_TOKEN=<token> locks it from its start (a rented instance's template): such a lock
cannot be changed or taken off through the routes.
"""

import hashlib
import hmac
import html
import ipaddress
import json
import os
import secrets
import threading
import time
import urllib.parse

LOCK_FILE = "afflatus-lock.json"
# a token is what Afflatus makes (43 characters of base64url); a value far longer or shorter is no token of its
MIN_TOKEN, MAX_TOKEN = 16, 200
CODE_S = 60
LOGINS_FILE = "afflatus-logins.json"
# Afflatus names the logins still good every minute: one it has not named for this long is refused
LEASE_S = 600
# a login's id, as Afflatus makes it (an HMAC of its sign-in under the token, cut to 128 bits); "token" is the login made
# by pasting the token, which holds as long as the token does
LOGIN_ID_LEN = 32
TOKEN_LOGIN = "token"
MAX_LOGINS = 2000
LOGIN = "/afflatus/login"
# the routes of this module, reached through the lock like any other (the lock's own state tells nothing to a stranger)
PROXY_HEADERS = ("X-Forwarded-For", "X-Forwarded-Host", "X-Real-IP", "Forwarded", "CF-Connecting-IP")


def hash_of(token):
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def cookie_of(digest, login):
    """The cookie's value: the login it was given to, and a MAC of it under the token's hash, so the cookie never holds the
    token, no one makes one for another login, and a new token ends them all."""
    mac = hmac.new(digest.encode("ascii"), f"afflatus-lock-login:{login}".encode("ascii"), hashlib.sha256).hexdigest()
    return f"{login}.{mac}"


def login_id_ok(login):
    return isinstance(login, str) and len(login) == LOGIN_ID_LEN and all(c in "0123456789abcdef" for c in login)


def login_of(value, digest):
    """The login a cookie names, when its MAC holds under this token; else None."""
    if not isinstance(value, str) or len(value) > 120:
        return None
    login = value.partition(".")[0]
    if login != TOKEN_LOGIN and not login_id_ok(login):
        return None
    return login if same(value, cookie_of(digest, login)) else None


def same(a, b):
    return isinstance(a, str) and isinstance(b, str) and hmac.compare_digest(a.encode("utf-8"), b.encode("utf-8"))


def token_ok(token):
    return isinstance(token, str) and MIN_TOKEN <= len(token) <= MAX_TOKEN and token.isascii() and token.isprintable() and " " not in token


def loopback(address):
    try:
        return ipaddress.ip_address((address or "").split("%")[0]).is_loopback
    except ValueError:
        return False


def loopback_name(host):
    """Whether a host (a Host header's, with its port, or an address's) names this computer: localhost or a loopback address."""
    try:
        name = urllib.parse.urlsplit("//" + (host or "")).hostname or ""
    except ValueError:
        return False
    return name == "localhost" or loopback(name)


def origin_ok(origin):
    """An origin as Afflatus sends it: http or https, a host and maybe a port, no path; lower-cased. None for anything else."""
    if not isinstance(origin, str) or len(origin) > 200:
        return None
    try:
        at = urllib.parse.urlsplit(origin.strip().lower())
    except ValueError:
        return None
    if at.scheme not in ("http", "https") or not at.netloc or at.path not in ("", "/") or at.query or at.fragment or "@" in at.netloc:
        return None
    return f"{at.scheme}://{at.netloc}"


class Lock:
    """The lock's state: from the environment (fixed), else from the file in the user folder, read again when it changes."""

    def __init__(self, folder, env=None):
        env = os.environ if env is None else env
        self.path = os.path.join(folder, LOCK_FILE)
        self.off = (env.get("AFFLATUS_LOCK") or "").strip().lower() == "off"
        token = (env.get("AFFLATUS_TOKEN") or "").strip()
        # a fixed token that is not one (the reference to a RunPod secret left as it is, a secret deleted, too short) locks
        # with nothing that opens it: never the reference's text as the key, which anyone who reads the pod's settings knows
        if token and not token_ok(token):
            print("[afflatus-nodes] AFFLATUS_TOKEN is not a token Afflatus makes: ComfyUI is locked, and nothing opens it.")
            token = None
            self.fixed = {"hash": "!", "local": False} if not self.off else None
        else:
            self.fixed = {"hash": hash_of(token), "local": False} if token and not self.off else None
        self._seen = None
        self._state = None
        self._mutex = threading.Lock()
        self._codes = {}
        self.logins_path = os.path.join(folder, LOGINS_FILE)
        self._keep, self._heard, self._written = self._read_logins()

    def _read_logins(self):
        """The logins Afflatus last named and when, as kept across a restart of ComfyUI: none when the file does not read."""
        try:
            with open(self.logins_path, encoding="utf-8") as f:
                got = json.load(f)
            keep = {x for x in got.get("keep", []) if login_id_ok(x)}
            at = float(got.get("at", 0))
            return keep, at, at
        except (OSError, ValueError, TypeError, AttributeError):
            return set(), 0.0, 0.0

    def keep(self, logins, now=None):
        """The logins still good, as Afflatus names them: every other one ends at once. Written down when they change, and
        every LEASE_S / 4 besides, so that a ComfyUI started again finds them still named."""
        now = time.time() if now is None else now
        keep = set(logins)
        with self._mutex:
            changed = keep != self._keep
            self._keep, self._heard = keep, now
            if changed or now - self._written >= LEASE_S / 4:
                try:
                    os.makedirs(os.path.dirname(self.logins_path), exist_ok=True)
                    part = self.logins_path + ".part"
                    with open(part, "w", encoding="utf-8") as f:
                        json.dump({"keep": sorted(keep), "at": now}, f)
                    os.replace(part, self.logins_path)
                    self._written = now
                except OSError:
                    # held in memory all the same: a user folder that cannot be written only loses them at a restart
                    pass

    def login_ok(self, login, now=None):
        """Whether a login holds: the token's always (while the token does); one of Afflatus's while it is named, and named
        lately (LEASE_S)."""
        if login == TOKEN_LOGIN:
            return True
        now = time.time() if now is None else now
        return login in self._keep and now - self._heard < LEASE_S

    def state(self):
        """{hash, local} when locked, else None."""
        if self.off:
            return None
        if self.fixed:
            return self.fixed
        try:
            st = os.stat(self.path)
            seen = (st.st_mtime_ns, st.st_size)
        except OSError:
            self._seen, self._state = None, None
            return None
        if seen != self._seen:
            try:
                with open(self.path, encoding="utf-8") as f:
                    got = json.load(f)
                digest = got.get("hash") if isinstance(got, dict) else None
                # a file that does not read as a lock locks it all the same: it was meant to, and opening it would be the wrong guess
                self._state = {
                    "hash": digest if isinstance(digest, str) and len(digest) == 64 else "!",
                    "local": bool(got.get("local")) if isinstance(got, dict) else False,
                    "origin": origin_ok(got.get("origin")) if isinstance(got, dict) else None,
                }
            except (OSError, ValueError):
                self._state = {"hash": "!", "local": False}
            self._seen = seen
        return self._state

    def write(self, token, local, origin=None):
        with self._mutex:
            os.makedirs(os.path.dirname(self.path), exist_ok=True)
            part = self.path + ".part"
            with open(part, "w", encoding="utf-8") as f:
                json.dump({"hash": hash_of(token), "local": bool(local), "origin": origin_ok(origin), "at": int(time.time())}, f)
            os.replace(part, self.path)
            # the new state in force at once, not when state() sees the file change: a renew of the same size within one
            # tick of a coarse clock (FAT, exFAT, some network shares) leaves (mtime, size) as they were, and the old
            # token would stay good
            st = os.stat(self.path)
            self._state = {"hash": hash_of(token), "local": bool(local), "origin": origin_ok(origin)}
            self._seen = (st.st_mtime_ns, st.st_size)
            self._codes.clear()
        # a new token makes every login's id and cookie anew: the ones named under the old token name nothing now
        self.keep([])

    def remove(self):
        with self._mutex:
            try:
                os.remove(self.path)
            except FileNotFoundError:
                pass
            self._seen, self._state = None, None
            self._codes.clear()
        self.keep([])

    def code(self, login=TOKEN_LOGIN, now=None):
        """A one-time code for the login page, giving `login` (the token's when Afflatus names none)."""
        now = time.time() if now is None else now
        with self._mutex:
            self._codes = {c: t for c, t in self._codes.items() if t[0] > now}
            code = secrets.token_urlsafe(24)
            self._codes[code] = (now + CODE_S, login)
            return code

    def use_code(self, code, now=None):
        """The login a code gives, once and within its minute; else None."""
        now = time.time() if now is None else now
        with self._mutex:
            got = self._codes.pop(code, None) if isinstance(code, str) else None
            return got[1] if got is not None and got[0] > now else None


def cookie_name(request):
    port = request.url.port or (443 if request.scheme == "https" else 80)
    return f"afflatus_lock_{port}"


def own_page(request):
    """Whether a request comes from ComfyUI's own page (or the address bar), not from a page of another origin. The
    browser says which (Sec-Fetch-Site); without that, the Origin must be ComfyUI's own host and port; a caller that sends
    neither is no page at all (a script with the cookie has what the cookie gives anyway)."""
    site = request.headers.get("Sec-Fetch-Site")
    if site is not None:
        return site in ("same-origin", "none")
    origin = request.headers.get("Origin")
    if not origin:
        return True
    # the host and port only: a proxy in front (RunPod's) takes https and speaks http here
    return origin != "null" and (urllib.parse.urlsplit(origin).netloc or "").lower() == (request.host or "").lower()


def let_in(request, state, login_ok):
    """Whether a request gets through the lock: by the token, the login cookie (from ComfyUI's own page only, and while its
    login holds: `login_ok`), or (said so) as a call from this computer."""
    digest = state["hash"]
    auth = request.headers.get("Authorization", "")
    if auth[:7].lower() == "bearer " and same(hash_of(auth[7:].strip()), digest):
        return True
    if request.path == "/ws" and same(hash_of(request.rel_url.query.get("token", "")), digest):
        return True
    login = login_of(request.cookies.get(cookie_name(request)), digest)
    if login is not None and own_page(request) and login_ok(login):
        return True
    return bool(state.get("local")) and from_this_pc(request, state.get("origin"))


def from_this_pc(request, afflatus=None):
    """A call made on this computer, by a program of its own or by ComfyUI's page or Afflatus's (`afflatus`, the origin the
    lock was made from): never by a page another program serves on another port, nor one reached by another site's name."""
    if not loopback(request.remote):
        return False
    if any(h in request.headers for h in PROXY_HEADERS):
        return False
    # the name the caller asked for: a site whose name resolves to 127.0.0.1 has its own name here, not localhost
    if not loopback_name(request.host):
        return False
    site = request.headers.get("Sec-Fetch-Site")
    if site == "cross-site":
        return False
    origin = request.headers.get("Origin")
    if origin is None:
        # a program (a browser says one or the other), the address bar, ComfyUI's own page; a page of another port of this
        # computer is "same-site" and sends no Origin with a plain GET: not let in on the say of a page nobody named
        return site != "same-site"
    if origin == "null":
        return False
    said = origin_ok(origin)
    # ComfyUI's own page by its host and port (a proxy in front may take https and speak http here), or Afflatus's
    return said is not None and (urllib.parse.urlsplit(said).netloc == (request.host or "").lower() or said == afflatus)


PAGE = """<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ComfyUI is locked</title><style>
body{{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#202020;color:#ececec;font:14px system-ui,sans-serif}}
form{{width:300px;background:#2a2a2a;border:1px solid #3a3a3a;border-radius:10px;padding:22px;display:flex;flex-direction:column;gap:12px}}
.i{{width:34px;height:34px;border-radius:9px;background:#2a1a14;color:#f5916a;display:flex;align-items:center;justify-content:center}}
b{{font-size:15px}}p{{margin:0;color:#9a9a9a;font-size:13px;line-height:1.45}}.e{{color:#ef6a6a}}
input{{padding:9px 11px;border-radius:8px;border:1px solid #3a3a3a;background:#1b1b1b;color:#ececec;font:12px ui-monospace,monospace}}
button{{padding:9px;border:none;border-radius:8px;background:#f5916a;color:#1a0a04;font:600 13px system-ui,sans-serif;cursor:pointer}}
</style></head><body><form method="post" action="{login}">
<span class="i"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg></span>
<b>This ComfyUI is locked</b><p>Locked by Afflatus. Open it from Afflatus, or paste its token.</p>{error}
<input name="token" type="password" placeholder="Token" autocomplete="off" autofocus aria-label="Token">
<button type="submit">Open</button></form></body></html>"""


def page(web, error=""):
    said = f'<p class="e">{html.escape(error)}</p>' if error else ""
    return web.Response(text=PAGE.format(login=LOGIN, error=said), content_type="text/html", headers={"Cache-Control": "no-store"})


def to(web, where):
    """A redirect answered, not raised: what a middleware gives back the same way on every aiohttp."""
    return web.Response(status=302, headers={"Location": where, "Cache-Control": "no-store"})


def landing(request):
    """Where a login lands: `next` when it is a path of this server (never another site's address), else ComfyUI's page."""
    want = request.rel_url.query.get("next", "/")
    return want if want.startswith("/") and not want.startswith("//") and "\\" not in want else "/"


ONWARD = """<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="refresh" content="0;url={url}">
<title>ComfyUI</title></head><body style="background:#202020"><script>location.replace({js})</script></body></html>"""


def logged_in(web, request, state, login):
    """The cookie set, and on to ComfyUI's page from a page of ComfyUI's own: a redirect would go on in the name of the page
    that sent the browser here (Afflatus's), and the cookie, taken only from ComfyUI's own page, would not count."""
    where = landing(request)
    res = web.Response(text=ONWARD.format(url=html.escape(where, quote=True), js=json.dumps(where).replace("<", "\\u003c")), content_type="text/html", headers={"Cache-Control": "no-store"})
    res.set_cookie(cookie_name(request), cookie_of(state["hash"], login), httponly=True, samesite="Lax", path="/", secure=request.scheme == "https")
    return res


def make_middleware(lock, web):
    @web.middleware
    async def afflatus_lock(request, handler):
        state = lock.state()
        if state is None:
            if request.path == LOGIN:
                return to(web, "/")
            return await handler(request)
        if request.path == LOGIN:
            return await login(request, state)
        if let_in(request, state, lock.login_ok):
            return await handler(request)
        # a person opening ComfyUI's page lands on the login; anything else is told it is locked, and by whom
        if request.method == "GET" and request.path == "/" and "text/html" in request.headers.get("Accept", ""):
            return to(web, LOGIN)
        return web.json_response({"error": "locked", "by": "afflatus", "message": "This ComfyUI is locked by Afflatus: it needs its token."}, status=401, headers={"X-Afflatus-Lock": "on"})

    async def login(request, state):
        if request.method == "GET":
            code = request.rel_url.query.get("code")
            if code is None:
                return page(web)
            login = lock.use_code(code)
            if login is not None:
                return logged_in(web, request, state, login)
            return page(web, "That link was used already or is too old: open ComfyUI from Afflatus again, or paste the token.")
        if request.method == "POST":
            # a token is short: a large form is refused before it is read (it would be held in memory, asked by anyone)
            if request.content_length is None or request.content_length > 4096:
                return web.Response(status=413, text="too large")
            form = await request.post()
            if same(hash_of(str(form.get("token", "")).strip()), state["hash"]):
                return logged_in(web, request, state, TOKEN_LOGIN)
            return page(web, "That is not this ComfyUI's token.")
        return web.Response(status=405)

    return afflatus_lock


def register(routes, web, lock):
    async def body_of(request):
        if request.content_type != "application/json":
            return None
        try:
            got = await request.json()
        except Exception:
            return None
        return got if isinstance(got, dict) else None

    def fixed():
        return web.Response(status=409, text="This ComfyUI is locked by its start settings (AFFLATUS_TOKEN): change them to change the lock.")

    @routes.get("/afflatus/lock")
    async def _afflatus_lock_state(request):
        state = lock.state()
        return web.json_response({"locked": state is not None, "local": bool(state and state.get("local")), "fixed": lock.fixed is not None, "off": lock.off})

    @routes.post("/afflatus/lock")
    async def _afflatus_lock(request):
        if lock.off:
            return web.Response(status=409, text="This ComfyUI was started with AFFLATUS_LOCK=off: it cannot be locked until it is started without it.")
        body = await body_of(request)
        if body is None:
            return web.Response(status=415, text="a JSON body is expected")
        if lock.fixed:
            return fixed()
        token = body.get("token")
        if not token_ok(token):
            return web.Response(status=400, text=f"a token is {MIN_TOKEN} to {MAX_TOKEN} printable characters")
        lock.write(token, bool(body.get("local")), body.get("origin"))
        return web.json_response({"locked": True, "local": bool(body.get("local"))})

    @routes.post("/afflatus/unlock")
    async def _afflatus_unlock(request):
        if await body_of(request) is None:
            return web.Response(status=415, text="a JSON body is expected")
        if lock.fixed:
            return fixed()
        lock.remove()
        return web.json_response({"locked": False})

    def logins_of(got):
        """A list of logins as Afflatus sends it, or None when it is not one."""
        if not isinstance(got, list) or len(got) > MAX_LOGINS or not all(login_id_ok(x) for x in got):
            return None
        return got

    @routes.post("/afflatus/login-code")
    async def _afflatus_login_code(request):
        body = await body_of(request)
        if body is None:
            return web.Response(status=415, text="a JSON body is expected")
        if lock.state() is None:
            return web.Response(status=409, text="not locked: the page opens without a code")
        login = body.get("login")
        if login is None:
            # an Afflatus before 0.7.1 names no login: the code gives the token's, as it always did (its caller holds the token)
            return web.json_response({"code": lock.code(), "seconds": CODE_S})
        keep = logins_of(body.get("keep"))
        if not login_id_ok(login) or keep is None or login not in keep:
            return web.Response(status=400, text="a login is one of the logins still good (keep)")
        lock.keep(keep)
        return web.json_response({"code": lock.code(login), "seconds": CODE_S})

    @routes.post("/afflatus/logins")
    async def _afflatus_logins(request):
        body = await body_of(request)
        if body is None:
            return web.Response(status=415, text="a JSON body is expected")
        keep = logins_of(body.get("keep"))
        if keep is None:
            return web.Response(status=400, text=f"keep is a list of at most {MAX_LOGINS} logins")
        lock.keep(keep)
        return web.json_response({"kept": len(set(keep))})


def install(server, web, folder_paths):
    """The lock in front of every route of ComfyUI's server, first of its middlewares; and its routes. Done as the pack
    loads, which ComfyUI does after making its server and before starting it, while its list of middlewares can still change."""
    lock = Lock(folder_paths.get_user_directory())
    register(server.routes, web, lock)
    if not lock.off:
        server.app.middlewares.insert(0, make_middleware(lock, web))
    return lock
