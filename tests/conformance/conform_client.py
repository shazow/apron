#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = ["websockets>=14,<17", "jsonschema>=4.18"]
# ///
"""Check an Apron client's sign-in against PROTOCOL.md.

conform_client.py plays two Apron servers and their sign-in pages against a client,
runs normal and hostile scenarios, and prints one line per test: PASS, FAIL (a
rule the client breaks), WARN (a SHOULD it does not follow), SKIP (with the
reason), or MANUAL (a rule that a person checks). Every frame the client sends is
also validated against schema/apron.schema.json. Exits 1 if any test fails.

The driver listens on two ports, which are two servers with different origins,
and so different `resource` values: A on the --listen port and B on the next one.
Each port serves an Apron WebSocket (at any path, such as ws://127.0.0.1:38765/ws)
and the server's sign-in pages over HTTP on the same origin: /authorize (§4.12),
/passkey (§4.10.1), and /ran-javascript, which a hostile begin `url` calls if a
client runs it. A third port (--listen port + 2) is an OAuth issuer with metadata
and a token endpoint, for clients that redeem there (extensions/ext_oauth.md).
The servers implement what a client needs to reach sign-in: the `server` frame,
whose `auth` lists the schemes under test, `auth` for those schemes, `me`, `ping`,
and polite errors for anything else.

Run from the repository root, with an adapter or with a person:
  uv run tests/conformance/conform_client.py --adapter "node my-client/adapter.js"
  uv run tests/conformance/conform_client.py --interactive
  uv run tests/conformance/conform_client.py --adapter "..." --only "external.A4.*" --json report.json

Adapter mode: the driver starts the adapter command, a small program that the
client's author writes, and talks to it in JSON lines over the adapter's stdin and
stdout (stderr is free for logs; -v shows it). The driver's pages approve at once.

  The adapter starts by writing:
    {"event": "ready", "name": "my-client", "schemes": ["guest", "external", "webauthn", "email"],
     "token_endpoint": false, "rp_id": "localhost"}
      name: optional; how the driver names the client.
      schemes: the sign-in schemes the adapter can drive.
      token_endpoint: true for a library client that redeems codes at the
        issuer's token endpoint instead of on the connection; it enables
        external.A1.iss.
      rp_id: optional; a WebAuthn RP ID that the client's platform accepts for
        its own origin, and for which the platform holds a discoverable passkey
        (a virtual authenticator will do). It enables webauthn.A1.rp-id.

  The driver sends commands, each with an "id":
    {"cmd": "reset", "id": "d1"}                     forget every saved session and
                                                     pending sign-in, and disconnect
    {"cmd": "connect", "id": "d2", "url": "ws://127.0.0.1:38765/ws"}
                                                     connect to this server, as when the
                                                     user picks it; keep any saved session
    {"cmd": "sign_in", "id": "d3", "scheme": "external"}
                                                     start signing in to the connected
                                                     server with this scheme; email also
                                                     carries "email", the address to type;
                                                     webauthn signs in with a passkey
    {"cmd": "type_code", "id": "d4", "code": "418092"}
                                                     type an emailed code (no scenario
                                                     uses it yet)
    {"cmd": "open_link", "id": "d5", "url": "https://link.apron.chat/#token=…&state=…&server=…"}
                                                     open an emailed sign-in link (§4.11.2,
                                                     A.4) in the client
    {"cmd": "redirect", "id": "d6", "url": "http://127.0.0.1:35173/cb?code=…&state=…&iss=…",
     "opened": "<the url of the open_url event>"}
                                                     the browser that the client opened
                                                     ended at url: give it to the client
                                                     as its browser or sign-in session
                                                     would. "url": null means the page
                                                     did not answer, such as a URL that
                                                     is not the driver's; close it
    {"cmd": "quit"}                                  exit
  The adapter answers each command with {"event": "done", "id": …} once it has
  carried it out, or {"event": "error", "id": …, "message": "…"} if it cannot.
  For redirect, done means that the client has been handed the URL: a refusal's
  wait starts there.
  Other events, at any time:
    {"event": "open_url", "url": "…"}               the client wants to open url in a
                                                     browser or sign-in session; the
                                                     adapter opens nothing and the driver
                                                     answers with a redirect command
    {"event": "stopped", "reason": "…"}             the client stopped a sign-in and
                                                     waits for its user, such as after a
                                                     decline or an answer that it refused
    {"event": "error", "message": "…"}              something went wrong in the adapter
    {"event": "log", "message": "…"}                a note, shown with -v
  A browser client may also let its browser load the driver's pages over HTTP:
  in adapter mode they approve at once, with a 302 to redirect_uri. An adapter for
  a web client can intercept every navigation to another origin, in popups and in
  its own tab, report it as open_url, and answer it with a 302 to the redirect.

Interactive mode: no adapter. The driver prints what to do, such as ">>> Sign in to
ws://127.0.0.1:38765/ws with external now", and a person uses the client's real UI.
The sign-in page shows an Approve and a Decline button, and says which one the
scenario needs. Steps that need a fresh client wait for Enter. --rp-id enables
webauthn.A1.rp-id here.

A refusal is the absence of a frame: the driver waits a short fixed time (--quiet,
or longer when the client took longer to redeem a good answer), or less once the
adapter reports that the client stopped. Hostile tests also run a normal sign-in,
so that a client that does nothing does not pass.

Scenarios (ID, section, what passes):
  token.shape.latest         §3.2.1   after a rotation, reconnects with the latest token
  token.A1.per-server        §3.2.1   never sends server A's token to server B, or B's to A
  external.shape.query-kept  §4.12.1  keeps external.url's query, and adds its parameters
  external.A3.pkce           §4.12.2  S256, a verifier of 43+ unreserved characters that
                                      matches the challenge
  external.A4.state          §4.12.2  state is present, and differs on each sign-in
  external.A1.resource       §4.12.2  resource is the origin the client connected to, also
                                      when the begin names an issuer elsewhere
  external.A4.wrong-state    §4.12.2  does not redeem after a redirect with another state
  external.shape.declined    §4.12.2  after error=access_denied, redeems nothing, and stops
                                      (WARN: it sends any auth)
  external.shape.reconnect   §4.12.2  after the driver drops the connection mid-sign-in,
                                      reconnects and redeems
  external.A2.url-scheme     §4.12.1  does not open a begin url that is not https or
                                      loopback http, such as javascript:
  external.A1.iss            ext:oauth a token endpoint client does not redeem after a
                                      redirect with the wrong iss (SKIP for other clients)
  webauthn.A1.rp-id          §4.10    does not run a ceremony whose RP ID is not the
                                      server's host or above it, and uses the passkey page
  email.A1.link-server       §4.11.2  drops a link with its proposal's state whose server
                                      is not the server it proposed to
  external.A2.webview        §4.12.2  MANUAL: the page opens in the system browser or a
                                      sign-in session, not an embedded web view
  core.shape.schema          §1       every client frame matches the schema

Not covered: proof of possession, email codes typed in the client, and sign-in
pages other than the driver's.
"""

import argparse
import asyncio
import base64
import fnmatch
import hashlib
import http.server
import ipaddress
import itertools
import json
import logging
import re
import secrets
import sys
import threading
import time
import traceback
import urllib.parse
from dataclasses import dataclass, field
from datetime import datetime, timezone
from html import escape
from pathlib import Path

from jsonschema import Draft202012Validator
from websockets.asyncio.server import serve
from websockets.datastructures import Headers
from websockets.exceptions import ConnectionClosed
from websockets.http11 import Response

VERSION = 10
WAIT = 20.0  # adapter mode: seconds to wait for something the client should do
PERSON_WAIT = 300.0  # interactive mode: the same, for a person
QUIET = 4.0  # seconds to wait for a frame that should not come
READY_WAIT = 60.0  # seconds for an adapter to start
SCHEMES = {"guest", "token", "webauthn", "email", "external"}
CODES = {"unsupported": -32601, "invalid_params": -32602, "denied": -32001}
SCHEMA_PATH = Path(__file__).resolve().parents[2] / "schema/apron.schema.json"
UNRESERVED = re.compile(r"[A-Za-z0-9._~-]+")


class Fail(Exception): pass
class Warn(Exception): pass
class Skip(Exception): pass
class Manual(Exception): pass
class Incomplete(Exception):
    """A step that a normal client takes did not happen. A test of what the client should do fails; a test of what
    it should refuse is skipped, since the refusal would prove nothing."""


def must(condition, why):
    if not condition:
        raise Fail(why)


def should(condition, why):
    if not condition:
        raise Warn(why)


class Schema:
    def __init__(self):
        self.schema = json.loads(SCHEMA_PATH.read_text()) if SCHEMA_PATH.exists() else None
        self.validators = {}

    def errors(self, instance, name):
        if not self.schema or name not in self.schema["$defs"]:
            return []
        if name not in self.validators:
            wrapper = {k: v for k, v in self.schema.items() if k != "anyOf"}
            wrapper["$ref"] = f"#/$defs/{name}"
            self.validators[name] = Draft202012Validator(wrapper)
        return [f"{name} at /{'/'.join(map(str, e.absolute_path))}: {e.message}"
                for e in self.validators[name].iter_errors(instance)]


def b64url(data):
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def s256(verifier):
    return b64url(hashlib.sha256(verifier.encode()).digest())


def loopback(host):
    host = (host or "").strip("[]").lower()
    if host == "localhost" or host.endswith(".localhost"):
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def split_host(hostport):
    """("host", port) of a Host header or netloc."""
    parts = urllib.parse.urlsplit(f"//{hostport}")
    return parts.hostname or "", parts.port


def server_origin(scheme, hostport):
    """The server's origin for an address with this scheme and host (§4.12.1): https://, or http:// for ws:// on a
    loopback host."""
    host, _ = split_host(hostport)
    return f"{'http' if scheme == 'ws' and loopback(host) else 'https'}://{hostport.lower()}"


def add_query(url, params):
    parts = urllib.parse.urlsplit(url)
    query = parts.query + ("&" if parts.query else "") + urllib.parse.urlencode(params)
    return urllib.parse.urlunsplit(parts._replace(query=query))


def redirect_problem(uri):
    """Why a page refuses this redirect_uri (§4.12.3), or None."""
    try:
        parts = urllib.parse.urlsplit(uri or "")
    except ValueError:
        return "it is not a URI"
    if parts.scheme == "https" and parts.hostname:
        return None
    if parts.scheme == "http" and loopback(parts.hostname):
        return None
    if "." in parts.scheme:
        return None
    return "it is not https, a scheme with a '.', or http on a loopback address"


def now_rfc3339():
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def short(value, n=60):
    text = value if isinstance(value, str) else json.dumps(value)
    return text if len(text) <= n else text[:n] + "…"


class Event:
    """One thing that happened: a frame, an HTTP request, an adapter event. Missing fields read as None."""

    def __init__(self, i, kind, **fields):
        self.i, self.t, self.kind = i, time.monotonic(), kind
        self.__dict__.update(fields)

    def __getattr__(self, name):
        return None

    def __repr__(self):
        fields = {k: v for k, v in self.__dict__.items() if k not in ("i", "t", "kind", "raw")}
        return f"{self.kind} {short(fields, 200)}"


def auth_params(e, site=None, conn=None):
    """The params of an auth frame, or None."""
    if e.kind != "frame" or (site and e.site != site) or (conn and e.conn != conn):
        return None
    if e.frame.get("method") != "auth" or not isinstance(e.frame.get("params"), dict):
        return None
    return e.frame["params"]


def is_begin(params, scheme="external"):
    return params is not None and params.get("scheme") == scheme and "code" not in params and "token" not in params


@dataclass
class Config:
    """What one server offers in a scenario."""
    auth: list = field(default_factory=lambda: ["guest", "token"])
    begin: object = None  # (site, conn) -> the external begin result
    webauthn_begin: object = None  # (site, conn, params) -> the webauthn begin result
    rotate: bool = False  # answer a token with a new one, and refuse the one it replaced


@dataclass
class Grant:
    code: str
    kind: str  # external or passkey
    action: str
    query: dict
    site: str
    used: bool = False


class Conn:
    def __init__(self, site, ws, n):
        self.site, self.ws, self.n = site, ws, n
        self.host = ws.request.headers.get("Host", f"{site.host}:{site.port}")
        self.origin = server_origin("ws", self.host)
        self.page_base = f"http://{self.host}"
        self.you = None


class Site:
    """One Apron server and its sign-in pages, on one port."""

    def __init__(self, driver, key, host, port):
        self.d, self.key, self.host, self.port = driver, key, host, port
        self.conns = {}
        self.reset(Config())

    @property
    def address(self):
        return f"ws://{self.host}:{self.port}/ws"

    @property
    def origin(self):
        return server_origin("ws", f"{self.host}:{self.port}")

    def reset(self, config):
        self.config = config
        self.tokens, self.replaced, self.email_tokens = {}, set(), {}

    async def drop(self):
        for conn in list(self.conns.values()):
            await conn.ws.close(1012, "conformance driver restart")

    def server_params(self):
        return {"apron": VERSION, "agent": "conform_client.py", "auth": self.config.auth,
                "title": f"Conformance {self.key}",
                "welcome": f"Server {self.key} of conform_client.py, which checks how clients sign in."}

    async def process_request(self, connection, request):
        if request.headers.get("Upgrade", "").lower() == "websocket":
            return None
        parts = urllib.parse.urlsplit(request.path)
        host = request.headers.get("Host", f"{self.host}:{self.port}")
        status, headers, body = await self.d.page(self, host, parts.path, parts.query, "http")
        headers = Headers(headers + [("Content-Length", str(len(body))), ("Connection", "close")])
        return Response(status, http.HTTPStatus(status).phrase, headers, body)

    async def serve(self, ws):
        n = next(self.d.conn_ids)
        conn = Conn(self, ws, n)
        self.conns[n] = conn
        self.d.log.add("open", site=self.key, conn=n, host=conn.host, path=ws.request.path)
        try:
            await self.send(conn, {"method": "server", "params": self.server_params()})
            async for raw in ws:
                try:
                    frame = json.loads(raw)
                except ValueError:
                    self.d.log.add("frame", site=self.key, conn=n, frame={}, raw=raw)
                    self.d.violate(f"not JSON: {short(raw)}")
                    await self.send(conn, {"error": {"code": -32700, "message": "Parse error"}})
                    continue
                if not isinstance(frame, dict):
                    self.d.violate(f"not a JSON object: {short(raw)}")
                    continue
                for error in self.d.schema.errors(frame, "ClientFrame"):
                    self.d.violate(f"{frame.get('method', 'frame')}: {error}")
                self.d.log.add("frame", site=self.key, conn=n, frame=frame, raw=raw)
                reply = await self.handle(conn, frame)
                if reply is not None:
                    await self.send(conn, reply)
        except ConnectionClosed:
            pass
        except Exception as e:  # a driver bug: say so, rather than fail the client
            self.d.log.add("driver-error", site=self.key, conn=n, error=f"{type(e).__name__}: {e}")
            self.d.note(f"driver error on {self.key}: {type(e).__name__}: {e}")
            if self.d.args.verbose:
                traceback.print_exc()
        finally:
            self.conns.pop(n, None)
            self.d.log.add("close", site=self.key, conn=n)

    async def send(self, conn, frame):
        if self.d.args.verbose:
            for error in self.d.schema.errors(frame, "ServerFrame"):
                print(f"      driver bug: {error}", flush=True)
        self.d.log.add("sent", site=self.key, conn=conn.n, frame=frame)
        try:
            await conn.ws.send(json.dumps(frame))
        except ConnectionClosed:
            pass

    async def handle(self, conn, frame):
        method, rid, params = frame.get("method"), frame.get("id"), frame.get("params")
        params = params if isinstance(params, dict) else {}
        if method == "ping" and rid is None:
            return {"method": "pong"}
        if rid is None:
            return None  # notifications are ignored
        if method == "auth":
            return {"id": rid, **self.auth(conn, params)}
        if conn.you is None:
            return error(rid, "denied", "Sign in first")
        if method == "me":
            return {"id": rid, "result": {"you": conn.you}}
        if method == "message":
            return error(rid, "invalid_params", "This conformance server has no rooms")
        return error(rid, "unsupported", f"This conformance server does not implement {method}")

    def auth(self, conn, params):
        scheme = params.get("scheme")
        if scheme not in self.config.auth:
            if scheme in SCHEMES:
                return failure("unsupported", f"This server does not offer {scheme} now")
            return failure("invalid_params", f"Unknown scheme {scheme!r}")
        if scheme == "guest":
            n = next(self.d.user_ids)
            return self.signed_in(conn, {"user_id": f"guest_{n}", "name": params.get("name") or f"Guest {n}"}, scheme)
        if scheme == "token" or (scheme == "email" and "token" in params):
            return self.token(conn, params.get("token"), scheme)
        if scheme == "email":
            self.d.log.add("proposal", site=self.key, conn=conn.n, email=params.get("email"), state=params.get("state"))
            return {"result": {}}
        if scheme == "external":
            if "code" in params:
                return self.redeem(conn, params, "external")
            if "token" in params:
                return failure("denied", "This server takes no token with external")
            begin = self.config.begin(self, conn) if self.config.begin else {"external": {"url": f"{conn.page_base}/authorize"}}
            return {"result": begin}
        if scheme == "webauthn":
            if params.get("step") == "begin" and self.config.webauthn_begin:
                return {"result": self.config.webauthn_begin(self, conn, params)}
            if params.get("step") == "finish" and "code" in params:
                return self.redeem(conn, params, "passkey")
            return failure("denied", "This conformance server verifies no WebAuthn credentials")
        return failure("unsupported", f"{scheme} is not implemented here")

    def signed_in(self, conn, you, scheme, replaces=None):
        conn.you = you
        result = {"you": you}
        if "token" in self.config.auth:
            token = "conf_" + secrets.token_urlsafe(24)
            self.tokens[token] = you
            result["token"] = token
            self.d.log.add("issued", site=self.key, conn=conn.n, token=token, scheme=scheme, replaces=replaces)
        return {"result": result}

    def token(self, conn, token, scheme):
        you = self.tokens.get(token) or self.email_tokens.pop(token, None) or self.d.access_tokens.get((self.key, token))
        if not isinstance(token, str) or you is None or token in self.replaced:
            return failure("denied", "Unknown, replaced, or expired token")
        if self.config.rotate and token in self.tokens:
            self.replaced.add(token)
            return self.signed_in(conn, you, scheme, replaces=token)
        conn.you = you
        return {"result": {"you": you}}

    def redeem(self, conn, params, kind):
        code = params.get("code")
        grant = self.d.codes.get(code) if isinstance(code, str) else None
        problems = []
        if grant is None:
            problems.append("an unknown code")
        else:
            problems = grant_problems(grant, params, conn.origin, kind)
            grant.used = True
        self.d.log.add("redeem", site=self.key, conn=conn.n, code=code, scheme=kind, problems=problems)
        if problems:
            return failure("denied", "Code refused: " + "; ".join(problems))
        user = {"user_id": f"{kind}_{next(self.d.user_ids)}", "name": "Conformance"}
        return self.signed_in(conn, user, kind)


def grant_problems(grant, params, origin, kind):
    query, problems = grant.query, []
    if grant.used:
        problems.append("the code was used")
    if grant.kind != kind:
        problems.append(f"a {grant.kind} code redeemed as {kind}")
    if kind == "passkey" and params.get("action") != grant.action:
        problems.append(f"action {params.get('action')!r}, but the page's was {grant.action!r}")
    for key in ("client_id", "redirect_uri"):
        if params.get(key) != query.get(key):
            problems.append(f"{key} {short(params.get(key))!r}, but the request sent {short(query.get(key))!r}")
    verifier = params.get("code_verifier")
    if query.get("code_challenge_method") != "S256" or not isinstance(verifier, str) \
            or s256(verifier) != query.get("code_challenge"):
        problems.append("code_verifier does not match the S256 code_challenge")
    if query.get("resource") != origin:
        problems.append(f"the request's resource {query.get('resource')!r} is not {origin}")
    return problems


def error(rid, name, message):
    return {"id": rid, **failure(name, message)}


def failure(name, message):
    return {"error": {"code": CODES[name], "message": message}}


class Log:
    def __init__(self, verbose):
        self.events, self.verbose = [], verbose
        self.changed = asyncio.Event()

    def add(self, kind, **fields):
        event = Event(len(self.events), kind, **fields)
        self.events.append(event)
        if self.verbose:
            print(f"      · {event!r}", flush=True)
        self.changed.set()
        self.changed = asyncio.Event()
        return event

    def __len__(self):
        return len(self.events)


class Adapter:
    """The adapter process, and its JSON lines."""

    def __init__(self, driver, command):
        self.d, self.command_line = driver, command
        self.pending, self.ids, self.stderr = {}, (f"d{n}" for n in itertools.count(1)), []
        self.ready = asyncio.get_running_loop().create_future()
        self.gone = None

    async def start(self):
        self.proc = await asyncio.create_subprocess_shell(
            self.command_line, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
            stderr=None if self.d.args.verbose else asyncio.subprocess.PIPE, limit=2**20)
        self.tasks = [asyncio.create_task(self.read())]
        if self.proc.stderr:
            self.tasks.append(asyncio.create_task(self.read_stderr()))
        try:
            return await asyncio.wait_for(asyncio.shield(self.ready), READY_WAIT)
        except asyncio.TimeoutError:
            raise SystemExit(f"the adapter sent no ready event in {READY_WAIT:.0f} s{self.tail()}")

    def tail(self):
        return ("; its stderr ended with:\n" + "\n".join(self.stderr[-15:])) if self.stderr else ""

    async def read_stderr(self):
        async for line in self.proc.stderr:
            self.stderr = (self.stderr + [line.decode(errors="replace").rstrip()])[-50:]

    async def read(self):
        async for line in self.proc.stdout:
            try:
                event = json.loads(line)
                assert isinstance(event, dict)
            except (ValueError, AssertionError):
                self.d.log.add("adapter-noise", line=line.decode(errors="replace").rstrip())
                continue
            self.d.log.add("adapter", event=event, name=event.get("event"))
            name = event.get("event")
            if name == "ready" and not self.ready.done():
                self.ready.set_result(event)
            elif name in ("done", "error") and event.get("id") in self.pending:
                future = self.pending.pop(event["id"])
                if not future.done():
                    future.set_result(event)
            elif name == "open_url":
                asyncio.create_task(self.d.open_url(event.get("url")))
            elif name == "error":
                self.d.note(f"the adapter reported: {event.get('message')}")
        code = await self.proc.wait()
        self.gone = f"the adapter exited with status {code}{self.tail()}"
        if not self.ready.done():
            self.ready.set_exception(SystemExit(self.gone))
        for future in self.pending.values():
            if not future.done():
                future.set_result({"event": "error", "message": self.gone})

    async def send(self, cmd, **params):
        if self.gone:
            raise Skip(self.gone)
        line = json.dumps({"cmd": cmd, **params}) + "\n"
        self.d.log.add("command", cmd=cmd, params=params)
        try:
            self.proc.stdin.write(line.encode())
            await self.proc.stdin.drain()
        except (BrokenPipeError, ConnectionResetError):
            raise Skip(f"the adapter is gone{self.tail()}")

    async def command(self, cmd, **params):
        rid = next(self.ids)
        future = asyncio.get_running_loop().create_future()
        self.pending[rid] = future
        await self.send(cmd, id=rid, **params)
        try:
            event = await asyncio.wait_for(future, self.d.wait)
        except asyncio.TimeoutError:
            self.pending.pop(rid, None)
            raise Skip(f"the adapter did not finish {cmd} in {self.d.wait:.0f} s")
        if event.get("event") == "error":
            raise Skip(f"the adapter could not {cmd}: {event.get('message')}")
        return event

    async def quit(self):
        if self.gone:
            return
        try:
            await self.send("quit")
            await asyncio.wait_for(self.proc.wait(), 10)
        except (Skip, asyncio.TimeoutError):
            self.proc.kill()


class Driver:
    def __init__(self, args):
        self.args, self.schema = args, Schema()
        self.interactive = args.interactive
        self.wait = args.wait or (PERSON_WAIT if self.interactive else WAIT)
        self.quiet = args.quiet
        self.log = Log(args.verbose)
        self.conn_ids, self.user_ids = itertools.count(1), itertools.count(1)
        host, _, port = args.listen.rpartition(":")
        self.host, port = host or "127.0.0.1", int(port)
        name = "127.0.0.1" if self.host in ("0.0.0.0", "::", "") else self.host
        self.sites = {"A": Site(self, "A", name, port), "B": Site(self, "B", name, port + 1)}
        self.issuer_port = port + 2
        self.issuer = f"http://{name}:{self.issuer_port}"
        self.codes, self.requests, self.access_tokens = {}, {}, {}
        self.violations, self.notes, self.cache, self.latencies = [], [], {}, []
        self.adapter, self.caps = None, {}
        self.page_mode, self.on_page, self.iss, self.page_hint = "approve", None, None, ""
        self.req_ids = (f"r{n}" for n in itertools.count(1))

    def violate(self, text):
        self.violations.append(text)

    def note(self, text):
        self.notes.append(text)

    def can(self, scheme):
        """Whether the client side can sign in with scheme: as the adapter says, or a person, who can try any."""
        return self.interactive or scheme in self.caps.get("schemes", [])

    @property
    def rp_id(self):
        return self.args.rp_id if self.interactive else self.caps.get("rp_id")

    def quiet_window(self):
        """How long a refusal waits: --quiet, or twice the slowest redemption of a good answer so far."""
        return max([self.quiet] + [2 * t + 1 for t in self.latencies])

    async def until(self, find, since=0, timeout=None, stop=False):
        """The first event from index since on for which find is true, or None after timeout seconds. With stop,
        gives up half a second after the adapter reports that the client stopped."""
        deadline = time.monotonic() + (self.wait if timeout is None else timeout)
        checked = since
        while True:
            for event in self.log.events[checked:]:
                if find(event):
                    return event
                if stop and event.kind == "adapter" and event.name == "stopped":
                    stop, deadline = False, min(deadline, time.monotonic() + 0.5)  # a moment for a late frame
            checked = len(self.log)
            left = deadline - time.monotonic()
            if left <= 0:
                return None
            try:
                await asyncio.wait_for(self.log.changed.wait(), left)
            except asyncio.TimeoutError:
                pass

    def since(self, i, find=lambda e: True):
        return [e for e in self.log.events[i:] if find(e)]

    # What the client's user does: an adapter command, or an instruction to a person.

    async def do(self, cmd, say=None, **params):
        if self.adapter:
            return await self.adapter.command(cmd, **params)
        if cmd == "reset":
            print(">>> Sign out of both conformance servers in the client, so that it keeps no session for "
                  f"{self.sites['A'].address} or {self.sites['B'].address}. Then press Enter.", flush=True)
            await asyncio.to_thread(sys.stdin.readline)
            return
        text = say or {
            "connect": lambda: f"Connect the client to {params['url']}",
            "sign_in": lambda: f"Sign in with {params['scheme']} now",
            "type_code": lambda: f"Type the code {params['code']}",
            "open_link": lambda: f"Open this sign-in link in the client: {params['url']}",
        }[cmd]()
        print(f">>> {text}", flush=True)

    async def fresh(self, A=None, B=None):
        """Start a scenario: both servers offer what A and B say, and the client keeps nothing."""
        self.page_mode, self.on_page, self.iss, self.page_hint = "approve", None, None, ""
        self.sites["A"].reset(A or Config())
        self.sites["B"].reset(B or Config())
        await self.do("reset")
        for site in self.sites.values():
            await site.drop()
        return len(self.log)

    async def connect(self, key, since):
        """The user connects the client to server key; returns the open event."""
        site = self.sites[key]
        await self.do("connect", url=site.address)
        opened = await self.until(lambda e: e.kind == "open" and e.site == key, since)
        if not opened:
            raise Incomplete(f"the client did not connect to {site.address}")
        return opened

    # The sign-in pages, for the client's browser over HTTP and for an adapter's open_url.

    async def page(self, site, host, path, query, via):
        pairs = urllib.parse.parse_qsl(query, keep_blank_values=True)
        q = {}
        for k, v in pairs:
            q.setdefault(k, v)
        if path == "/ran-javascript":
            self.log.add("canary", site=site.key, via=via)
            return 200, [("Content-Type", "text/plain")], b"A begin url ran as a script.\n"
        if path in ("/authorize", "/passkey"):
            req = Event(0, "request", id=next(self.req_ids), site=site.key, host=host, path=path, query=q,
                        pairs=pairs, via=via, answered=None, code=None)
            self.requests[req.id] = req
            self.log.add("page", req=req.id, site=site.key, path=path, query=q, pairs=pairs, via=via)
            if self.on_page:
                await self.on_page(req)
            if self.interactive and via == "http":
                return 200, [("Content-Type", "text/html; charset=utf-8"), ("Referrer-Policy", "no-referrer"),
                             ("X-Frame-Options", "DENY"), ("Cache-Control", "no-store")], self.html(req)
            return self.answer(req, approved=self.page_mode != "decline")
        if path == "/answer":
            req = self.requests.get(q.get("request"))
            if req is None:
                return 404, [("Content-Type", "text/plain")], b"Unknown request.\n"
            return self.answer(req, approved=q.get("approve") == "1")
        self.log.add("http", site=site.key, path=path, query=q, via=via)
        return 404, [("Content-Type", "text/plain")], b"Not found.\n"

    def html(self, req):
        q = req.query
        target = urllib.parse.urlsplit(q.get("redirect_uri", ""))
        to = target.netloc or f"{target.scheme}:"
        base = f"/answer?request={req.id}"
        hint = f"<p><strong>{escape(self.page_hint)}</strong></p>" if self.page_hint else ""
        return f"""<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Conformance sign-in</title>
<style>body{{font:16px system-ui;margin:2em auto;max-width:34em;padding:0 1em}}a{{display:inline-block;margin:0 1em 0 0;
padding:.6em 1.4em;border-radius:6px;background:#2a6;color:#fff;text-decoration:none}}a.no{{background:#a33}}
code{{word-break:break-all}}</style>
<h1>Sign in to Conformance {req.site}</h1>
<p>{escape(q.get('client_id', 'A client'))} at <code>{escape(to)}</code> asks to sign in to
<code>{escape(self.sites[req.site].address)}</code>{' with a passkey' if req.path == '/passkey' else ''}.</p>
{hint}<p><a id="approve" href="{base}&approve=1">Approve</a><a id="decline" class="no" href="{base}&approve=0">Decline</a></p>
""".encode()

    def answer(self, req, approved):
        q = req.query
        problem = redirect_problem(q.get("redirect_uri"))
        if problem or req.answered:
            why = f"redirect_uri {q.get('redirect_uri')!r}: {problem}" if problem else "This request was answered."
            self.log.add("answer", req=req.id, location=None, error=why)
            return 400, [("Content-Type", "text/plain")], f"Invalid request: {why}\n".encode()
        params = {}
        if approved:
            req.code = "code_" + secrets.token_urlsafe(24)
            kind = "passkey" if req.path == "/passkey" else "external"
            self.codes[req.code] = Grant(req.code, kind, q.get("action"), q, req.site)
            params["code"] = req.code
        else:
            params["error"] = "access_denied"
        state = q.get("state")
        if approved and self.page_mode == "wrong_state":
            state = secrets.token_urlsafe(32)
        if state is not None:
            params["state"] = state
        params["iss"] = self.iss or server_origin("ws", req.host)
        if self.page_mode == "wrong_iss":
            params["iss"] = self.sites["B"].origin
        location = add_query(q["redirect_uri"], params)
        req.answered = location
        self.log.add("answer", req=req.id, location=location, approved=approved, code=req.code, via=req.via)
        if req.via == "http":
            self.log.add("delivered", req=req.id)
        return 302, [("Location", location), ("Referrer-Policy", "no-referrer"), ("Cache-Control", "no-store")], b""

    async def open_url(self, url):
        """The adapter's open_url: the driver's own pages answer it as they answer a browser."""
        location = None
        try:
            parts = urllib.parse.urlsplit(url or "")
            site = next((s for s in self.sites.values() if parts.scheme == "http" and loopback(parts.hostname)
                         and parts.port == s.port), None)
        except ValueError:
            site = None
        if site is None:
            self.log.add("foreign", url=url)
        else:
            status, headers, _ = await self.page(site, parts.netloc, parts.path, parts.query, "adapter")
            location = dict(headers).get("Location") if status == 302 else None
        try:
            await self.adapter.command("redirect", url=location, opened=url)
        except Skip as e:
            self.note(str(e))
            return
        req = next((r for r in self.requests.values() if r.answered == location), None) if location else None
        if req:
            self.log.add("delivered", req=req.id)

    async def token_endpoint(self, form):
        """The issuer's token endpoint (RFC 6749 §4.1.3), for clients that redeem there."""
        code = form.get("code")
        grant = self.codes.get(code)
        problems = ["an unknown code"] if grant is None else grant_problems(
            grant, form, self.sites[grant.site].origin, "external")
        if form.get("grant_type") != "authorization_code":
            problems.append(f"grant_type {form.get('grant_type')!r}")
        if grant:
            grant.used = True
        self.log.add("token-endpoint", code=code, problems=problems)
        if problems:
            return 400, {"error": "invalid_grant", "error_description": "; ".join(problems)}
        access = "at_" + secrets.token_urlsafe(24)
        self.access_tokens[(grant.site, access)] = {"user_id": f"issuer_{next(self.user_ids)}", "name": "Conformance"}
        return 200, {"access_token": access, "token_type": "Bearer", "expires_in": 600}

    def metadata(self):
        a = self.sites["A"]
        return {"issuer": self.issuer, "authorization_endpoint": f"http://{a.host}:{a.port}/authorize",
                "token_endpoint": f"{self.issuer}/token", "response_types_supported": ["code"],
                "grant_types_supported": ["authorization_code"], "code_challenge_methods_supported": ["S256"],
                "token_endpoint_auth_methods_supported": ["none"],
                "authorization_response_iss_parameter_supported": True}

    def start_issuer(self, loop):
        driver = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def reply(self, status, doc):
                body = json.dumps(doc).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Access-Control-Allow-Origin", "*")
                self.send_header("Cache-Control", "no-store")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_OPTIONS(self):
                self.send_response(204)
                self.send_header("Access-Control-Allow-Origin", "*")
                self.send_header("Access-Control-Allow-Methods", "GET, POST")
                self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
                self.end_headers()

            def do_GET(self):
                path = urllib.parse.urlsplit(self.path).path
                loop.call_soon_threadsafe(lambda: driver.log.add("http", site="issuer", path=path, query={}))
                if path in ("/.well-known/oauth-authorization-server", "/.well-known/openid-configuration"):
                    return self.reply(200, driver.metadata())
                self.reply(404, {"error": "not_found"})

            def do_POST(self):
                length = int(self.headers.get("Content-Length") or 0)
                form = dict(urllib.parse.parse_qsl(self.rfile.read(length).decode(errors="replace")))
                if urllib.parse.urlsplit(self.path).path != "/token":
                    return self.reply(404, {"error": "not_found"})
                status, doc = asyncio.run_coroutine_threadsafe(driver.token_endpoint(form), loop).result(10)
                self.reply(status, doc)

        server = http.server.ThreadingHTTPServer((self.host, self.issuer_port), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        return server

    async def cached(self, key, make):
        """A flow that several tests check, run once. A flow that could not finish fails each test that uses it."""
        if key not in self.cache:
            try:
                self.cache[key] = await make()
            except (Incomplete, Skip) as e:
                self.cache[key] = e
        if isinstance(self.cache[key], Exception):
            raise self.cache[key]
        return self.cache[key]


# Flows that tests share.

@dataclass
class Flow:
    begin: Event = None  # the begin's auth frame
    page: Event = None  # the authorization request
    answer: Event = None
    delivered: Event = None
    redeem: Event = None  # the first frame or token endpoint request with the code
    after: list = None  # what the client sent after the answer was delivered, within the window
    stopped: Event = None


def default_begin(site, conn):
    return {"external": {"url": f"{conn.page_base}/authorize?scope=apron&provider=conformance"}}


def offering(*schemes):
    return Config(auth=list(schemes) + ["token"])


async def external_flow(d, mode="approve", begin=default_begin, on_page=None, hint=""):
    """One external sign-in on server A: begin, the page, and the redemption. mode is the page's answer: approve,
    decline, wrong_state, or wrong_iss. The flow waits for a redemption for a while (approve), or for the quiet
    window (the others)."""
    start = await d.fresh(A=Config(auth=["external", "token"], begin=begin), B=Config(auth=["external", "token"]))
    d.page_mode, d.on_page = mode, on_page
    d.page_hint = hint or ("Press Approve." if mode != "decline" else "Press Decline.")
    await d.connect("A", start)
    await d.do("sign_in", scheme="external",
               say=f"Sign in to {d.sites['A'].address} with external now. On the sign-in page, "
                   f"{d.page_hint[0].lower()}{d.page_hint[1:]}")
    flow = Flow()
    flow.begin = await d.until(lambda e: is_begin(auth_params(e, "A")), start)
    if not flow.begin:
        raise Incomplete("the client sent no external begin")
    flow.page = await d.until(lambda e: e.kind == "page", start)
    if not flow.page:
        raise Incomplete("the client did not open external.url")
    req = d.requests[flow.page.req]
    flow.answer = await d.until(lambda e: e.kind == "answer" and e.req == req.id, flow.page.i)
    if not flow.answer or not flow.answer.location:
        raise Incomplete("the page did not answer" + (f": {flow.answer.error}" if flow.answer else ""))
    if d.interactive and (mode == "decline") == flow.answer.approved:
        raise Skip(f"the person pressed {'Approve' if flow.answer.approved else 'Decline'}")
    flow.delivered = await d.until(lambda e: e.kind == "delivered" and e.req == req.id, flow.answer.i)
    if not flow.delivered:
        raise Incomplete("the adapter did not take the redirect")
    code = req.code

    def uses_code(e):
        params = auth_params(e)
        return (params is not None and code is not None and params.get("code") == code) or \
            (e.kind == "token-endpoint" and code is not None and e.code == code)

    good = mode == "approve"
    window = d.wait if good else d.quiet_window()
    flow.redeem = await d.until(uses_code, flow.delivered.i, timeout=window, stop=not good)
    if not good and not flow.redeem and d.latencies:
        d.note(f"waited up to {window:.1f} s after the redirect; a good answer was redeemed within "
               f"{max(d.latencies):.1f} s")
    if good and flow.redeem:
        d.latencies.append(flow.redeem.t - flow.delivered.t)
    elif not good:
        flow.stopped = next((e for e in d.since(flow.delivered.i) if e.kind == "adapter" and e.name == "stopped"), None)
    flow.after = d.since(flow.delivered.i)
    return flow


async def baseline(d):
    return await d.cached("baseline", lambda: external_flow(d))


def page_query(d, flow):
    return d.requests[flow.page.req].query


def opened_host(d, conn):
    """The Host header of connection conn's handshake: the address that the client connected to."""
    return next(e.host for e in d.log.events if e.kind == "open" and e.conn == conn)


def redemption(d, flow):
    """The params of the baseline's redemption on the connection; Incomplete if there was none."""
    if not flow.redeem or flow.redeem.kind != "frame":
        raise Incomplete("the client did not redeem the code on the connection"
                         + (" (it used the token endpoint)" if flow.redeem else ""))
    return auth_params(flow.redeem)


async def sign_in_for_token(d, key, since):
    """Signs in on server key with a scheme that returns a token, and returns the issued event."""
    scheme = next((s for s in ("guest", "external") if d.can(s)), None)
    if scheme is None:
        raise Skip("the adapter can sign in with neither guest nor external")
    d.page_hint = "Press Approve."
    await d.do("sign_in", scheme=scheme,
               say=f"Sign in to {d.sites[key].address} as a guest, or with external (press Approve on its page)")
    issued = await d.until(lambda e: e.kind == "issued" and e.site == key, since)
    if not issued:
        raise Incomplete(f"the client did not sign in to {d.sites[key].address} with {scheme}")
    return issued


async def reconnected(d, key, since):
    """After a drop, the next connection to server key and its first auth frame (or None)."""
    opened = await d.until(lambda e: e.kind == "open" and e.site == key, since,
                           timeout=d.wait if d.interactive else min(d.wait, 10))
    if not opened:
        if d.interactive:
            raise Incomplete(f"the client did not reconnect to {d.sites[key].address}")
        await d.do("connect", url=d.sites[key].address)
        opened = await d.until(lambda e: e.kind == "open" and e.site == key, since)
        if not opened:
            raise Incomplete(f"the client did not reconnect to {d.sites[key].address}")
        d.note("the client did not reconnect by itself; the adapter connected it again")
    first = await d.until(lambda e: auth_params(e, key, opened.conn) is not None, opened.i)
    return opened, first


# Tests.

TESTS = []


def test(tid, section, title):
    def wrap(fn):
        TESTS.append((tid, section, title, fn))
        return fn
    return wrap


@test("token.shape.latest", "3.2.1", "saves the latest token from a result, and uses it next")
async def _(d):
    start = await d.fresh(A=Config(auth=["guest", "external", "token"], rotate=True, begin=default_begin))
    await d.connect("A", start)
    first = await sign_in_for_token(d, "A", start)
    mark = len(d.log)
    if not d.interactive:
        await asyncio.sleep(0.5)  # let the client settle on its new session
    await d.sites["A"].drop()
    opened, auth = await reconnected(d, "A", mark)
    params = auth_params(auth) if auth else None
    must(params is not None, "after a dropped connection, the client reconnected and sent no auth")
    must(params.get("scheme") == "token" and params.get("token") == first.token,
         f"after a dropped connection, the client signed in with {params.get('scheme')}, not the token it was given")
    rotated = await d.until(lambda e: e.kind == "issued" and e.site == "A" and e.replaces == first.token, auth.i, 2)
    must(rotated is not None, "the driver did not rotate the token (driver bug)")
    mark = len(d.log)
    await asyncio.sleep(0.5)
    await d.sites["A"].drop()
    opened, auth = await reconnected(d, "A", mark)
    params = auth_params(auth) if auth else None
    must(params is not None, "after the second drop, the client reconnected and sent no auth")
    must(params.get("token") != first.token, "the client sent the token that a later result replaced")
    must(params.get("scheme") == "token" and params.get("token") == rotated.token,
         f"after a rotation, the client signed in with {params.get('scheme')}, not the latest token")


@test("token.A1.per-server", "3.2.1", "never sends one server's token to another server")
async def _(d):
    offers = ["guest", "external", "token"]
    start = await d.fresh(A=Config(auth=offers, begin=default_begin), B=Config(auth=offers, begin=default_begin))
    await d.connect("A", start)
    token_a = (await sign_in_for_token(d, "A", start)).token
    mark = len(d.log)
    await d.connect("B", mark)
    await asyncio.sleep(d.quiet_window())
    token_b = None
    try:
        token_b = (await sign_in_for_token(d, "B", mark)).token
    except (Incomplete, Skip) as e:
        d.note(f"B's own token is not checked: {e}")
    mark_a = len(d.log)
    await d.connect("A", mark_a)
    await asyncio.sleep(d.quiet_window())
    leaks = []
    for e in d.log.events[start:]:
        text = e.raw if e.kind == "frame" else json.dumps(e.query) if e.kind in ("page", "http") else None
        if text is None:
            continue
        if e.site == "B" and token_a in text:
            leaks.append(f"A's token reached B in {short(text)}")
        if e.site == "A" and token_b and token_b in text:
            leaks.append(f"B's token reached A in {short(text)}")
    must(not leaks, "; ".join(leaks))
    resumed = d.since(mark_a, lambda e: (auth_params(e, "A") or {}).get("token") == token_a)
    d.note("the client resumed its session on A with A's token" if resumed
           else "the client did not resume its session on A with A's token")


@test("external.shape.query-kept", "4.12.1", "keeps external.url's own query, and adds its parameters")
async def _(d):
    flow = await baseline(d)
    q = page_query(d, flow)
    pairs = d.requests[flow.page.req].pairs
    must(d.requests[flow.page.req].path == "/authorize", f"the client opened {d.requests[flow.page.req].path}")
    lost = [k for k, v in (("scope", "apron"), ("provider", "conformance")) if q.get(k) != v]
    must(not lost, f"the request lost or changed the url's own {', '.join(lost)}: {short(pairs, 200)}")
    missing = [k for k in ("response_type", "client_id", "redirect_uri", "code_challenge", "code_challenge_method",
                           "state", "resource") if not q.get(k)]
    must(not missing, f"the request has no {', '.join(missing)}")
    must(q["response_type"] == "code", f"response_type is {q['response_type']!r}")
    repeated = sorted({k for k, _ in pairs if sum(1 for k2, _ in pairs if k2 == k) > 1})
    should(not repeated, f"the request repeats {', '.join(repeated)}")


@test("external.A3.pkce", "4.12.2", "uses PKCE S256 with a verifier of enough entropy")
async def _(d):
    flow = await baseline(d)
    q = page_query(d, flow)
    must(q.get("code_challenge_method") == "S256", f"code_challenge_method is {q.get('code_challenge_method')!r}")
    params = redemption(d, flow)
    verifier = params.get("code_verifier")
    must(isinstance(verifier, str), "the redemption has no code_verifier")
    must(43 <= len(verifier) <= 128 and UNRESERVED.fullmatch(verifier),
         f"the verifier is {len(verifier)} characters, not 43 to 128 of [A-Za-z0-9._~-] (RFC 7636 §4.1)")
    must(s256(verifier) == q.get("code_challenge"), "the verifier does not match the code_challenge")
    should(len(set(verifier)) >= 16, f"the verifier {verifier!r} uses only {len(set(verifier))} distinct characters")
    problems = next((e.problems for e in d.since(flow.delivered.i, lambda e: e.kind == "redeem" and e.code == params.get("code"))), None)
    if problems:
        d.note("the driver refused the redemption: " + "; ".join(problems))


@test("external.A4.state", "4.12.2", "sends a state, and a different one on each sign-in")
async def _(d):
    flow = await baseline(d)
    first = page_query(d, flow).get("state")
    must(first, "the request has no state")
    should(len(first) >= 16, f"state {first!r} is short to be unguessable")
    second = await d.cached("second", lambda: external_flow(d))
    again = page_query(d, second).get("state")
    must(again, "the second request has no state")
    must(again != first, "both sign-ins sent the same state")
    verifiers = [auth_params(f.redeem).get("code_verifier") for f in (flow, second) if f.redeem and f.redeem.kind == "frame"]
    must(len(verifiers) < 2 or verifiers[0] != verifiers[1], "both sign-ins used the same code_verifier")


@test("external.A1.resource", "4.12.2", "sends the connected server's origin as resource, also with a foreign issuer")
async def _(d):
    flow = await baseline(d)
    origin = server_origin("ws", opened_host(d, flow.begin.conn))
    resource = page_query(d, flow).get("resource")
    must(resource == origin, f"resource is {resource!r}, not {origin}, the origin of the address it connected to")

    def foreign(site, conn):
        b = f"{split_host(conn.host)[0]}:{d.sites['B'].port}"
        return {"external": {"url": f"http://{b}/authorize?scope=apron", "issuer": f"http://{b}"}}

    other = await d.cached("foreign-issuer", lambda: external_flow(d, begin=foreign))
    q = page_query(d, other)
    must(d.requests[other.page.req].site == "B", "the client did not open the url on B")
    must(q.get("resource") == origin,
         f"with an issuer on B, resource is {q.get('resource')!r}, not {origin}, the server it is connected to")


async def negative_flow(d, mode, **kwargs):
    """A hostile flow, after the baseline: a client that did not finish a normal sign-in proves nothing by refusing."""
    try:
        base = await baseline(d)
        if not base.redeem:
            raise Incomplete("the client did not redeem a good answer either")
        return await external_flow(d, mode, **kwargs)
    except Incomplete as e:
        raise Skip(str(e))


@test("external.A4.wrong-state", "4.12.2", "does not redeem after a redirect with another state")
async def _(d):
    flow = await negative_flow(d, "wrong_state")
    if flow.redeem:
        raise Fail(f"the client redeemed the code: {short(flow.redeem.frame or flow.redeem.code, 160)}")
    if flow.stopped:
        d.note(f"the client stopped: {flow.stopped.event.get('reason')}")


@test("external.shape.declined", "4.12.2", "after error=access_denied, sends nothing and stops")
async def _(d):
    flow = await negative_flow(d, "decline")
    sent = [e for e in flow.after if auth_params(e) is not None]
    if any("code" in auth_params(e) for e in sent):
        raise Fail(f"after the decline, the client redeemed a code: {short(sent[0].frame, 160)}")
    # No rule forbids a new begin after a decline, but the user declined: a client that starts again loops.
    should(not sent, f"after the decline, the client sent {short(sent[0].frame if sent else '', 160)}")
    if flow.stopped:
        d.note(f"the adapter reported that the client stopped: {flow.stopped.event.get('reason')}")
    elif d.adapter:
        d.note("the adapter did not report that the client stopped")


@test("external.shape.reconnect", "4.12.2", "after a dropped connection mid-sign-in, reconnects and redeems")
async def _(d):
    dropped = []

    async def drop(req):
        dropped.append(len(d.log))
        await d.sites["A"].drop()
        await d.until(lambda e: False, timeout=0.3)

    flow = await external_flow(d, on_page=drop)
    must(dropped, "the driver did not drop the connection (driver bug)")
    must(flow.redeem is not None, "the client did not redeem the code after the connection dropped")
    redeemed = d.since(flow.delivered.i, lambda e: e.kind == "redeem" and e.code == d.requests[flow.page.req].code)
    must(not redeemed or not redeemed[0].problems, "the redemption was refused: " + "; ".join(redeemed[0].problems if redeemed else []))
    if flow.redeem.kind == "frame":
        d.note(f"redeemed on {'a new connection' if flow.redeem.conn != flow.begin.conn else 'the begin connection'} to {flow.redeem.site}")


@test("external.A2.url-scheme", "4.12.1", "does not open a begin url that is not https or loopback http")
async def _(d):
    try:
        base = await baseline(d)
    except Incomplete as e:
        raise Skip(str(e))
    if not base.page:
        raise Skip("the client did not open a good url either")
    bad = [lambda site, conn: {"external": {"url": f"javascript:void(location.href='{conn.page_base}/ran-javascript')"}}]
    if not d.interactive:
        bad.append(lambda site, conn: {"external": {"url": "http://conformance.invalid/authorize"}})
    else:
        d.note("only the javascript: url is checked: a person's browser cannot report a non-loopback http url")
    for begin in bad:
        start = await d.fresh(A=Config(auth=["external", "token"], begin=begin))
        await d.connect("A", start)
        await d.do("sign_in", scheme="external")
        began = await d.until(lambda e: is_begin(auth_params(e, "A")), start)
        if not began:
            raise Skip("the client sent no external begin")
        url = next((e.frame["result"]["external"]["url"] for e in d.since(began.i)
                    if e.kind == "sent" and "external" in e.frame.get("result", {})), "the url")
        opened = await d.until(lambda e: e.kind in ("canary", "foreign", "page"), began.i, timeout=d.quiet_window(), stop=True)
        must(opened is None, f"the client opened {short(url, 80)}" + (" and ran it" if opened and opened.kind == "canary" else ""))


@test("external.A1.iss", "ext:oauth", "a token endpoint client does not redeem after a redirect with the wrong iss")
async def _(d):
    if d.interactive or not d.caps.get("token_endpoint"):
        raise Skip("the client redeems on the connection, and need not read issuer (§4.12.1); "
                   "this applies to clients that redeem at a token endpoint (ready: token_endpoint)")

    def begin(site, conn):
        return {"external": {"url": f"{conn.page_base}/authorize", "issuer": d.issuer}}

    async def issuer_flow(mode):
        async def on_page(req):
            d.iss = d.issuer  # fresh() clears it; the page answers with it
        return await external_flow(d, mode, begin=begin, on_page=on_page)

    try:
        good = await d.cached("issuer", lambda: issuer_flow("approve"))
        if not good.redeem:
            raise Incomplete("the client did not redeem a good answer either")
        if good.redeem.kind != "token-endpoint":
            d.note("the client redeemed the good answer on the connection, not at the token endpoint")
    except Incomplete as e:
        raise Skip(str(e))
    flow = await issuer_flow("wrong_iss")
    must(not flow.redeem, f"the client redeemed a code whose iss is {d.sites['B'].origin}, not {d.issuer}")


@test("webauthn.A1.rp-id", "4.10", "does not run a ceremony for another RP ID, and uses the passkey page instead")
async def _(d):
    rp_id = d.rp_id
    if not rp_id:
        raise Skip("needs an RP ID that the client's platform accepts and holds a passkey for: the adapter's ready "
                   "rp_id, or --rp-id in interactive mode")
    if not d.can("webauthn"):
        raise Skip("the adapter cannot drive webauthn")

    def begin(site, conn, params):
        action = params.get("action") if params.get("action") in ("login", "register") else "login"
        challenge = b64url(secrets.token_bytes(32))
        if action == "login":
            public_key = {"challenge": challenge, "rpId": rp_id, "userVerification": "required", "timeout": 60000}
        else:
            public_key = {"challenge": challenge, "rp": {"id": rp_id, "name": "Conformance"},
                          "user": {"id": b64url(secrets.token_bytes(16)), "name": "conformance", "displayName": "Conformance"},
                          "pubKeyCredParams": [{"type": "public-key", "alg": -7}, {"type": "public-key", "alg": -257}],
                          "authenticatorSelection": {"residentKey": "required", "userVerification": "required"},
                          "timeout": 60000}
        return {"challenge_id": "ch_" + secrets.token_urlsafe(12), "public_key": public_key,
                "external": {"url": f"{conn.page_base}/passkey?action={action}"}}

    start = await d.fresh(A=Config(auth=["webauthn", "token"], webauthn_begin=begin))
    d.page_hint = "Press Approve."
    opened = await d.connect("A", start)
    host = split_host(opened.host)[0].lower()
    if host == rp_id or host.endswith("." + rp_id):
        raise Skip(f"the server's host {host} is under the RP ID {rp_id}: connect by another name")
    await d.do("sign_in", scheme="webauthn",
               say=f"Sign in to {d.sites['A'].address} with a passkey now (press Approve if a sign-in page opens)")
    began = await d.until(lambda e: is_begin(auth_params(e, "A"), "webauthn")
                          and auth_params(e).get("step") == "begin", start)
    if not began:
        raise Skip("the client sent no webauthn begin")

    def finish(e):
        params = auth_params(e)
        return params is not None and params.get("scheme") == "webauthn" and params.get("step") == "finish"

    done = await d.until(finish, began.i)
    if done is None:
        raise Warn(f"the client neither ran the ceremony nor used the passkey page (external) within {d.wait:.0f} s")
    params = auth_params(done)
    must("credential" not in params, f"the client ran a ceremony for RP ID {rp_id}, which is not {host} or above it, "
                                     "and sent its credential")
    must("code" in params, f"the finish has neither credential nor code: {short(params, 120)}")
    page = next((e for e in d.since(began.i, lambda e: e.kind == "page" and e.path == "/passkey")), None)
    must(page is not None, "the finish has a code, but the client did not open the passkey page")
    problems = next((e.problems for e in d.since(done.i, lambda e: e.kind == "redeem" and e.code == params.get("code"))), [])
    if problems:
        d.note("the driver refused the finish: " + "; ".join(problems))


@test("email.A1.link-server", "4.11.2", "drops a link with its proposal's state whose server is another server")
async def _(d):
    if not d.can("email"):
        raise Skip("the adapter cannot drive email")
    address = "conformance@example.com"

    async def propose():
        start = await d.fresh(A=offering("email"), B=offering("email"))
        await d.connect("A", start)
        await d.do("sign_in", scheme="email", email=address,
                   say=f"Sign in to {d.sites['A'].address} with email, as {address}")
        proposal = await d.until(lambda e: e.kind == "proposal" and e.site == "A", start)
        if not proposal:
            raise Skip("the client sent no email proposal")
        if not proposal.state:
            raise Skip("the proposal carried no state, so the rule for links with a proposal's state does not apply")
        return proposal

    def link(token, state, key):
        server = d.sites[key].address
        return "https://link.apron.chat/#" + urllib.parse.urlencode(
            {"token": token, "state": state, "server": server}, safe=":/")

    proposal = await propose()
    token = "em_" + secrets.token_urlsafe(24)
    d.sites["B"].email_tokens[token] = {"user_id": "email_b", "name": "Conformance"}
    mark = len(d.log)
    await d.do("open_link", url=link(token, proposal.state, "B"))
    used = await d.until(lambda e: e.kind == "frame" and token in e.raw, mark, timeout=d.quiet_window(), stop=True)
    must(used is None, f"the client sent the token of a link that names B, with the state of its proposal to A, to "
                       f"{used.site if used else ''}: {short(used.frame if used else '', 120)}")
    # The control: the same kind of link, naming the server it proposed to, is used.
    proposal = await propose()
    token = "em_" + secrets.token_urlsafe(24)
    d.sites["A"].email_tokens[token] = {"user_id": "email_a", "name": "Conformance"}
    mark = len(d.log)
    await d.do("open_link", url=link(token, proposal.state, "A"))
    used = await d.until(lambda e: e.kind == "frame" and token in e.raw, mark)
    if used is None:
        raise Skip("the client did not use a link that names the server it proposed to either, so dropping the other "
                   "proves nothing")


@test("external.A2.webview", "4.12.2", "opens the sign-in page in the system browser or a sign-in session")
async def _(d):
    raise Manual("check that the client opens external.url in the system browser or a sign-in session "
                 "(such as ASWebAuthenticationSession or Custom Tabs), never in an embedded web view")


@test("core.shape.schema", "1", "every frame the client sent matches schema/apron.schema.json")
async def _(d):
    if not d.schema.schema:
        raise Skip(f"{SCHEMA_PATH} not found")
    found = sorted(set(d.violations))
    must(not found, "; ".join(found[:3]) + (f" (+{len(found) - 3} more)" if len(found) > 3 else ""))


def selected(tid, patterns):
    return not patterns or any(fnmatch.fnmatchcase(tid, p) for p in patterns)


async def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--adapter", metavar="COMMAND", help="the adapter command line, run with a shell")
    mode.add_argument("--interactive", action="store_true", help="a person drives the client, as the driver says")
    parser.add_argument("--listen", default="127.0.0.1:38765",
                        help="HOST:PORT of server A; B listens on PORT+1, the issuer on PORT+2 (default %(default)s)")
    parser.add_argument("--rp-id", help="interactive mode: a WebAuthn RP ID that the client's platform accepts and "
                                        "holds a passkey for, which enables webauthn.A1.rp-id")
    parser.add_argument("--only", action="append", metavar="PATTERN",
                        help="run only the tests whose ID matches this glob, such as 'external.A4.*'; repeatable")
    parser.add_argument("--list", action="store_true", help="list the tests, and exit")
    parser.add_argument("--json", metavar="PATH", help="write the results as JSON")
    parser.add_argument("--wait", type=float, help=f"seconds to wait for the client to act "
                                                   f"(default {WAIT:.0f}, interactive {PERSON_WAIT:.0f})")
    parser.add_argument("--quiet", type=float, default=QUIET,
                        help="seconds to wait for a frame that should not come (default %(default)s)")
    parser.add_argument("-v", "--verbose", action="store_true",
                        help="print every frame and event, the adapter's stderr, and tracebacks")
    args = parser.parse_args()
    patterns = args.only or []
    if args.list:
        for tid, section, title, _ in TESTS:
            print(f"{tid:<26} {'§' + section if section[:1].isdigit() else section:<9} {title}")
        return 0
    if not (args.adapter or args.interactive):
        parser.error("one of --adapter or --interactive is required")
    logging.getLogger("websockets").setLevel(logging.CRITICAL)
    d = Driver(args)
    loop = asyncio.get_running_loop()
    started = now_rfc3339()
    servers = []
    for site in d.sites.values():
        servers.append(await serve(site.serve, d.host, site.port, process_request=site.process_request,
                                   max_size=2**20, ping_interval=None))
    issuer = d.start_issuer(loop)
    if not d.schema.schema:
        print(f"note: {SCHEMA_PATH} not found; frames are not validated against the schema")
    print(f"servers: A {d.sites['A'].address}, B {d.sites['B'].address}, issuer {d.issuer}", flush=True)
    if args.adapter:
        d.adapter = Adapter(d, args.adapter)
        d.caps = await d.adapter.start()
        print(f"adapter: {d.caps.get('name', args.adapter)}, schemes {', '.join(d.caps.get('schemes', [])) or 'none'}"
              + (", token endpoint" if d.caps.get("token_endpoint") else "")
              + (f", RP ID {d.caps['rp_id']}" if d.caps.get("rp_id") else ""), flush=True)
    results, counts = [], {}
    try:
        for tid, section, title, fn in TESTS:
            if not selected(tid, patterns):
                continue
            status, detail, mark = "PASS", "", len(d.log)
            try:
                if d.adapter and d.adapter.gone:
                    raise Skip(d.adapter.gone)
                await fn(d)
            except Fail as e:
                status, detail = "FAIL", str(e)
            except Warn as e:
                status, detail = "WARN", str(e)
            except Skip as e:
                status, detail = "SKIP", str(e)
            except Manual as e:
                status, detail = "MANUAL", str(e)
            except Incomplete as e:
                status, detail = "FAIL", str(e)
            except Exception as e:  # a crash is reported as the test's failure, with the cause
                status, detail = "FAIL", f"{type(e).__name__}: {e}"
                if args.verbose:
                    traceback.print_exc()
            errors = [e.error for e in d.since(mark) if e.kind == "driver-error"]
            if errors and status in ("PASS", "WARN"):
                status, detail = "SKIP", f"the driver failed, so the result is unknown: {errors[0]}"
            counts[status] = counts.get(status, 0) + 1
            label = f"§{section}" if section[:1].isdigit() else section
            print(f"{status:<6} {tid:<26} {label:<9} {title}" + (f": {detail}" if detail else ""), flush=True)
            for note in d.notes:
                print(f"       note: {note}", flush=True)
            results.append({"id": tid, "section": section, "status": status,
                            "message": title + (f": {detail}" if detail else ""), "notes": list(d.notes)})
            d.notes.clear()
    finally:
        if d.adapter:
            await d.adapter.quit()
        for server in servers:
            server.close()
        issuer.shutdown()
    print(", ".join(f"{counts.get(s, 0)} {s.lower()}" for s in ("PASS", "FAIL", "WARN", "SKIP", "MANUAL")))
    if args.json:
        report = {"tool": "conform_client.py", "version": VERSION,
                  "target": args.adapter if args.adapter else "interactive", "started": started, "results": results,
                  "summary": {s: counts.get(s, 0) for s in ("PASS", "FAIL", "WARN", "SKIP", "MANUAL")}}
        Path(args.json).write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n")
    return 1 if counts.get("FAIL") else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
