"""The lock in front of ComfyUI's server: who gets through, the login page, its routes, and the ways out. aiohttp's `web`
and its requests are stood in for by the little that the lock uses of them; no ComfyUI, no server."""

import asyncio
import json
import os
import types

import pytest

from afflatus_nodes import lock as L

TOKEN = "t" * 20 + "-Afflatus_token_0123456789"
OTHER = "o" * 43


class Headers(dict):
    """Case-insensitive, as aiohttp's are."""

    def __init__(self, items=None):
        super().__init__({k.lower(): v for k, v in (items or {}).items()})

    def __contains__(self, key):
        return super().__contains__(key.lower())

    def get(self, key, default=None):
        return super().get(key.lower(), default)


class Response:
    def __init__(self, status=200, text="", headers=None, content_type=None):
        self.status = status
        self.text = text
        self.headers = dict(headers or {})
        self.content_type = content_type
        self.cookies = {}

    def set_cookie(self, name, value, **opts):
        self.cookies[name] = (value, opts)


def json_response(data, status=200, headers=None):
    res = Response(status, json.dumps(data), headers, "application/json")
    res.data = data
    return res


web = types.SimpleNamespace(middleware=lambda f: f, Response=Response, json_response=json_response)


class Request:
    def __init__(self, path="/prompt", method="GET", headers=None, query=None, cookies=None, remote="203.0.113.9", port=8188, body=None, form=None, host=None):
        self.path = path
        self.method = method
        self.headers = Headers(headers)
        self.rel_url = types.SimpleNamespace(query=query or {})
        self.cookies = cookies or {}
        self.remote = remote
        self.url = types.SimpleNamespace(port=port)
        self.host = host or f"127.0.0.1:{port}"
        self.scheme = "http"
        self.content_type = "application/json" if body is not None else "text/plain"
        self._body = body
        self._form = form or {}
        # what aiohttp says of a body's length: a form's, as sent url-encoded
        self.content_length = len("&".join(f"{k}={v}" for k, v in self._form.items())) if form is not None else None

    async def json(self):
        return self._body

    async def post(self):
        return self._form


async def _handler(request):
    return Response(200, "handled")


def call(middleware, request):
    return asyncio.run(middleware(request, _handler))


@pytest.fixture
def lock(tmp_path):
    return L.Lock(str(tmp_path), env={})


@pytest.fixture
def mw(lock):
    return L.make_middleware(lock, web)


def bearer(token):
    return {"Authorization": f"Bearer {token}"}


def test_open_until_locked(lock, mw):
    assert lock.state() is None
    assert call(mw, Request()).text == "handled"
    # the login page of an open ComfyUI leads to ComfyUI itself
    assert call(mw, Request(L.LOGIN)).headers["Location"] == "/"


def test_locked_needs_the_token(lock, mw):
    lock.write(TOKEN, local=False)
    refused = call(mw, Request())
    assert refused.status == 401 and refused.headers["X-Afflatus-Lock"] == "on"
    assert call(mw, Request(headers=bearer(TOKEN))).text == "handled"
    assert call(mw, Request(headers={"authorization": f"bearer {TOKEN}"})).text == "handled"
    assert call(mw, Request(headers=bearer(OTHER))).status == 401
    assert call(mw, Request(headers=bearer(""))).status == 401
    # the file keeps the token's hash, never the token
    with open(lock.path, encoding="utf-8") as f:
        assert TOKEN not in f.read()


def test_websocket_takes_it_in_the_address_and_only_there(lock, mw):
    lock.write(TOKEN, local=False)
    assert call(mw, Request("/ws", query={"clientId": "x", "token": TOKEN})).text == "handled"
    assert call(mw, Request("/ws", query={"token": OTHER})).status == 401
    assert call(mw, Request("/prompt", query={"token": TOKEN})).status == 401


def test_a_person_lands_on_the_login_page(lock, mw):
    lock.write(TOKEN, local=False)
    went = call(mw, Request("/", headers={"Accept": "text/html,application/xhtml+xml"}))
    assert went.status == 302 and went.headers["Location"] == L.LOGIN
    shown = call(mw, Request(L.LOGIN))
    assert shown.status == 200 and "This ComfyUI is locked" in shown.text


def test_login_by_form_sets_a_cookie_made_from_the_token(lock, mw):
    lock.write(TOKEN, local=False)
    wrong = call(mw, Request(L.LOGIN, "POST", form={"token": OTHER}))
    assert wrong.status == 200 and "That is not this ComfyUI" in wrong.text and not wrong.cookies
    went = call(mw, Request(L.LOGIN, "POST", form={"token": TOKEN}))
    # on to ComfyUI's page from a page of its own (a redirect would go on in the name of the page that sent it here)
    assert went.status == 200 and 'content="0;url=/"' in went.text
    value, opts = went.cookies["afflatus_lock_8188"]
    assert TOKEN not in value and opts["httponly"] and opts["samesite"] == "Lax"
    assert call(mw, Request(cookies={"afflatus_lock_8188": value})).text == "handled"
    # another ComfyUI on the same host has a cookie of its own
    assert call(mw, Request(port=8189, cookies={"afflatus_lock_8188": value})).status == 401


def test_a_large_login_form_is_refused_before_it_is_read(lock, mw):
    lock.write(TOKEN, local=False)
    big = call(mw, Request(L.LOGIN, "POST", form={"token": "x" * 5000}))
    assert big.status == 413


def test_a_fixed_token_that_is_not_one_locks_with_nothing_that_opens_it(tmp_path):
    # the reference to a RunPod secret left as it is (the secret deleted): never taken as the key itself
    ref = "{{ RUNPOD_SECRET_afflatus-1234abcd }}"
    lock = L.Lock(str(tmp_path), env={"AFFLATUS_TOKEN": ref})
    assert lock.state() is not None
    assert lock.state()["hash"] != L.hash_of(ref)


def test_a_new_token_ends_the_old_cookie(lock, mw):
    lock.write(TOKEN, local=False)
    value = call(mw, Request(L.LOGIN, "POST", form={"token": TOKEN})).cookies["afflatus_lock_8188"][0]
    lock.write(OTHER, local=False)
    os.utime(lock.path, ns=(1, 1))  # the same second: the file is still seen as changed
    assert call(mw, Request(cookies={"afflatus_lock_8188": value})).status == 401
    assert call(mw, Request(headers=bearer(TOKEN))).status == 401
    assert call(mw, Request(headers=bearer(OTHER))).text == "handled"


def test_a_login_lands_where_asked_and_only_on_this_server(lock, mw):
    lock.write(TOKEN, local=False)
    assert 'url=/?template=x&amp;source=afflatus"' in call(mw, Request(L.LOGIN, query={"code": lock.code(), "next": "/?template=x&source=afflatus"})).text
    for away in ("https://evil.example/", "//evil.example/", "/\evil.example"):
        assert 'content="0;url=/"' in call(mw, Request(L.LOGIN, query={"code": lock.code(), "next": away})).text


def test_a_login_code_works_once_and_for_a_minute(lock, mw):
    lock.write(TOKEN, local=False)
    code = lock.code()
    assert call(mw, Request(L.LOGIN, query={"code": code})).cookies
    again = call(mw, Request(L.LOGIN, query={"code": code}))
    assert again.status == 200 and "used already" in again.text and not again.cookies
    old = lock.code(now=0)
    assert not lock.use_code(old, now=L.CODE_S + 1)


def test_from_this_pc_only_when_said_and_only_really_from_it(lock, mw):
    lock.write(TOKEN, local=False)
    assert call(mw, Request(remote="127.0.0.1")).status == 401
    lock.write(TOKEN, local=True)
    os.utime(lock.path, ns=(2, 2))
    assert call(mw, Request(remote="127.0.0.1")).text == "handled"
    assert call(mw, Request(remote="::1")).text == "handled"
    assert call(mw, Request(remote="127.0.0.1", headers={"Origin": "http://127.0.0.1:8721"})).text == "handled"
    assert call(mw, Request(remote="127.0.0.1", headers={"Origin": "http://localhost:8188"})).text == "handled"
    # another machine, a proxy on this one, a page of another site, a sandboxed page: all locked out
    assert call(mw, Request(remote="192.0.2.4")).status == 401
    assert call(mw, Request(remote="127.0.0.1", headers={"X-Forwarded-For": "203.0.113.9"})).status == 401
    assert call(mw, Request(remote="127.0.0.1", headers={"Forwarded": "for=203.0.113.9"})).status == 401
    assert call(mw, Request(remote="127.0.0.1", headers={"Origin": "https://evil.example"})).status == 401
    assert call(mw, Request(remote="127.0.0.1", headers={"Sec-Fetch-Site": "cross-site"})).status == 401
    assert call(mw, Request(remote="127.0.0.1", headers={"Origin": "null"})).status == 401


def test_a_lock_file_that_does_not_read_keeps_it_locked(lock, mw):
    with open(lock.path, "w", encoding="utf-8") as f:
        f.write("{not json")
    assert lock.state() is not None
    assert call(mw, Request(headers=bearer(TOKEN))).status == 401


def test_ways_out(tmp_path):
    folder = str(tmp_path)
    L.Lock(folder, env={}).write(TOKEN, local=False)
    off = L.Lock(folder, env={"AFFLATUS_LOCK": "off"})
    assert off.state() is None
    fixed = L.Lock(folder, env={"AFFLATUS_TOKEN": OTHER})
    assert fixed.state()["hash"] == L.hash_of(OTHER)
    # the start settings' token wins over the file's
    assert call(L.make_middleware(fixed, web), Request(headers=bearer(OTHER))).text == "handled"
    unlocked = L.Lock(folder, env={})
    unlocked.remove()
    assert unlocked.state() is None


class Routes:
    def __init__(self):
        self.at = {}

    def _add(self, method, path):
        def deco(f):
            self.at[(method, path)] = f
            return f

        return deco

    def get(self, path):
        return self._add("GET", path)

    def post(self, path):
        return self._add("POST", path)


def route(routes, method, path, request):
    return asyncio.run(routes.at[(method, path)](request))


def test_routes_lock_unlock_and_code(lock):
    routes = Routes()
    L.register(routes, web, lock)
    assert route(routes, "GET", "/afflatus/lock", Request()).data == {"locked": False, "local": False, "fixed": False, "off": False}
    assert route(routes, "POST", "/afflatus/login-code", Request(body={})).status == 409
    # a form, or a token that is no token, is refused
    assert route(routes, "POST", "/afflatus/lock", Request(body=None)).status == 415
    assert route(routes, "POST", "/afflatus/lock", Request(body={"token": "short"})).status == 400
    assert route(routes, "POST", "/afflatus/lock", Request(body={"token": "a b" * 10})).status == 400
    assert route(routes, "POST", "/afflatus/lock", Request(body={"token": TOKEN, "local": True})).data == {"locked": True, "local": True}
    assert lock.state()["local"] is True
    assert "code" in route(routes, "POST", "/afflatus/login-code", Request(body={})).data
    assert route(routes, "POST", "/afflatus/unlock", Request(body={})).data == {"locked": False}
    assert lock.state() is None


def test_routes_leave_a_fixed_lock_alone(tmp_path):
    fixed = L.Lock(str(tmp_path), env={"AFFLATUS_TOKEN": OTHER})
    routes = Routes()
    L.register(routes, web, fixed)
    assert route(routes, "POST", "/afflatus/lock", Request(body={"token": TOKEN})).status == 409
    assert route(routes, "POST", "/afflatus/unlock", Request(body={})).status == 409
    assert fixed.state()["hash"] == L.hash_of(OTHER)


def test_install_puts_it_first(tmp_path):
    server = types.SimpleNamespace(routes=Routes(), app=types.SimpleNamespace(middlewares=["cache_control", "origin_only"]))
    folders = types.SimpleNamespace(get_user_directory=lambda: str(tmp_path))
    L.install(server, web, folders)
    assert len(server.app.middlewares) == 3 and server.app.middlewares[1:] == ["cache_control", "origin_only"]
    assert ("POST", "/afflatus/lock") in server.routes.at


def test_the_cookie_counts_only_from_comfyuis_own_page(lock, mw):
    lock.write(TOKEN, local=False)
    cookie = {"afflatus_lock_8188": call(mw, Request(L.LOGIN, "POST", form={"token": TOKEN})).cookies["afflatus_lock_8188"][0]}
    # ComfyUI's own page, the address bar, a script with no page
    assert call(mw, Request(cookies=cookie, headers={"Sec-Fetch-Site": "same-origin"})).text == "handled"
    assert call(mw, Request(cookies=cookie, headers={"Sec-Fetch-Site": "none"})).text == "handled"
    assert call(mw, Request(cookies=cookie, headers={"Origin": "http://127.0.0.1:8188"})).text == "handled"
    assert call(mw, Request(cookies=cookie)).text == "handled"
    # a page served by another program of the same computer: the same "site" to the browser, which sends the cookie
    assert call(mw, Request("/prompt", "POST", cookies=cookie, headers={"Sec-Fetch-Site": "same-site", "Origin": "http://127.0.0.1:3000"})).status == 401
    assert call(mw, Request("/prompt", "POST", cookies=cookie, headers={"Origin": "http://localhost:3000"})).status == 401
    assert call(mw, Request("/ws", cookies=cookie, headers={"Sec-Fetch-Site": "same-site"})).status == 401
    assert call(mw, Request(cookies=cookie, headers={"Sec-Fetch-Site": "cross-site"})).status == 401
    assert call(mw, Request(cookies=cookie, headers={"Origin": "null"})).status == 401
    # behind a proxy that speaks https outside: the host and port are what count
    assert call(mw, Request(cookies=cookie, host="pod-8188.proxy.example", headers={"Origin": "https://pod-8188.proxy.example"})).text == "handled"
    # the token itself goes on working from anywhere
    assert call(mw, Request(headers={**bearer(TOKEN), "Sec-Fetch-Site": "same-site"})).text == "handled"
