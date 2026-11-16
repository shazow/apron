#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = ["websockets>=14,<17", "jsonschema>=4.18", "cryptography>=42"]
# ///
"""Check a running Apron server against PROTOCOL.md.

Connects to a WebSocket URL, runs the core checklist (§3.6) and checks for each
capability and sign-in scheme that the server advertises, and prints one line
per check, with its stable ID and section: PASS, FAIL (a rule the server
breaks), WARN (a SHOULD it does not follow), SKIP (with the reason), or MANUAL
(a rule a machine cannot check, listed again at the end for a person). Every
server frame is also validated against schema/apron.schema.json. Exits 1 if
any check fails; MANUAL never fails.

IDs are <scheme or area>.<area>.<name>, where the middle area is an attacker of
the threat model (A1 to A5) or a plain area such as shape: external.A3.verifier,
core.shape.server-frame. --list prints them. --only runs the checks whose IDs
match a glob, --scheme one sign-in scheme's profile and the core checks, and
--json writes a report for CI. A refusal by the server's policy, such as a
guest who may only read, skips a check with the server's message.

It signs in as a guest, or with --token. Guests are created and messages
posted, so point it at a test server.

Most sign-in checks need no person: what webauthn and external begins return, how
the sign-in pages (§4.10.1, §4.12.3) answer well-formed and invalid requests,
their headers, made-up codes and tokens, email proposals, ext:oauth's metadata
and token endpoint, and a WebAuthn ceremony in the client with a software
authenticator, from --origin (default: the server's own origin).

With --sign-in, someone also signs in on each page. conform.py listens on a
loopback redirect URI and sends each sign-in there. A person signs in in a
browser: conform.py prints each page's address, tries to open a browser
(BROWSER=true only prints), and catches the redirect. With --portal COMMAND, a
program signs in instead, such as portals/passkey.cjs, which drives Chromium
with a virtual passkey authenticator (DEVELOPMENT.md, Conformance, for the
interface). It then checks the redirect, that a code redeems once and only with
its code_verifier, redirect_uri, client_id, and scheme, that the token works
from another Origin, that a code for a new identity adds it to a signed-in
account and one for another account's identity is denied, and a declined
sign-in. That is about ten sign-ins, and more on a server where a failed try
uses up a code.

Not covered: completing an email sign-in, another authorization server's
tokens, ext:oauth's identity provider, push registration, token rotation,
compaction, and redaction.

Run from the repository root:
  uv run tests/conformance/conform.py ws://127.0.0.1:8765
  uv run tests/conformance/conform.py wss://chat.example/ws --token SECRET
  uv run tests/conformance/conform.py wss://chat.example/ws --sign-in
  uv run tests/conformance/conform.py wss://chat.example/ws --portal "node tests/conformance/portals/passkey.cjs" \\
      --json report.json
"""

import argparse
import asyncio
import base64
import codecs
import datetime
import fnmatch
import hashlib
import http.server
import ipaddress
import itertools
import json
import re
import os
import secrets
import shlex
import socket
import ssl
import shutil
import sys
import tempfile
import threading
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from pathlib import Path

from jsonschema import Draft202012Validator
from websockets.asyncio.client import connect
from websockets.client import ClientProtocol
from websockets.exceptions import ConnectionClosed, InvalidStatus
from websockets.frames import Opcode
from websockets.http11 import Response
from websockets.uri import parse_uri

VERSION = 10
WAIT = 2.0  # seconds to wait for an expected frame
QUIET = 0.5  # seconds to wait for a frame that should not come
MISSING = "9007199254740991"  # a log_id no test server has reached (2^53 - 1)
BURST = 12  # messages a burst posts at once, without waiting for each result
# Messages of SLOW_TEXT bytes posted to a reader that has stopped reading: 8 MiB, past what the kernel buffers
# for a socket (Linux grows a send buffer up to 4 MiB by default), so the server's own writes back up.
SLOW_BURST = 512
SLOW_TEXT = 16384
CODES = {"parse_error": -32700, "invalid_request": -32600, "unsupported": -32601,
         "invalid_params": -32602, "internal_error": -32603, "denied": -32001,
         "retry_after": -32002, "too_large": -32003}
KNOWN = {
    "capability": {"command", "history", "rooms", "edit", "status", "activity", "reactions",
                   "embed:upload", "embed:append", "embed:terminal", "ext"},
    "auth scheme": {"guest", "token", "webauthn", "email", "external"},
}
SCHEMA_PATH = Path(__file__).resolve().parents[2] / "schema/apron.schema.json"
ids = (f"conf{n}" for n in itertools.count(1))


class Fail(Exception): pass
class Warn(Exception): pass
class Skip(Exception): pass
class Manual(Exception): pass  # a rule that a machine cannot check: a checklist item for a person


def must(condition, why):
    if not condition:
        raise Fail(why)


def should(condition, why):
    if not condition:
        raise Warn(why)


def code(reply):
    return reply.get("error", {}).get("code")


def describe(reply):
    if "error" in reply:
        error = reply["error"]
        name = next((k for k, v in CODES.items() if v == error.get("code")), error.get("code"))
        return f"error/{name} ({error.get('message')!r})"
    return f"result {json.dumps(reply.get('result'))[:120]}"


def expect_error(reply, name, what):
    must(code(reply) == CODES[name], f"{what}: expected error/{name}, got {describe(reply)}")


def offers(*schemes):
    return lambda s: all(name in s.get("auth", []) + s.get("signup", []) for name in schemes)


def signed_in(reply):
    return isinstance(reply, dict) and isinstance(reply.get("result", {}).get("you"), dict)


def policy(reply):
    """Skip the check when the server's policy refused a request with retry_after."""
    if code(reply) == CODES["retry_after"]:
        raise Skip(f"the server's policy refused it: {describe(reply)}")


async def unless_policy(reply, what, control=None):
    """Skip the check when the server's policy refused the request: retry_after, or denied, which §1.1 allows for a
    well-formed request that the user or the server does not allow, such as a guest who may only read.

    control, if given, is a function that sends a request that the same policy treats alike, but that the rule
    under test allows, such as the same request for a room that exists. Then denied is policy only if control is
    denied too; otherwise the check goes on, and fails on the denied reply."""
    policy(reply)
    if code(reply) != CODES["denied"]:
        return
    if control is not None and code(await control()) != CODES["denied"]:
        return
    raise Skip(f"the server's policy refused {what}: {describe(reply)}")


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


class SlowSocket:
    """A WebSocket client that reads from its socket only while it is iterated, with small buffers, so that a reader
    that stops leaves what the server sends in the kernel and the server's own writes back up. (A websockets client
    keeps reading the socket into memory whether or not anyone takes the frames.) Enough of a websockets connection
    for Conn: iterate for text frames, send, close."""

    def __init__(self, protocol, reader, writer):
        self.protocol, self.reader, self.writer, self.pending = protocol, reader, writer, []

    @classmethod
    async def open(cls, url):
        parts = urllib.parse.urlsplit(url)
        tls = ssl.create_default_context() if parts.scheme == "wss" else None
        loop = asyncio.get_running_loop()
        sock = await cls.connect(loop, parts.hostname, parts.port or (443 if tls else 80))
        reader, writer = await asyncio.open_connection(sock=sock, ssl=tls, server_hostname=parts.hostname if tls else None,
                                                       limit=16384)
        conn = cls(ClientProtocol(parse_uri(url), max_size=None), reader, writer)
        conn.protocol.send_request(conn.protocol.connect())
        await conn.flush()
        while True:
            data = await asyncio.wait_for(reader.read(65536), WAIT)
            if not data:
                raise OSError("closed during the handshake")
            conn.protocol.receive_data(data)
            events = conn.protocol.events_received()
            for i, event in enumerate(events):
                if isinstance(event, Response):
                    if event.status_code != 101:
                        raise OSError(f"handshake answered {event.status_code}")
                    conn.pending = events[i + 1:]  # frames that came with the handshake's answer
                    return conn

    @staticmethod
    async def connect(loop, host, port):
        """A connected socket with a small receive buffer, to the first of host's addresses that answers, as other
        clients try them: localhost can resolve to ::1 first while a server listens on 127.0.0.1 only."""
        error = OSError(f"no address for {host}")
        for family, kind, proto, _, address in await loop.getaddrinfo(host, port, type=socket.SOCK_STREAM):
            try:
                sock = socket.socket(family, kind, proto)
            except OSError as failed:
                error = failed
                continue
            try:
                sock.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 8192)
                sock.setblocking(False)
                await asyncio.wait_for(loop.sock_connect(sock, address), WAIT)
                return sock
            except (OSError, asyncio.TimeoutError) as failed:
                sock.close()
                error = failed if isinstance(failed, OSError) else OSError(f"timed out connecting to {address}")
        raise error

    async def flush(self):
        for data in self.protocol.data_to_send():
            if data:
                self.writer.write(data)
        await self.writer.drain()

    async def __aiter__(self):
        parts, events = [], self.pending
        while True:
            for frame in events:
                if frame.opcode in (Opcode.TEXT, Opcode.BINARY, Opcode.CONT):
                    parts.append(frame.data)
                    if frame.fin:
                        yield b"".join(parts).decode()
                        parts = []
                elif frame.opcode == Opcode.CLOSE:
                    return
            data = await self.reader.read(16384)
            if not data:
                return
            self.protocol.receive_data(data)
            events = self.protocol.events_received()
            await self.flush()  # answers pings

    async def send(self, text):
        try:
            self.protocol.send_text(text.encode())
            await self.flush()
        except (OSError, RuntimeError) as error:
            raise ConnectionClosed(None, None) from error

    async def close(self):
        try:
            self.protocol.send_close()
            await self.flush()
        except Exception:
            pass
        self.writer.close()


async def back_off(retry_after, waited, why, most=60):
    """Wait as a rate limit's Retry-After asks, and return the seconds waited; Skip once most seconds have passed."""
    try:
        delay = min(max(int(retry_after), 1), 30)
    except (TypeError, ValueError):
        delay = 5
    if waited + delay > most:
        raise Skip(why)
    await asyncio.sleep(delay)
    return delay


class Conn:
    """One WebSocket connection: frames in arrival order, and replies matched by id."""

    def __init__(self, run, ws):
        self.run, self.ws = run, ws
        self.frames, self.closed, self.you = [], False, None
        self.shown = {}  # user_id -> (shown status, seen), as this connection last received them
        self.methods = {}  # request id -> method
        self.asked, self.answered = {}, {}
        self.changed = asyncio.Condition()
        self.reading = asyncio.Event()  # cleared: the connection stops reading, and the server's writes back up
        self.reading.set()
        self.reader = asyncio.create_task(self.read())

    async def read(self):
        try:
            async for raw in self.ws:
                await self.reading.wait()
                try:
                    frame = json.loads(raw)
                except ValueError:
                    frame = None
                self.run.inspect(self, frame, raw)
                async with self.changed:
                    self.frames.append(frame)
                    self.changed.notify_all()
        except (ConnectionClosed, OSError):
            pass
        finally:
            async with self.changed:
                self.closed = True
                self.changed.notify_all()

    async def wait(self, match, start=0, timeout=WAIT):
        """Return (index, frame) of the first frame from start that matches, or (None, None)."""
        deadline = time.monotonic() + timeout
        async with self.changed:
            while True:
                for i in range(start, len(self.frames)):
                    if isinstance(self.frames[i], dict) and match(self.frames[i]):
                        return i, self.frames[i]
                left = deadline - time.monotonic()
                if self.closed or left <= 0:
                    return None, None
                try:
                    await asyncio.wait_for(self.changed.wait(), left)
                except asyncio.TimeoutError:
                    pass

    async def expect(self, match, why, start=0, timeout=WAIT):
        """Like wait, but fail with why if no frame matches."""
        i, frame = await self.wait(match, start, timeout)
        must(frame, why)
        return i, frame

    async def send(self, frame):
        if "id" in frame:
            self.methods[frame["id"]] = frame["method"]
            self.asked[frame["id"]] = self.asked.get(frame["id"], 0) + 1
        try:
            await self.ws.send(json.dumps(frame))
        except ConnectionClosed:
            raise Fail(f"the server closed the connection before {frame.get('method')}") from None

    async def request(self, method, params=None, id=None):
        """Send a request and return (index, reply)."""
        id = id or next(ids)
        frame = {"method": method, "id": id, **({} if params is None else {"params": params})}
        start = len(self.frames)
        await self.send(frame)
        i, reply = await self.reply(id, start)
        if reply is None:
            raise Fail(f"no reply to {method}" + (" (connection closed)" if self.closed else ""))
        return i, reply

    async def reply(self, id, start=0, timeout=WAIT):
        return await self.wait(lambda f: f.get("id") == id and "method" not in f, start, timeout)

    async def call(self, method, params=None):
        """Send a request, fail on an error reply, and return the result."""
        _, reply = await self.request(method, params)
        must("result" in reply, f"{method}: {describe(reply)}")
        return reply["result"]

    async def notify(self, method, params=None):
        await self.send({"method": method, **({} if params is None else {"params": params})})

    async def sync(self):
        """Wait for a round trip, then a little longer, so earlier replies have arrived."""
        await self.request("me", {})
        await asyncio.sleep(QUIET)

    def since(self, start, match):
        return [f for f in self.frames[start:] if isinstance(f, dict) and match(f)]


async def reply_to(conn, method, params):
    """Send a request, and return its reply."""
    return (await conn.request(method, params))[1]


def snapshot_of(message_id, room_id=None):
    return lambda f: (f.get("method") == "message" and f.get("params", {}).get("message_id") == message_id
                      and (room_id is None or f["params"].get("room_id") == room_id))


def room_update(key, room_id):
    return lambda f: (f.get("method") == "room_update"
                      and any(r.get("room_id") == room_id for r in f.get("params", {}).get(key, [])))


def records(frame, key, room_id):
    return [r for r in frame["params"].get(key, []) if r.get("room_id") == room_id]


class Run:
    def __init__(self, args):
        self.args, self.schema = args, Schema()
        self.server, self.room, self.message = None, None, None  # learned along the way
        self.violations = {}  # check key -> set of descriptions, from inspect
        self.order = {}  # (conn, room_id) -> greatest message log_id delivered
        self.conns = []  # of the running check
        self.notes = []  # of the running check, printed under its line
        self.person = Person() if args.sign_in else None  # --sign-in
        self.begun, self.pages, self.oauth, self.flows = {}, {}, {}, {}  # sign-in answers, kept for later checks
        self.burned = None  # whether a failed redemption used up a code on this server, once a sign-in tells

    def violate(self, key, text):
        self.violations.setdefault(key, set()).add(text)

    def profile(self, scheme):
        """Whether --scheme selects the scheme's profile (every profile runs without --scheme)."""
        return not self.args.scheme or scheme in self.args.scheme

    def has(self, capability):
        return capability in self.server.get("capabilities", [])

    def info(self, text):
        self.notes.append(text)

    # Every frame from the server passes through here.
    def inspect(self, conn, frame, raw):
        if not isinstance(frame, dict):
            return self.violate("schema", f"not a JSON object: {raw[:80]!r}")
        if not conn.frames and frame.get("method") != "server":
            self.violate("server-first", f"first frame was {raw[:80]!r}")
        for error in self.schema.errors(frame, "ServerFrame"):
            self.violate("schema", f"{frame.get('method', 'reply')}: {error}")
        if "method" not in frame and "id" in frame:
            rid = frame["id"]
            conn.answered[rid] = conn.answered.get(rid, 0) + 1
            if conn.answered[rid] > conn.asked.get(rid, 0):
                self.violate("replies", f"unexpected reply to id {rid!r}")
            method = conn.methods.get(rid, "")
            name = "".join(p.capitalize() for p in method.split("_")) + "Result"
            if "result" in frame:
                for error in self.schema.errors(frame["result"], name):
                    self.violate("schema", f"{method} result: {error}")
        self.check_ids(frame)
        params = frame.get("params", {})
        if frame.get("method") == "message" and isinstance(params, dict) and "log_id" in params:
            key = (conn, params.get("room_id"))
            if key in self.order and int(params["log_id"]) <= self.order[key]:
                self.violate("order", f"room {params.get('room_id')}: {params['log_id']} after {self.order[key]}")
            self.order[key] = max(self.order.get(key, 0), int(params["log_id"]))
        if self.server and self.has("history"):
            self.check_room_records(frame)
        self.check_seen(conn, frame)

    def check_seen(self, conn, frame):
        """seen changes only when the shown status changes to offline (§4.5.2)."""
        params, result = frame.get("params"), frame.get("result")
        users = []
        if frame.get("method") == "user" and isinstance(params, dict) and isinstance(params.get("new"), dict):
            users.append((params["new"], True))
        for container in (result, params if frame.get("method") == "room_update" else None):
            if isinstance(container, dict) and isinstance(container.get("users"), list):
                users += [(u, False) for u in container["users"] if isinstance(u, dict)]
        for user, notification in users:
            if "status" not in user or "user_id" not in user:
                continue
            before = conn.shown.get(user["user_id"])
            status, seen = user["status"], user.get("seen")
            if status == "offline" and before and before[0] == "offline":
                if seen is not None and before[1] is not None and seen != before[1]:
                    self.violate("shown-seen", f"seen of {user['user_id']} changed from {before[1]} to {seen} while the shown status stayed offline")
                seen = seen or before[1]
            elif status == "offline" and notification and seen is None and any(v[1] for v in conn.shown.values()):
                self.violate("shown-seen", f"the user notification that changed {user['user_id']} to offline carries no seen")
            if status == "offline" and not notification and "seen" not in user and any(v[1] for v in conn.shown.values()):
                self.violate("shown-seen", f"the complete user object of {user['user_id']} has a shown offline and no seen")
            conn.shown[user["user_id"]] = (status, seen)

    def check_ids(self, value, key=None):
        if isinstance(value, list):
            for item in value:
                self.check_ids(item, key)
        elif isinstance(value, dict):
            for k, v in value.items():
                if k not in ("ext", "og", "push"):
                    self.check_ids(v, k)
        elif key and isinstance(value, str):
            if key.endswith("room_id") or key == "user_id":
                if not value or re.search(r"[\s\x00-\x1f\x7f]", value):
                    self.violate("ids", f"{key} {value!r} is empty or has whitespace or control characters")
            elif key.endswith("log_id") or key.endswith("message_id"):
                if not re.fullmatch(r"[1-9][0-9]*", value) or int(value) >= 2**53:
                    self.violate("ids", f"{key} {value!r} is not a positive decimal below 2^53")

    def check_room_records(self, frame):
        """room_list and room_update records carry log_id and the delivery fields of §4.3.3."""
        result, params = frame.get("result", {}), frame.get("params", {})
        rooms = []
        if isinstance(result, dict):
            rooms += result.get("joined", []) + result.get("not_joined", [])
        if frame.get("method") == "room_update" and isinstance(params, dict):
            rooms += params.get("joined", []) + params.get("updated", [])
        for room in rooms:
            missing = [k for k in ("log_id", "latest_log_id", "history_log_id") if k not in room]
            if isinstance(room, dict) and missing:
                self.violate("listed-rooms", f"room {room.get('room_id')} lacks {', '.join(missing)}")

    async def open(self, auth=True, name="Conformance", small_buffers=False, origin=None):
        """Open a connection, wait for its server frame, and sign in. With small_buffers, its socket's receive
        buffer and the frames queued unread are small, so a connection that stops reading backs up the server's
        writes after little traffic. With origin, the handshake sends that Origin header."""
        waited = 0
        for attempt in itertools.count():
            try:
                if small_buffers:
                    ws = await SlowSocket.open(self.args.url)
                else:
                    ws = await connect(self.args.url, max_size=None, open_timeout=WAIT, origin=origin)
                break
            except InvalidStatus as error:
                status = error.response.status_code
                if status not in (429, 503):
                    raise
                waited += await back_off(error.response.headers.get("Retry-After"), waited,
                                         f"the server's policy refused a connection: HTTP {status}")
            except (OSError, asyncio.TimeoutError) as error:
                if attempt >= 20:
                    raise Fail(f"cannot connect: {error}") from None
                await asyncio.sleep(0.25)
        conn = Conn(self, ws)
        self.conns.append(conn)
        _, server = await conn.wait(lambda f: f.get("method") == "server")
        must(server is not None, "no server frame on connect")
        self.server = self.server or server["params"]
        if auth:
            conn.you = (await conn.call("auth", self.auth(name)))["you"]
        return conn

    def auth(self, name):
        if self.args.token:
            return {"scheme": "token", "token": self.args.token, "name": name}
        if "guest" in self.server.get("auth", []) + self.server.get("signup", []):
            return {"scheme": "guest", "name": name}
        raise Skip("no guest scheme; pass --token")

    async def joined(self, name="Conformance", small_buffers=False):
        """Open a signed-in connection that receives the deliveries of the default room."""
        if not self.room:
            raise Skip("the default room is unknown")
        conn = await self.open(name=name, small_buffers=small_buffers)
        if self.has("rooms"):
            await conn.call("room_join", {"room_id": self.room})
        return conn

    async def post(self, conn, text, **params):
        """Post a message, and return (result index, message_id)."""
        i, reply = await conn.request("message", {"room_id": self.room, "body": {"text": text}, **params})
        must("result" in reply and isinstance(reply["result"].get("message_id"), str),
             f"posting: {describe(reply)}")
        return i, reply["result"]["message_id"]


CHECKS = []
# The first part of a check's ID that makes it part of a scheme's profile (--scheme); other checks are core.
PROFILES = {"guest": {"guest"}, "token": {"token"}, "webauthn": {"webauthn"}, "email": {"email"},
            "external": {"external"}, "oauth": {"external"}}


class Check:
    def __init__(self, id, ref, title, needs, fn, schemes, setup):
        self.id, self.ref, self.title, self.needs, self.fn, self.setup = id, ref, title, needs, fn, setup
        self.schemes = schemes if schemes is not None else PROFILES.get(id.split(".")[0], set())


def check(id, ref, title, needs=None, schemes=None, setup=False):
    """Register a check. id is stable: <scheme or area>.<area>.<name>, where the middle area is an attacker of the
    threat model (A1 to A5) or a plain area such as shape. ref is the PROTOCOL.md section. schemes overrides the
    profiles (--scheme) that the check belongs to. A setup check learns what later checks use, such as the default
    room, so it also runs, unreported, when --only or --scheme leaves it out."""
    assert re.fullmatch(r"[a-z0-9:]+\.[A-Za-z0-9-]+\.[a-z0-9-]+", id), id
    assert all(c.id != id for c in CHECKS), id

    def wrap(fn):
        CHECKS.append(Check(id, ref, title, needs, fn, schemes, setup))
        return fn
    return wrap


def manual(id, ref, title, needs=None, how=None, schemes=None):
    """Register a rule that a machine cannot check: a MANUAL item, for a person to check."""
    async def fn(run):
        raise Manual(how(run) if callable(how) else how or "check it by hand")
    check(id, ref, title, needs, schemes)(fn)


# §3.6 core checklist, with the rules of §1 and §2 it points to.

@check("core.shape.server-frame", "3.1", "sends a server frame on connect", setup=True)
async def _(run):
    await run.open(auth=False)
    s = run.server
    must(s.get("apron") == VERSION, f"apron is {s.get('apron')!r}, not {VERSION}")
    must(isinstance(s.get("auth"), list) and s["auth"], "auth is not a non-empty list")
    for kind, names in (("capability", s.get("capabilities", [])),
                        ("auth scheme", s.get("auth", []) + s.get("signup", []))):
        for name in names:
            must(name in KNOWN[kind] or name.startswith("ext:"), f"unknown {kind} {name!r} lacks ext: (§4)")
    must("server-first" not in run.violations, "; ".join(run.violations.get("server-first", [])))


@check("auth.order.before-auth", "3.2.2", "requests before auth get error/denied")
async def _(run):
    conn = await run.open(auth=False)
    expect_error((await conn.request("me", {}))[1], "denied", "me before auth")


@check("core.shape.ping", "1", "ping before auth gets pong", needs=lambda s: "ping" in s)
async def _(run):
    conn = await run.open(auth=False)
    await conn.notify("ping")
    must((await conn.wait(lambda f: f == {"method": "pong"}))[1], "no exact {\"method\":\"pong\"}")


@check("auth.shape.you", "3.2", "auth replies with you")
async def _(run):
    conn = await run.open(auth=False)
    you = (await conn.call("auth", run.auth("Conformance"))).get("you")
    must(isinstance(you, dict) and isinstance(you.get("user_id"), str), "result has no you.user_id")


@check("auth.order.barrier", "3.2.2", "auth finishes before later frames")
async def _(run):
    conn = await run.open(auth=False)
    await conn.send({"method": "auth", "id": "barrier-auth", "params": run.auth("Conformance")})
    await conn.send({"method": "me", "id": "barrier-me", "params": {}})
    _, auth = await conn.reply("barrier-auth")
    _, me = await conn.reply("barrier-me")
    must(auth and "result" in auth, f"auth: {describe(auth) if auth else 'no reply'}")
    must(me and "result" in me, f"me sent right after auth: {describe(me) if me else 'no reply'}")
    must(me["result"].get("you", {}).get("user_id") == auth["result"]["you"]["user_id"],
         "me ran as a different user than auth")


@check("auth.shape.unknown", "1", "an unknown auth scheme is error/invalid_params")
async def _(run):
    conn = await run.open(auth=False)
    expect_error((await conn.request("auth", {"scheme": "ext:conformance-unknown"}))[1], "invalid_params", "auth with an unknown scheme")


@check("auth.shape.unsupported", "3.2", "a defined scheme the server does not offer is error/unsupported")
async def _(run):
    offered = run.server.get("auth", []) + run.server.get("signup", [])
    params = {"guest": {}, "token": {"token": "conformance"}, "webauthn": {"action": "login", "step": "begin"},
              "email": {"email": "conformance@example.invalid"}, "external": {}}
    missing = [s for s in params if s not in offered]
    if not missing:
        raise Skip("the server offers every scheme that PROTOCOL.md defines")
    for scheme in missing:
        conn = await run.open(auth=False)
        expect_error((await conn.request("auth", {"scheme": scheme, **params[scheme]}))[1], "unsupported", f"auth {scheme}")


@check("auth.order.no-dedup", "1.2", "auth runs on each connection, also when it repeats an id")
async def _(run):
    id = "conformance-auth-" + secrets.token_hex(4)
    first = await run.open(auth=False)
    _, reply = await first.request("auth", run.auth("Conformance"), id=id)
    policy(reply)
    must(signed_in(reply), f"auth: {describe(reply)}")
    # The same request on a new connection signs that connection in, and not from a cache.
    second = await run.open(auth=False)
    _, again = await second.request("auth", run.auth("Conformance"), id=id)
    policy(again)
    must(signed_in(again), f"the same auth, with the same id, on a new connection: {describe(again)}")
    _, me = await second.request("me", {})
    must("result" in me, f"me after it got {describe(me)}: the auth was answered without signing the connection in")
    must(me["result"].get("you", {}).get("user_id") == again["result"]["you"]["user_id"],
         "me runs as another user than the auth's you")
    if not offers("token")(run.server):
        return run.info("the server does not offer token, so a repeat without credentials was not tried")
    # A repeat with a made-up token is answered for that token, as a request with a new id is.
    made_up_token = {"scheme": "token", "token": "conformance-" + secrets.token_urlsafe(24)}
    third = await run.open(auth=False)
    _, repeat = await third.request("auth", made_up_token, id=id)
    policy(repeat)
    _, me = await third.request("me", {})
    if signed_in(repeat):
        must("result" in me, f"a repeat with a made-up token returned you, then me got {describe(me)}: a cached result")
        return run.info("the server's policy accepts a made-up token")
    must(code(me) == CODES["denied"], f"a repeat with a made-up token was refused, then me got {describe(me)}")
    if code(repeat) != CODES["denied"]:
        fresh = await run.open(auth=False)
        _, control = await fresh.request("auth", made_up_token)
        must(code(control) == code(repeat), f"a repeat with a made-up token got {describe(repeat)}, but the same "
                                            f"request with a new id got {describe(control)}: the id was deduplicated")


@check("token.shape.denied", "3.2.1", "a made-up token is denied", needs=offers("token"))
async def _(run):
    conn = await run.open(auth=False)
    _, reply = await conn.request("auth", {"scheme": "token", "token": "conformance-" + secrets.token_urlsafe(24)})
    policy(reply)
    if signed_in(reply):
        raise Skip(f"the server's policy accepts any token (§3.2): {describe(reply)}")
    expect_error(reply, "denied", "a made-up token")


@check("core.message.default-room", "3.6.3", "accepts message without room_id into its default room", setup=True)
async def _(run):
    conn = await run.open()
    i, reply = await conn.request("message", {"body": {"text": "conformance: default room"}})
    await unless_policy(reply, "a post")
    must("result" in reply and isinstance(reply["result"].get("message_id"), str), f"got {describe(reply)}")
    message_id = reply["result"]["message_id"]
    _, snapshot = await conn.wait(snapshot_of(message_id))
    if snapshot:
        must(isinstance(snapshot["params"].get("room_id"), str), "the snapshot has no room_id")
        run.room = snapshot["params"]["room_id"]
    must(run.room or run.has("rooms"), "no broadcast to the poster")
    if not run.room:
        raise Warn("the poster got no broadcast and the room is unknown; later checks skip")


@check("core.message.broadcast-first", "3.6.4", "message creation replies with message_id and broadcasts the snapshot first",
       setup=True)
async def _(run):
    a, b = await run.joined("Conformance A"), await run.joined("Conformance B")
    start = len(a.frames)
    i, message_id = await run.post(a, "conformance: hello *world*", mentions=[])
    j, mine = await a.wait(snapshot_of(message_id), start)
    _, theirs = await b.wait(snapshot_of(message_id))
    must(theirs, "no broadcast to another member")
    must(mine, "no broadcast to the sender")
    must(j < i, "the sender got its result before the broadcast (§1)")
    p = theirs["params"]
    must(p.get("log_id") == message_id, f"log_id {p.get('log_id')} is not message_id {message_id} (§2.2)")
    must(p.get("room_id") == run.room, f"room_id is {p.get('room_id')!r}")
    must(p.get("from", {}).get("user_id") == a.you["user_id"], "from is not the sender")
    must(p.get("body", {}).get("text") == "conformance: hello *world*", "body.text changed")
    must(abs(int(message_id) - time.time() * 1000) < 3600_000, "log_id is not the commit time (§2.1)")
    await asyncio.sleep(QUIET)
    must(len(b.since(0, snapshot_of(message_id))) == 1, "the snapshot arrived more than once (§3.5.3)")
    run.message = p


@check("core.message.empty", "3.5.1", "a message with no text and no embeds is not logged")
async def _(run):
    a, b = await run.joined(), await run.joined()
    start = len(b.frames)
    result = await a.call("message", {"room_id": run.room, "body": {"text": ""}})
    await asyncio.sleep(QUIET)
    should(result == {}, f"result is {json.dumps(result)}")
    should(not b.since(start, lambda f: f.get("method") == "message"), "it was broadcast")


@check("core.message.reply-to", "3.5.4", "reply_to must refer to an existing message")
async def _(run):
    if not run.message:
        raise Skip("no message to reply to")
    a = await run.joined()
    target = run.message["message_id"]
    _, message_id = await run.post(a, "conformance: reply", reply_to={"message_id": target})
    _, snapshot = await a.wait(snapshot_of(message_id))
    if snapshot:
        must(snapshot["params"].get("reply_to", {}).get("message_id") == target, "the snapshot lost reply_to")
    reply = (await a.request("message", {"room_id": run.room, "body": {"text": "x"}, "reply_to": {"message_id": MISSING}}))[1]
    expect_error(reply, "invalid_params", "reply_to an unknown message")


@check("core.shape.unknown-method", "3.6.5", "unknown requests are error/unsupported")
async def _(run):
    conn = await run.open()
    expect_error((await conn.request("ext:conformance-unknown", {}))[1], "unsupported", "unknown method")


@check("core.shape.save-without-edit", "3.6.5", "message with message_id is error/unsupported without edit", needs=lambda s: "edit" not in s.get("capabilities", []))
async def _(run):
    if not run.message:
        raise Skip("no message to save")
    conn = await run.joined()
    reply = (await conn.request("message", {"message_id": run.message["message_id"], "room_id": run.room,
                                            "body": {"text": "conformance: edited"}}))[1]
    expect_error(reply, "unsupported", "a save")


@check("core.shape.unknown-notification", "3.6.5", "unknown notifications are ignored")
async def _(run):
    conn = await run.open()
    start = len(conn.frames)
    await conn.notify("ext:conformance-unknown", {"x": 1})
    if not run.has("activity"):  # defined, but unknown to this server
        await conn.notify("activity", {"room_id": run.room or "general", "typing": 5})
    await conn.sync()
    errors = conn.since(start, lambda f: "error" in f and "id" not in f)
    must(not errors, errors and f"got {describe(errors[0])}")


@check("core.shape.unknown-keys", "1", "unknown keys are ignored")
async def _(run):
    conn = await run.joined()
    reply = (await conn.request("message", {"room_id": run.room, "conformance_unknown": True,
                                            "body": {"text": "conformance: unknown keys", "conformance_unknown": 1}}))[1]
    must("result" in reply, describe(reply))


@check("core.shape.unknown-room", "1.1", "a request for a room that does not exist is error/invalid_params")
async def _(run):
    conn = await run.open()
    reply = (await conn.request("message", {"room_id": "conformance-no-such-room", "body": {"text": "x"}}))[1]
    control = lambda: reply_to(conn, "message", {"room_id": run.room, "body": {"text": "conformance: a room that exists"}})
    await unless_policy(reply, "a post", control if run.room else None)
    expect_error(reply, "invalid_params", "posting to an unknown room")


@check("core.shape.large-frame", "1", "frames up to 256 KiB are accepted")
async def _(run):
    conn = await run.joined()
    try:
        _, reply = await conn.request("message", {"room_id": run.room, "body": {"text": "x" * 250_000}})
    except Fail as error:
        raise Warn(str(error)) from None
    should("result" in reply, f"a 250 kB message: {describe(reply)}")


@check("core.retry.dedup", "1.2", "retries are deduplicated by (user_id, id)")
async def _(run):
    a, b = await run.joined(), await run.joined()
    start = len(b.frames)
    params = {"room_id": run.room, "body": {"text": "conformance: retry"}}
    _, first = await a.request("message", params, id="conformance-retry")
    _, second = await a.request("message", params, id="conformance-retry")
    must("result" in first, describe(first))
    await asyncio.sleep(QUIET)
    count = len(b.since(start, lambda f: f.get("method") == "message"
                        and f["params"].get("body", {}).get("text") == "conformance: retry"))
    should("result" in second and second["result"] == first["result"], f"the retry got {describe(second)}")
    should(count == 1, f"the retry was broadcast {count} times")
    other = {"room_id": run.room, "body": {"text": "conformance: other"}}
    expect = (await a.request("message", other, id="conformance-retry"))[1]
    should(code(expect) == CODES["invalid_params"], f"an id reused with other params got {describe(expect)}")


@check("core.identity.me", "3.3.2", "me returns the user's complete object")
async def _(run):
    conn = await run.open()
    you = (await conn.call("me", {})).get("you", {})
    must(you.get("user_id") == conn.you["user_id"], "me's you.user_id is not the auth's")
    _, reply = await conn.request("me", {"name": "Conformance Renamed"})
    try:
        await unless_policy(reply, "a new name")
    except Skip as refusal:
        return run.info(str(refusal))
    must("result" in reply, f"me with a new name: {describe(reply)}")
    must(reply["result"].get("you", {}).get("user_id") == conn.you["user_id"], "a new name changed you.user_id")


# §4 capabilities

@check("history.shape.page", "4.3", "history pages the log", needs="history")
async def _(run):
    conn = await run.open()
    page = await conn.call("history", {"room_id": run.room} if run.room else {})
    for key in ("latest_log_id", "history_log_id"):
        must(key in page, f"the result has no {key} (§4.3.3)")
    must(("first_log_id" in page) == ("last_log_id" in page), "the result has one of first_log_id and last_log_id")
    must(isinstance(page.get("more"), bool), "more is not a boolean")
    for key in ("rooms", "messages", "reactions", "memberships"):
        log_ids = [int(r["log_id"]) for r in page.get(key, [])]
        must(log_ids == sorted(log_ids), f"{key} are not in ascending log_id")
    if run.message:
        must(any(m.get("message_id") == run.message["message_id"] for m in page.get("messages", [])),
             "the newest page lacks a recent message")


@check("history.shape.all-rooms", "4.3", "history without room_id pages every room the connection receives, or is error/unsupported",
       needs=lambda s: {"history", "rooms"} <= set(s.get("capabilities", [])))
async def _(run):
    conn = await run.joined()
    _, reply = await conn.request("room_set", {"title": "Conformance history"})
    other = reply.get("result", {}).get("room_id")
    if not isinstance(other, str):
        raise Skip(f"no second room: room_set got {describe(reply)}")
    _, first = await run.post(conn, "conformance: history, default room")
    _, reply = await conn.request("message", {"room_id": other, "body": {"text": "conformance: history, other room"}})
    must(isinstance(reply.get("result", {}).get("message_id"), str), f"posting: {describe(reply)}")
    second = reply["result"]["message_id"]
    _, reply = await conn.request("history", {"after": first, "before": second})
    if code(reply) == CODES["unsupported"]:
        raise Warn("history without room_id is error/unsupported")
    must("result" in reply, f"history without room_id: {describe(reply)}")
    rooms = {m.get("room_id") for m in reply["result"].get("messages", []) if m.get("message_id") in (first, second)}
    must(rooms == {run.room, other}, f"history without room_id returned only {', '.join(sorted(map(str, rooms))) or 'neither room'}")


async def burst(run, conn, texts):
    """Post the texts at once, each request sent before the previous result, and return their message_ids in order.
    A refusal by server policy (retry_after or denied, such as a posting limit) skips the check."""
    sent = []
    for text in texts:
        id = next(ids)
        sent.append(id)
        await conn.send({"method": "message", "id": id, "params": {"room_id": run.room, "body": {"text": text}}})
    message_ids = []
    for id in sent:
        _, reply = await conn.reply(id, timeout=WAIT * 4)
        must(reply, "no reply to a message of the burst" + (" (connection closed)" if conn.closed else ""))
        if code(reply) in (CODES["retry_after"], CODES["denied"]):
            raise Skip(f"the server's policy refused the burst: {describe(reply)}")
        must(isinstance(reply.get("result", {}).get("message_id"), str), f"posting: {describe(reply)}")
        message_ids.append(reply["result"]["message_id"])
    return message_ids


async def logged(conn, room_id, after):
    """The room's message snapshots and reaction sets from after on, by history, as {log_id: kind}."""
    found = {}
    while True:
        page = await conn.call("history", {"room_id": room_id, "after": after, "limit": 200})
        for key, kind in (("messages", "message"), ("reactions", "reactions")):
            for record in page.get(key, []):
                if isinstance(record, dict) and "log_id" in record:
                    found[int(record["log_id"])] = kind
        if not page.get("more") or "last_log_id" not in page:
            return found
        after = str(int(page["last_log_id"]) + 1)


def delivered(conn, start, room_id):
    """The room's message snapshots and reaction sets that conn received live from start on, as (log_id, kind)."""
    live = []
    for frame in conn.since(start, lambda f: f.get("method") in ("message", "reactions")):
        params = frame.get("params", {})
        if params.get("room_id") == room_id and "log_id" in params:
            live.append((int(params["log_id"]), frame["method"]))
    return live


@check("core.delivery.burst", "3.5.3", "live delivery brings every record of a burst once, in log order", needs="history")
async def _(run):
    a, b = await run.joined("Conformance burst A"), await run.joined("Conformance burst B")
    start = len(b.frames)
    message_ids = await burst(run, a, [f"conformance: burst {n}" for n in range(BURST)])
    # The other kinds of record a room logs, where the server has them.
    if run.has("edit"):
        await a.call("message", {"message_id": message_ids[0], "room_id": run.room, "body": {"text": "conformance: burst, edited"}})
        await a.call("message", {"message_id": message_ids[1], "room_id": run.room, "deleted": True})
    if run.has("reactions"):
        await a.call("reactions", {"message_id": message_ids[2], "emojis": ["👍"]})
    # Every result has reached the poster, so every broadcast went out before the server reads b's next request, and
    # its reply (an error is as good) comes after them (§1): one round trip, no waiting for what shouldn't come.
    await b.request("me", {})
    logged_ids = await logged(b, run.room, message_ids[0])
    live = delivered(b, start, run.room)
    live_ids = {log_id for log_id, _ in live}
    missing = sorted(log_id for log_id, kind in logged_ids.items() if kind == "message" and log_id not in live_ids)
    must(not missing, f"{len(missing)} message snapshots in the log never arrived live, such as {missing[0] if missing else ''} (§3.5.3)")
    messages = [log_id for log_id, kind in live if kind == "message"]
    must(messages == sorted(set(messages)), "the burst's message snapshots arrived out of log order or twice (§3.5.3)")
    missing = sorted(log_id for log_id, kind in logged_ids.items() if kind == "reactions" and log_id not in live_ids)
    should(not missing, f"a reaction set in the log never arrived live: {missing[:1]} (§3.4)")
    every = [log_id for log_id, _ in live]
    should(every == sorted(every), "the room's reaction sets and message snapshots arrived out of log order between them")


@check("core.delivery.slow-reader", "3.5.3", "a reader that falls behind gets every record, or loses its connection", needs="history")
async def _(run):
    a, b = await run.joined("Conformance flood A"), await run.joined("Conformance flood B", small_buffers=True)
    start = len(b.frames)
    b.reading.clear()
    filler = "x" * SLOW_TEXT
    message_ids = await burst(run, a, [f"conformance: flood {n} {filler}" for n in range(SLOW_BURST)])
    b.reading.set()
    # Everything sent has arrived, or the server closed the connection: wait for the last record, or the close.
    await b.wait(snapshot_of(message_ids[-1]), start, timeout=WAIT * 4)
    logged_ids = sorted(log_id for log_id, kind in (await logged(a, run.room, message_ids[0])).items() if kind == "message")
    live = [log_id for log_id, kind in delivered(b, start, run.room) if kind == "message" and log_id >= int(message_ids[0])]
    if b.closed:
        # A connection the server gave up on: what did arrive is everything up to its last record, with no gap.
        must(live == logged_ids[:len(live)], "a reader that fell behind lost records before later ones, then its connection")
        return
    missing = sorted(set(logged_ids) - set(live))
    must(not missing, f"a reader that fell behind kept its connection and lost {len(missing)} records, such as {missing[0] if missing else ''} (§3.5.3)")
    must(live == logged_ids, "a reader that fell behind got records out of log order or twice (§3.5.3)")


@check("history.bounds.inclusive", "4.3.2", "after and before are inclusive bounds", needs="history")
async def _(run):
    if not run.message:
        raise Skip("no message")
    conn = await run.open()
    log_id = run.message["log_id"]
    page = await conn.call("history", {"room_id": run.room, "after": log_id, "before": log_id})
    must([m.get("log_id") for m in page.get("messages", [])] == [log_id], "the slice is not the one record")
    must(page.get("first_log_id") == log_id == page.get("last_log_id"), "first_log_id and last_log_id are not the record")


@check("history.bounds.limit", "4.3.2", "limit takes the oldest with after and the newest without", needs="history")
async def _(run):
    conn = await run.joined()
    posted = [(await run.post(conn, f"conformance: page {n}"))[1] for n in range(3)]
    forward = await conn.call("history", {"room_id": run.room, "after": posted[0], "limit": 2})
    must(forward.get("first_log_id") == posted[0], f"first_log_id is {forward.get('first_log_id')}, not {posted[0]}")
    must(forward.get("more") is True, "more is not true")
    backward = await conn.call("history", {"room_id": run.room, "before": posted[2], "limit": 2})
    must(backward.get("last_log_id") == posted[2], f"last_log_id is {backward.get('last_log_id')}, not {posted[2]}")
    must(backward.get("more") is True, "more is not true")
    rest = await conn.call("history", {"room_id": run.room, "after": str(int(forward["last_log_id"]) + 1), "limit": 200})
    must(any(m.get("message_id") == posted[2] for m in rest.get("messages", [])), "continuing forward skipped a message")


@check("history.bounds.empty", "4.3.2", "an empty slice has more: false and no bounds", needs="history")
async def _(run):
    conn = await run.open()
    page = await conn.call("history", {"after": MISSING, **({"room_id": run.room} if run.room else {})})
    must(page.get("more") is False, "more is not false")
    must("first_log_id" not in page and "last_log_id" not in page, "the result has bounds")


@check("edit.shape.save", "4.4", "a save is a new snapshot at a later log_id", needs="edit")
async def _(run):
    a, b = await run.joined(), await run.joined()
    _, message_id = await run.post(a, "conformance: before")
    start = (await b.expect(snapshot_of(message_id), "no broadcast to another member"))[0] + 1
    i, reply = await a.request("message", {"message_id": message_id, "room_id": run.room, "body": {"text": "conformance: after"}})
    must(reply.get("result", {}).get("message_id") == message_id, f"the save got {describe(reply)}")
    _, saved = await b.wait(snapshot_of(message_id), start)
    must(saved, "no snapshot of the save")
    p = saved["params"]
    must(int(p["log_id"]) > int(message_id), "the save's log_id is not greater")
    must(p.get("body", {}).get("text") == "conformance: after", "body was not replaced")
    must(p.get("from", {}).get("user_id") == a.you["user_id"], "from changed")


@check("edit.shape.delete", "4.4", "delete is a tombstone without body or ext", needs="edit")
async def _(run):
    a, b = await run.joined(), await run.joined()
    _, message_id = await run.post(a, "conformance: delete me")
    start = (await b.expect(snapshot_of(message_id), "no broadcast to another member"))[0] + 1
    await a.call("message", {"message_id": message_id, "room_id": run.room, "deleted": True})
    _, tomb = await b.wait(snapshot_of(message_id), start)
    must(tomb, "no tombstone")
    must(tomb["params"].get("deleted") is True, "deleted is not true")
    must("body" not in tomb["params"] and "ext" not in tomb["params"], "the tombstone has body or ext")


@check("edit.shape.deleted-on-create", "4.4", "deleted: true on creation is error/invalid_params", needs="edit")
async def _(run):
    conn = await run.joined()
    reply = (await conn.request("message", {"room_id": run.room, "body": {"text": "x"}, "deleted": True}))[1]
    expect_error(reply, "invalid_params", "creating a deleted message")


@check("edit.shape.unknown-message", "4.4", "saving an unknown message is error/invalid_params", needs="edit")
async def _(run):
    conn = await run.joined()
    reply = (await conn.request("message", {"message_id": MISSING, "room_id": run.room, "body": {"text": "x"}}))[1]
    expect_error(reply, "invalid_params", "saving an unknown message")


@check("rooms.list.filter", "4.2.1", "room_list returns the arrays its filter asks for", needs="rooms")
async def _(run):
    conn = await run.open()
    joined = await conn.call("room_list", {"filter": "joined", "members": True})
    must(isinstance(joined.get("joined"), list) and "not_joined" not in joined, "filter joined")
    for room in joined["joined"]:
        must(isinstance(room.get("members"), list), f"room {room.get('room_id')} has no members")
    not_joined = await conn.call("room_list", {"filter": "not_joined"})
    must(isinstance(not_joined.get("not_joined"), list) and "joined" not in not_joined, "filter not_joined")
    must(all("members" not in r for r in not_joined["not_joined"]), "members without members: true")
    if joined["joined"]:
        should(isinstance(joined.get("users"), list), "members: true has no users")


@check("rooms.set.create", "4.2.4", "room_set creates a room, joins the creator, and edits it", needs="rooms", setup=True)
async def _(run):
    conn = await run.open()
    start = len(conn.frames)
    i, reply = await conn.request("room_set", {"title": "Conformance"})
    await unless_policy(reply, "a new room")
    must(isinstance(reply.get("result", {}).get("room_id"), str), f"room_set got {describe(reply)}")
    room_id = reply["result"]["room_id"]
    j, update = await conn.wait(room_update("joined", room_id), start)
    must(update and j < i, "no room_update joined before the result")
    record = records(update, "joined", room_id)[0]
    must(isinstance(record.get("members"), list), "joined has no members")
    must(record.get("title") == "Conformance", "the title was not kept")
    start = len(conn.frames)
    i, reply = await conn.request("room_set", {"room_id": room_id, "title": "Conformance 2"})
    must(reply.get("result", {}).get("room_id") == room_id, f"editing got {describe(reply)}")
    j, update = await conn.wait(room_update("updated", room_id), start)
    must(update and j < i, "no room_update updated before the result")
    must(records(update, "updated", room_id)[0].get("title") == "Conformance 2", "the new title is missing")
    run.new_room = room_id


@check("rooms.membership.join-leave", "4.2.2", "room_join and room_leave update the user and the room", needs="rooms")
async def _(run):
    room_id = getattr(run, "new_room", None)
    if not room_id:
        raise Skip("no room was created")
    # With --token every connection is the same user, so there is no other member to tell.
    two_users = not run.args.token
    a = await run.open()
    if two_users:
        await a.call("room_join", {"room_id": room_id})
    b = await run.open()
    a_start, b_start = len(a.frames), len(b.frames)
    i, reply = await b.request("room_join", {"room_id": room_id})
    must(reply.get("result") == {}, f"room_join got {describe(reply)}")
    j, update = await b.wait(room_update("joined", room_id), b_start)
    must(update and j < i, "no room_update joined before the result")
    if two_users:
        _, membership = await a.wait(room_update("memberships", room_id), a_start)
        should(membership, "another member got no membership record")
    b_start = len(b.frames)
    i, reply = await b.request("room_leave", {"room_id": room_id})
    must(reply.get("result") == {}, f"room_leave got {describe(reply)}")
    j, update = await b.wait(room_update("left", room_id), b_start)
    must(update and j < i, "no room_update left before the result")


@check("rooms.list.sign-in-joined", "4.2.1", "a room that a sign-in joins is in room_list joined", needs="rooms")
async def _(run):
    conn = await run.open()
    you = conn.you["user_id"]
    listing = await conn.call("room_list", {"filter": "joined"})
    await conn.sync()
    updates = conn.since(0, lambda f: f.get("method") == "room_update")
    rooms = {m["room_id"] for f in updates for m in f["params"].get("memberships", [])
             if any(e.get("user", {}).get("user_id") == you and e.get("joined") for e in m.get("members", []))}
    if not rooms:
        raise Skip("the sign-in joined no room, or kept its memberships outside the log")
    listed = {r.get("room_id") for r in listing.get("joined", [])}
    must(rooms <= listed, f"room_list joined lacks {', '.join(sorted(rooms - listed))}")


@check("rooms.membership.unknown-room", "4.2.2", "joining an unknown room is error/invalid_params", needs="rooms")
async def _(run):
    conn = await run.open()
    _, reply = await conn.request("room_join", {"room_id": "conformance-no-such-room"})
    control = lambda: reply_to(conn, "room_join", {"room_id": run.room})
    await unless_policy(reply, "room_join", control if run.room else None)
    expect_error(reply, "invalid_params", "room_join")


@check("rooms.set.private", "4.2.4", "a private room is kept private or refused as error/unsupported", needs="rooms")
async def _(run):
    a = await run.open()
    start = len(a.frames)
    _, reply = await a.request("room_set", {"title": "Conformance private", "private": True})
    if code(reply) == CODES["unsupported"]:
        return
    await unless_policy(reply, "a new room")
    must("result" in reply, f"got {describe(reply)}")
    room_id = reply["result"]["room_id"]
    _, update = await a.wait(room_update("joined", room_id), start)
    must(update and records(update, "joined", room_id)[0].get("private") is True, "joined lacks private: true")
    b = await run.open()
    listing = await b.call("room_list", {"filter": "not_joined"})
    must(all(r.get("room_id") != room_id for r in listing.get("not_joined", [])), "a non-member sees it")


@check("reactions.shape.broadcast", "4.7", "reactions are logged and broadcast before the result", needs="reactions")
async def _(run):
    a, b = await run.joined(), await run.joined()
    _, message_id = await run.post(a, "conformance: react to me")
    a_start, b_start = len(a.frames), len(b.frames)
    i, reply = await a.request("reactions", {"message_id": message_id, "emojis": ["👍"]})
    must(reply.get("result") == {}, f"got {describe(reply)}")
    is_set = lambda f: f.get("method") == "reactions" and f["params"].get("message_id") == message_id
    j, mine = await a.wait(is_set, a_start)
    _, theirs = await b.wait(is_set, b_start)
    must(theirs, "no broadcast to another member")
    must(mine and j < i, "the sender got its result before the broadcast")
    p = theirs["params"]
    must(p.get("room_id") == run.room and "log_id" in p, "no room_id or log_id")
    must([(r["from"]["user_id"], r["emojis"]) for r in p.get("reactions", [])] == [(a.you["user_id"], ["👍"])],
         "reactions is not the sender's one set")
    expect_error((await a.request("reactions", {"message_id": MISSING, "emojis": ["👍"]}))[1], "invalid_params", "an unknown message")


@check("activity.shape.notification", "4.6", "activity is a notification and gets no reply", needs="activity")
async def _(run):
    conn = await run.joined()
    start = len(conn.frames)
    await conn.notify("activity", {"room_id": run.room, "typing": 5})
    await conn.notify("activity", {"room_id": run.room, "typing": 0})
    await conn.sync()
    must(not conn.since(start, lambda f: "error" in f and "id" not in f), "activity got an error")


@check("status.shape.request", "4.5.3", "status reports idle, and sends mutes to the user's connections", needs="status")
async def _(run):
    conn = await run.open()
    must(await conn.call("status", {"idle": 300}) == {}, "idle did not reply {}")
    must(await conn.call("status", {"idle": False}) == {}, "idle: false did not reply {}")
    expect_error((await conn.request("status", {"room_id": run.room or "general"}))[1], "invalid_params", "room_id without mute")
    for mute in (True, False):
        start = len(conn.frames)
        await conn.call("status", {"mute": mute})
        _, sent = await conn.wait(lambda f, m=mute: f.get("method") == "status" and f["params"].get("mute") == m, start)
        must(sent, f"no status notification with mute: {json.dumps(mute)}")


@check("status.shape.me", "4.5.1", "me sets a listed status", needs=lambda s: "status" in s.get("capabilities", []) and s.get("status"))
async def _(run):
    conn = await run.open()
    value = run.server["status"][0]
    you = (await conn.call("me", {"status": value})).get("you", {})
    must(you.get("status") == value, f"you.status is {you.get('status')!r}, not {value!r}")
    await conn.call("me", {"status": "online"})


@check("status.seen.invisible", "4.5.2", "a chosen invisible is shown offline, and its connections leave seen as it is",
       needs=lambda s: "status" in s.get("capabilities", []) and "invisible" in s.get("status", []))
async def _(run):
    if run.args.token:
        raise Skip("needs two users; runs with guest sign-in")
    watcher = await run.joined("Watcher")
    subject = await run.open(auth=False)
    signed_in = await subject.call("auth", run.auth("Subject"))
    you, token = signed_in["you"], signed_in.get("token")
    if run.has("rooms"):
        await subject.call("room_join", {"room_id": run.room})
    about = lambda f: (f.get("method") == "user" and f["params"].get("new", {}).get("user_id") == you["user_id"]
                       and "status" in f["params"]["new"])
    await watcher.sync()  # the subject's sign-in has been announced
    start = len(watcher.frames)
    mine = (await subject.call("me", {"status": "invisible"})).get("you", {})
    must(mine.get("status") == "invisible", f"you.status is {mine.get('status')!r}, not 'invisible'")
    must("seen" not in mine, "you carries seen")
    _, hidden = await watcher.wait(about, start)
    if hidden:
        must(hidden["params"]["new"]["status"] == "offline", f"a chosen invisible is shown as {hidden['params']['new']['status']!r}")
    first = (hidden or {}).get("params", {}).get("new", {}).get("seen")
    start = len(watcher.frames)
    if token:  # a second connection of the same user comes and goes
        again = await run.open(auth=False)
        await again.call("auth", {"scheme": "token", "token": token})
        await again.ws.close()
    await subject.sync()
    await watcher.sync()
    leaks = [f["params"]["new"] for f in watcher.since(start, about)
             if f["params"]["new"]["status"] != "offline" or f["params"]["new"].get("seen", first) != first]
    must(not leaks, f"the watcher got {json.dumps(leaks[0]) if leaks else ''} while the subject stayed invisible")
    should(hidden, "no user notification when the subject chose invisible")


@check("command.shape.help", "4.1", "/help replies with a ~private notice", needs="command")
async def _(run):
    conn = await run.joined()
    start = len(conn.frames)
    i, reply = await conn.request("command", {"room_id": run.room, "body": {"text": "/help"}})
    must("result" in reply and "message_id" not in reply["result"], f"got {describe(reply)}")
    j, notice = await conn.wait(lambda f: f.get("method") == "message" and f["params"].get("from", {}).get("user_id") == "~private", start)
    should(notice and j < i, "no ~private notice before the result")
    must("message_id" not in notice["params"], "the notice has a message_id")


@check("command.shape.message-id", "4.1", "a command with message_id is error/invalid_params", needs="command")
async def _(run):
    conn = await run.joined()
    reply = (await conn.request("command", {"room_id": run.room, "message_id": MISSING, "body": {"text": "/help"}}))[1]
    expect_error(reply, "invalid_params", "command with message_id")


@check("ext.merge.me", "4.13", "me merges ext one level deep", needs="ext")
async def _(run):
    conn = await run.open()
    ext = lambda params: conn.call("me", params)
    _, reply = await conn.request("me", {"ext": {"conformance": {"a": 1}}})
    await unless_policy(reply, "ext on the user")
    you = (await ext({"ext": {"conformance": {"a": 1}}}))["you"]
    must(you.get("ext", {}).get("conformance") == {"a": 1}, "ext.conformance was not kept")
    you = (await ext({"ext": {"conformance2": "x"}}))["you"]
    must(you.get("ext", {}).get("conformance") == {"a": 1}, "a write of another key dropped ext.conformance")
    you = (await ext({"ext": {"conformance": "", "conformance2": ""}}))["you"]
    must("conformance" not in you.get("ext", {}), "an empty value did not clear the key")


@check("ext.merge.message", "4.13", "messages keep ext, and saves merge it", needs="ext")
async def _(run):
    conn = await run.joined()
    _, message_id = await run.post(conn, "conformance: ext", ext={"conformance": {"a": 1}})
    _, snapshot = await conn.wait(snapshot_of(message_id))
    must(snapshot and snapshot["params"].get("ext", {}).get("conformance") == {"a": 1}, "the snapshot lost ext")
    if run.has("edit"):
        start = len(conn.frames)
        await conn.call("message", {"message_id": message_id, "room_id": run.room, "body": {"text": "conformance: ext"},
                                    "ext": {"conformance2": 1}})
        _, saved = await conn.wait(snapshot_of(message_id), start)
        must(saved and saved["params"].get("ext") == {"conformance": {"a": 1}, "conformance2": 1}, "the save did not merge ext")


async def post_new_embed(conn, run, embed, policy_skips=False, **body):
    """Post a message with one new embed, and return (message_id, result embed).

    With policy_skips, a refusal by server policy (retry_after or denied), such as a limit on live texts, skips the check.
    """
    body = {"text": "conformance: embed", **body, "embeds": [embed]}
    _, reply = await conn.request("message", {"room_id": run.room, "body": body})
    if policy_skips and code(reply) in (CODES["retry_after"], CODES["denied"]):
        raise Skip(f"the server's policy refused another live text: {describe(reply)}")
    result = reply.get("result", {})
    must(len(result.get("embeds", [])) == 1, f"got {describe(reply)}")
    written = result["embeds"][0]
    must(written.get("embed_id") and written.get("write_url"), "the result embed lacks embed_id or write_url")
    return result.get("message_id"), written


async def post_embed(conn, run, embed, policy_skips=False, **body):
    """Post a message with one new embed, and return (message_id, result embed, embed as first broadcast)."""
    message_id, written = await post_new_embed(conn, run, embed, policy_skips, **body)
    must(message_id, "the result has no message_id")
    _, first = await conn.wait(snapshot_of(message_id))
    must(first, "no broadcast")
    return message_id, written, embed_in(first, written["embed_id"]) or {}


async def post_live(conn, run, embed, policy_skips=False, **body):
    """Post a message with one new live embed, and return (message_id, result embed, index of the first frame after
    the post). The broadcast carries the embed without url: its write has not started (§4.8.5).
    """
    message_id, written, pending = await post_embed(conn, run, embed, policy_skips=policy_skips, **body)
    must(pending.get("embed_id") and "url" not in pending, f"the live embed has url before its write started: {json.dumps(pending)}")
    return message_id, written, len(conn.frames)


async def started(conn, message_id, written, start):
    """The live embed from the snapshot, from start on, that adds its url once its write starts (§4.8.5)."""
    has_url = lambda f: snapshot_of(message_id)(f) and "url" in (embed_in(f, written["embed_id"]) or {})
    _, first = await conn.expect(has_url, "no snapshot added the live embed's url after its write started", start, WAIT * 2)
    return embed_in(first, written["embed_id"])


def embed_in(snapshot, embed_id):
    """The embed with embed_id in a message snapshot frame, or None."""
    return next((e for e in snapshot["params"].get("body", {}).get("embeds", []) if e.get("embed_id") == embed_id), None)


async def finished(conn, message_id, embed_id, done, start, why):
    """Return the first snapshot of message_id from start whose embed, or None without it, passes done."""
    _, last = await conn.wait(lambda f: snapshot_of(message_id)(f) and done(embed_in(f, embed_id)), start, WAIT * 5)
    must(last, why)
    return last


def http_url(run, url):
    """url resolved against the server's address, with ws and wss as http and https."""
    base = re.sub(r"^ws", "http", run.args.url)
    return urllib.parse.urljoin(base, url)


def put(url, body, content_type=None):
    """PUT body, bytes or an iterable of byte chunks sent as they come, and return the response body."""
    request = urllib.request.Request(url, data=body, method="PUT")
    if content_type:
        request.add_header("Content-Type", content_type)
    with urllib.request.urlopen(request, timeout=WAIT * 5) as response:
        return response.read()


def get_live(url, size):
    """GET url, and return (its headers, its first size bytes)."""
    with urllib.request.urlopen(url, timeout=WAIT * 5) as response:
        return response.headers, response.read(size)


def append_edits(text):
    """The text after §4.8.5's edits: backspace removes the code point before it, form feed all the text before it."""
    kept = []
    for char in text:
        if char == "\b":
            if kept:
                kept.pop()
        elif char == "\f":
            kept.clear()
        else:
            kept.append(char)
    return "".join(kept)


def read_until(url, done, seconds):
    """GET url and read what arrives until done(the text so far, edits applied) or seconds pass; return that text."""
    decoder = codecs.getincrementaldecoder("utf-8")("replace")
    text, deadline = "", time.monotonic() + seconds
    with urllib.request.urlopen(url, timeout=seconds) as response:
        while not done(append_edits(text)) and time.monotonic() < deadline:
            chunk = response.read1(65536)
            if not chunk:
                break
            text += decoder.decode(chunk)
    return append_edits(text)


async def write_live(conn, run, message_id, written, posted, chunks):
    """PUT the chunks as one body, holding it open after the first chunk, and GET url meanwhile (§4.8.5).

    Return the live embed as its write's start published it, looking from posted, the first frame after the post.
    """
    sent, release = threading.Event(), threading.Event()

    def body():
        yield chunks[0]
        sent.set()
        release.wait(WAIT * 5)
        yield from chunks[1:]

    writing = asyncio.create_task(asyncio.to_thread(put, http_url(run, written["write_url"]), body()))
    try:
        must(await asyncio.to_thread(sent.wait, WAIT * 5), "the PUT did not send its first chunk")
        live = await started(conn, message_id, written, posted)
        try:
            headers, first = await asyncio.to_thread(get_live, http_url(run, live["url"]), len(chunks[0]))
        except OSError as error:
            raise Fail(f"GET url while the text is live: {error}") from None
        kind = headers.get("Content-Type")
        must(kind and headers.get_content_type() == "text/plain" and headers.get_content_charset() == "utf-8",
             f"GET url has Content-Type {kind!r}, not text/plain; charset=utf-8")
        must(headers.get("X-Content-Type-Options", "").strip().lower() == "nosniff",
             "GET url lacks X-Content-Type-Options: nosniff")
        directives = {d.strip().lower() for d in headers.get("Cache-Control", "").split(",")}
        must("no-transform" in directives, "GET url lacks Cache-Control: no-transform")
        must(headers.get("Access-Control-Allow-Origin", "").strip() == "*", "GET url lacks Access-Control-Allow-Origin: *")
        must(first == chunks[0], f"GET url while the text is live returned {first!r}, not the text written so far")
    finally:
        release.set()
        try:
            await writing
        except OSError as error:
            raise Fail(f"PUT write_url: {error}") from None
    return live


# A 1x1 PNG, for servers that take only images.
PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==")


def upload_file(run):
    """A file the server takes: plain text, unless ext:media's upload patterns (extensions/ext_media.md) say otherwise."""
    files = [("conformance.txt", "text/plain", b"conformance\n"), ("conformance.png", "image/png", PNG)]
    patterns = run.server.get("ext", {}).get("media", {}).get("upload") if run.has("ext:media") else None
    if not isinstance(patterns, dict):
        return files[0]
    takes = lambda pattern, kind: pattern.lower() in (kind, "*/*", kind.split("/")[0] + "/*")
    for file in files:
        if any(takes(pattern, file[1]) for pattern in patterns):
            return file
    raise Skip("ext.media.upload takes neither text/plain nor image/png")


@check("embed.upload.put", "4.8.4", "an upload gets a write_url and completes after the PUT", needs="embed:upload")
async def _(run):
    conn = await run.joined()
    title, kind, body = upload_file(run)
    message_id, written, pending = await post_embed(conn, run, {"kind": "upload", "title": title})
    must(pending.get("embed_id") and "url" not in pending, "the first broadcast is not pending")
    start = len(conn.frames)
    await asyncio.to_thread(put, http_url(run, written["write_url"]), body, kind)
    done = await finished(conn, message_id, written["embed_id"], lambda e: e is None or "url" in e, start,
                          "no snapshot completed the embed after the write")
    must((embed_in(done, written["embed_id"]) or {}).get("url"), "the upload failed: the snapshot has no embed")


@check("embed.append.live", "4.8.5", "append text is live at its url, then moves into body.text", needs="embed:append")
async def _(run):
    conn = await run.joined()
    opening, chunks = "conformance: append\n\n", [b"live ", "*text* \u00e9\n".encode()]
    message_id, written, start = await post_live(conn, run, {"kind": "append"}, text=opening, format="markdown")
    two = {"room_id": run.room, "body": {"text": "conformance: two appends", "embeds": [{"kind": "append"}, {"kind": "append"}]}}
    expect_error((await conn.request("message", two))[1], "invalid_params", "a message with two append embeds")
    await write_live(conn, run, message_id, written, start, chunks)
    done = await finished(conn, message_id, written["embed_id"], lambda e: e is None, start,
                          "no snapshot removed the embed after the write")
    body = done["params"].get("body", {})
    text = opening + b"".join(chunks).decode()
    must(body.get("text") == text, f"body.text is {body.get('text')!r}, not {text!r}")
    must(body.get("format") == "markdown", f"body.format is {body.get('format')!r}, not markdown")
    if run.has("edit"):
        # A save made before the text ended still sends its embed back (§4.8.2).
        stale = {"message_id": message_id, "room_id": run.room,
                 "body": {"text": opening, "format": "markdown", "embeds": [{"embed_id": written["embed_id"], "kind": "append"}]}}
        expect_error((await conn.request("message", stale))[1], "invalid_params", "a save with the embed_id of ended live text")


@check("embed.append.edits", "4.8.5", "backspace and form feed revise append text, for a late reader and in body.text", needs="embed:append")
async def _(run):
    conn = await run.joined()
    opening = "conformance: revised\n\n"
    message_id, written, start = await post_live(conn, run, {"kind": "append"}, text=opening, format="markdown")
    # The leading backspaces have nothing before them in the live text: they never reach body.text.
    first = "\x08\x08draft\x0cHello wrold\x08\x08\x08\x08orld".encode()
    # A backspace removes the U+FFFD that an invalid byte decodes to.
    rest = ", caf\u00e9\x08e".encode() + b"\xff\x08"
    sent, release = threading.Event(), threading.Event()

    def body():
        yield first
        sent.set()
        release.wait(WAIT * 5)
        yield rest

    writing = asyncio.create_task(asyncio.to_thread(put, http_url(run, written["write_url"]), body()))
    try:
        must(await asyncio.to_thread(sent.wait, WAIT * 5), "the PUT did not send its first part")
        live = await started(conn, message_id, written, start)
        await asyncio.sleep(QUIET)
        # A reader that connects after the edits gets text that, edited, is the text so far.
        try:
            late = await asyncio.to_thread(read_until, http_url(run, live["url"]), lambda t: t == "Hello world", WAIT * 2)
        except OSError as error:
            raise Fail(f"GET url after the edits: {error}") from None
        must(late == "Hello world", f"a reader that connects after the edits shows {late!r}, not 'Hello world'")
    finally:
        release.set()
        try:
            await writing
        except OSError as error:
            raise Fail(f"PUT write_url: {error}") from None
    done = await finished(conn, message_id, written["embed_id"], lambda e: e is None, start,
                          "no snapshot removed the embed after the write")
    text = opening + "Hello world, cafe"
    got = done["params"].get("body", {}).get("text")
    must(got == text, f"body.text is {got!r}, not {text!r}")


@check("embed.terminal.live", "4.8.6", "terminal output is live at its url, then kept as output", needs="embed:terminal")
async def _(run):
    conn = await run.joined()
    chunks = [b"conformance \x1b[1;31mred\x1b[0m\r\n", "caf\u00e9\x1b[K done\n".encode()]
    embed = {"kind": "terminal", "title": "conformance", "output": "forged"}
    message_id, written, start = await post_live(conn, run, embed, text="conformance: terminal")
    live = await write_live(conn, run, message_id, written, start, chunks)
    must("output" not in live, "the live embed has the output from the request (§4.8.2)")
    done = await finished(conn, message_id, written["embed_id"], lambda e: e is None or "output" in e, start,
                          "no snapshot finished the embed after the write")
    output = b"".join(chunks).decode()
    kept = embed_in(done, written["embed_id"])
    must(kept, "the write failed: the snapshot has no embed")
    must(kept.get("output") == output, f"output is {kept.get('output')!r}, not {output!r}")
    must(kept.get("title") == "conformance", f"the finished embed is {json.dumps(kept)}")
    if run.has("edit"):
        start = len(conn.frames)
        await conn.call("message", {"message_id": message_id, "room_id": run.room, "body": {
            "text": "conformance: saved", "embeds": [{**kept, "output": "forged"}]}})
        _, saved = await conn.expect(snapshot_of(message_id), "no snapshot after the save", start)
        must((embed_in(saved, written["embed_id"]) or {}).get("output") == output,
             "a save that sends output changed the server's output (§4.8.2)")


@check("embed.append.save-ends", "4.8.5", "a save that removes an append's embed ends its text, and its PUT gets a 2xx status",
       needs=lambda s: {"embed:append", "edit"} <= set(s.get("capabilities", [])))
async def _(run):
    conn = await run.joined()
    opening = "conformance: saved to end\n\n"
    message_id, written, start = await post_live(conn, run, {"kind": "append"}, policy_skips=True, text=opening, format="markdown")
    sent, release = threading.Event(), threading.Event()

    def body():
        yield b"typed so far"
        sent.set()
        release.wait(WAIT * 5)
        yield b" and after the save"

    writing = asyncio.create_task(asyncio.to_thread(put, http_url(run, written["write_url"]), body()))
    try:
        must(await asyncio.to_thread(sent.wait, WAIT * 5), "the PUT did not send its first part")
        await started(conn, message_id, written, start)
        text = opening + "the composer's text"
        start = len(conn.frames)
        await conn.call("message", {"message_id": message_id, "room_id": run.room, "body": {"text": text, "format": "markdown"}})
        _, saved = await conn.expect(snapshot_of(message_id), "no snapshot after the save", start)
        got = saved["params"].get("body", {})
        must(got.get("text") == text and not got.get("embeds"), f"the save's snapshot has body {json.dumps(got)}")
    finally:
        release.set()
    try:
        await writing
    except urllib.error.HTTPError as error:
        raise Fail(f"the PUT of a text that a save ended got status {error.code}, not 2xx (§4.8.3)") from None
    except OSError:
        pass  # the server may close the connection once it answered, before the body ends
    _, later = await conn.wait(lambda f: snapshot_of(message_id)(f) and f["params"].get("body", {}).get("text") != text,
                               start, QUIET)
    must(not later, "a snapshot after the save changed body.text: the text ended twice?")


@check("embed.append.limit", "4.8.5", "an append that reaches a limit keeps whole characters", needs="embed:append")
async def _(run):
    conn = await run.joined()
    # Last of the live text checks, as servers limit how many a user starts. An opening of odd length, and
    # two-byte characters, so that a byte limit is likely to fall inside one.
    opening = "conformance: limit\n\n"
    opening += "" if len(opening.encode()) % 2 else "."
    message_id, written, start = await post_live(conn, run, {"kind": "append"}, policy_skips=True, text=opening, format="markdown")
    # Erased text first, so that a limit on what the writer sends is reached with room left in the kept text.
    body = ("x\b" * 1500 + "\u00e9" * 40000).encode()
    try:
        await asyncio.to_thread(put, http_url(run, written["write_url"]), body)
    except urllib.error.HTTPError:
        pass  # a limit on the writer may answer with an error; the text still ends
    except OSError as error:
        raise Fail(f"PUT write_url: {error}") from None
    done = await finished(conn, message_id, written["embed_id"], lambda e: e is None, start,
                          "no snapshot removed the embed after the write")
    got = done["params"].get("body", {}).get("text") or ""
    must(got.startswith(opening), f"body.text does not start with the opening text: {got[:60]!r}")
    extra = set(got[len(opening):]) - {"\u00e9"}
    must(not extra, f"body.text has {sorted(extra)!r} after the opening text, not only whole é: a cut inside a character?")


@check("push.shape.unregister", "4.9.1", "unregistering an unknown push url succeeds", needs=lambda s: "push" in s)
async def _(run):
    conn = await run.open()
    must(await conn.call("push_unregister", {"url": "https://push.example.invalid/conformance"}) == {}, "result is not {}")


# §4.10–§4.12 sign-in, without a person: begins, the sign-in pages' answers, and made-up codes and tokens.

SIGN_IN_PARAMS = {"response_type", "client_id", "redirect_uri", "code_challenge", "code_challenge_method", "state", "resource"}
CLIENT_ID = "apron-conformance"  # a plain client ID: an https one may make the server fetch a metadata document
FOREIGN = "https://conformance.example"  # an origin that is not the server's
# redirect_uris that a sign-in page MUST refuse (§4.12.3): a script, a document, a scheme without a ".", and plain http
# on a host that is not loopback.
BAD_REDIRECTS = ["javascript:alert(document.domain)//", "data:text/html,<script>alert(document.domain)</script>",
                 "conformance:/signed-in", "http://conformance.example/signed-in"]
SIGN_IN_WAIT = 300  # seconds a person has for each sign-in


def oauth_needs(s):
    return "ext:oauth" in s.get("capabilities", []) and offers("external")(s)


def loopback(host):
    host = (host or "").strip("[]").lower()
    if host == "localhost" or host.endswith(".localhost"):
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def origin_of(run):
    """The server's origin (§4.12.1): https:// with the host and any port of its address, or http:// for a ws://
    address on a loopback host."""
    parts = urllib.parse.urlsplit(run.args.url)
    scheme = "http" if parts.scheme == "ws" and loopback(parts.hostname) else "https"
    host = f"[{parts.hostname}]" if ":" in parts.hostname else parts.hostname
    port = parts.port if parts.port not in (None, 80 if scheme == "http" else 443) else None
    return f"{scheme}://{host}" + (f":{port}" if port else "")


def unopenable(url, what="url"):
    """Why clients refuse to open url (§4.12.1), or None."""
    parts = urllib.parse.urlsplit(url) if isinstance(url, str) else None
    if not parts or not parts.hostname or not (parts.scheme == "https" or parts.scheme == "http" and loopback(parts.hostname)):
        return f"{what} {url!r} is neither an absolute https URL nor http on a loopback host"
    return None


def page_problem(url):
    """Why url is not a sign-in page's url (§4.12.1), or None."""
    problem = unopenable(url)
    if problem:
        return problem
    taken = sorted({k for k, _ in urllib.parse.parse_qsl(urllib.parse.urlsplit(url).query)} & SIGN_IN_PARAMS)
    return taken and f"url's query sets {', '.join(taken)}, which clients set (§4.12.2)" or None


def loopback_redirect():
    return f"http://127.0.0.1:{secrets.randbelow(16000) + 49152}/cb"


def made_up(run):
    """Redemption fields with a code that no server issued."""
    return {"code": "conformance-" + secrets.token_urlsafe(24), "code_verifier": secrets.token_urlsafe(48),
            "redirect_uri": loopback_redirect(), "client_id": CLIENT_ID}


class Grant:
    """An authorization request to a sign-in page (§4.12.2), and the redirect that came back."""

    def __init__(self, run, page, redirect_uri, **change):
        self.verifier = secrets.token_urlsafe(48)
        challenge = base64.urlsafe_b64encode(hashlib.sha256(self.verifier.encode()).digest()).rstrip(b"=").decode()
        self.state, self.redirect_uri, self.client_id = secrets.token_urlsafe(16), redirect_uri, CLIENT_ID
        params = {"response_type": "code", "client_id": CLIENT_ID, "redirect_uri": redirect_uri,
                  "code_challenge": challenge, "code_challenge_method": "S256", "state": self.state,
                  "resource": origin_of(run), **change}
        parts = urllib.parse.urlsplit(page)
        query = urllib.parse.parse_qsl(parts.query, keep_blank_values=True)
        query += [(k, v) for k, v in params.items() if v is not None]
        self.url = urllib.parse.urlunsplit(parts._replace(query=urllib.parse.urlencode(query)))
        self.client_id, self.query, self.code = params["client_id"], {}, None
        self.conn = None  # the connection that the code redeems on, where it must be one
        self.action = None  # a passkey page code's action

    def redemption(self, **change):
        return {"code": self.code, "code_verifier": self.verifier, "redirect_uri": self.redirect_uri,
                "client_id": self.client_id, **change}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


NO_REDIRECTS = urllib.request.build_opener(NoRedirect)


def fetch(url, data=None, headers=None, method=None):
    """Request url without following redirects, and return (status, headers, body)."""
    request = urllib.request.Request(url, data=data, headers=headers or {}, method=method)
    try:
        with NO_REDIRECTS.open(request, timeout=WAIT * 5) as response:
            return response.status, response.headers, response.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as error:
        return error.code, error.headers, error.read().decode("utf-8", "replace")


async def http_request(url, data=None, headers=None, method=None):
    """fetch, which waits out a rate limit for a while, then skips the check."""
    waited = 0
    while True:
        try:
            status, answer, body = await asyncio.to_thread(fetch, url, data, headers, method)
        except OSError as error:
            raise Fail(f"{method or ('POST' if data else 'GET')} {url}: {error}") from None
        if status != 429:
            return status, answer, body
        waited += await back_off(answer.get("Retry-After"), waited, f"the server's policy refused {url}: HTTP 429")


def redirects_to(status, headers, page, redirect_uri):
    """Whether a response redirects to redirect_uri."""
    if not 300 <= status < 400 or not headers.get("Location"):
        return False
    target = urllib.parse.urlsplit(urllib.parse.urljoin(page, headers["Location"]))
    want = urllib.parse.urlsplit(redirect_uri)
    return (target.scheme, target.netloc, target.path) == (want.scheme, want.netloc, want.path)


async def open_from(run, origin):
    """A connection that is not signed in, opened with origin as its Origin header (None: none), or None if the
    server refuses the handshake, such as for an origin it does not allow."""
    try:
        return await run.open(auth=False, origin=origin)
    except InvalidStatus:
        return None


def from_origin(origin):
    return "a connection with no Origin" if origin is None else f"a connection with Origin {origin}"


async def begun(run, key, params):
    """The reply to a begin, sent once on a connection with no Origin, and kept for later checks."""
    if key not in run.begun:
        conn = await run.open(auth=False)
        run.begun[key] = (await conn.request("auth", params))[1]
    policy(run.begun[key])
    return run.begun[key]


async def external_page(run):
    """The external object of an external begin (§4.12.1)."""
    reply = await begun(run, "external", {"scheme": "external"})
    external = reply.get("result", {}).get("external")
    must(isinstance(external, dict) and isinstance(external.get("url"), str), f"an external begin got {describe(reply)}")
    return external


async def passkey_page(run):
    """The external object of a login begin: the passkey page (§4.10.1), or Skip."""
    reply = await begun(run, "login", {"scheme": "webauthn", "action": "login", "step": "begin"})
    external = reply.get("result", {}).get("external")
    if not isinstance(external, dict) or not isinstance(external.get("url"), str):
        raise Skip("a login begin from a connection with no Origin offers no passkey page")
    return external


async def page_of(run, kind):
    return (await (external_page if kind == "external" else passkey_page)(run))["url"]


@check("email.shape.lists-token", "4.11", "a server that offers email also lists token", needs=offers("email"))
async def _(run):
    must("token" in run.server.get("auth", []), "server.auth lists email but not token")


@check("external.shape.lists-token", "4.12", "a server that offers external also lists token", needs=offers("external"))
async def _(run):
    must("token" in run.server.get("auth", []), "server.auth lists external but not token")


@check("email.A5.no-enumeration", "4.11.1", "an email proposal returns {} and authenticates nothing", needs=offers("email"))
async def _(run):
    conn = await run.open(auth=False)
    _, reply = await conn.request("auth", {"scheme": "email", "email": f"conformance-{secrets.token_hex(4)}@example.invalid",
                                           "state": secrets.token_urlsafe(16)})
    policy(reply)
    if code(reply) == CODES["denied"]:
        raise Skip(f"the server's policy refused a proposal for an .invalid address: {describe(reply)}")
    must(reply.get("result") == {}, f"a proposal got {describe(reply)}")
    expect_error((await conn.request("me", {}))[1], "denied", "me after a proposal")


@check("email.A5.bad-token", "4.11.3", "an email approval with a made-up token is denied", needs=offers("email"))
async def _(run):
    conn = await run.open(auth=False)
    _, reply = await conn.request("auth", {"scheme": "email", "token": "conformance-" + secrets.token_urlsafe(24)})
    policy(reply)
    expect_error(reply, "denied", "an approval with a made-up token")


@check("external.shape.begin", "4.12.1", "an external begin returns an https or loopback url, and authenticates nothing", needs=offers("external"))
async def _(run):
    conn = await run.open(auth=False)
    _, reply = await conn.request("auth", {"scheme": "external"})
    policy(reply)
    run.begun.setdefault("external", reply)
    external = reply.get("result", {}).get("external")
    must(isinstance(external, dict), f"a begin got {describe(reply)}")
    must("you" not in reply["result"], "the begin returned you")
    problem = page_problem(external.get("url"))
    must(not problem, problem)
    if "issuer" in external:
        problem = unopenable(external["issuer"], "issuer")
        must(not problem, problem)
        must(not urllib.parse.urlsplit(external["issuer"]).query, "issuer has a query (RFC 8414 §2)")
    expect_error((await conn.request("me", {}))[1], "denied", "me after a begin")


@check("external.shape.made-up-token", "4.12.1", "an external request with a made-up token is denied", needs=offers("external"))
async def _(run):
    conn = await run.open(auth=False)
    _, reply = await conn.request("auth", {"scheme": "external", "token": "conformance-" + secrets.token_urlsafe(24)})
    policy(reply)
    expect_error(reply, "denied", "external with a made-up token")


@check("external.A5.bad-code", "4.12.4", "an external redemption of a made-up code is denied", needs=offers("external"))
async def _(run):
    conn = await run.open(auth=False)
    _, reply = await conn.request("auth", {"scheme": "external", **made_up(run)})
    policy(reply)
    expect_error(reply, "denied", "a made-up code")


def check_begin(run, result, action, where):
    """The rules of §4.10 and §4.10.1 for one begin result."""
    must("you" not in result, f"{where}: the begin returned you")
    has = [k for k in ("challenge_id", "public_key") if k in result]
    must(len(has) != 1, f"{where}: the begin has {' '.join(has)} without the other of challenge_id and public_key")
    must(has or "external" in result, f"{where}: the begin has neither challenge_id and public_key nor external")
    if "external" in result:
        problem = page_problem(result["external"].get("url"))
        must(not problem, f"{where}: {problem}")
    if not has:
        return None
    key = result["public_key"]
    must(isinstance(key, dict), f"{where}: public_key is not an object")
    rp = key.get("rpId") if action == "login" else key.get("rp", {}).get("id")
    host = urllib.parse.urlsplit(run.args.url).hostname
    if rp and host != rp and not host.endswith("." + rp):
        must("external" in result, f"{where}: RP ID {rp!r} is neither {host} nor a domain above it, so clients "
                                   "refuse it (§4.10), and the begin offers no passkey page")
        run.info(f"{where}: RP ID {rp!r} does not cover {host}, so clients here use the passkey page")
    if action == "login":
        must(not key.get("allowCredentials"), f"{where}: the login sends allowCredentials")
        verification = key.get("userVerification")
    else:
        selection = key.get("authenticatorSelection") or {}
        must(selection.get("residentKey") == "required"
             or "residentKey" not in selection and selection.get("requireResidentKey") is True,
             f"{where}: the registration does not require a discoverable credential (residentKey: required)")
        verification = selection.get("userVerification")
    must(verification == "required", f"{where}: userVerification is {verification!r}, not 'required'")
    return key


@check("webauthn.shape.begin", "4.10", "a login begin returns a ceremony, a passkey page, or both, for any login", needs=offers("webauthn"))
async def _(run):
    tried = 0
    for origin in (None, origin_of(run)):
        conn = await open_from(run, origin)
        if not conn:
            run.info(f"the server refused the handshake of {from_origin(origin)}")
            continue
        _, reply = await conn.request("auth", {"scheme": "webauthn", "action": "login", "step": "begin"})
        policy(reply)
        if code(reply) == CODES["denied"]:  # server policy decides who can authenticate (§4.10)
            run.info(f"from {from_origin(origin)}, the server's policy refused it: {describe(reply)}")
            continue
        must("result" in reply, f"from {from_origin(origin)}: {describe(reply)}")
        check_begin(run, reply["result"], "login", f"from {from_origin(origin)}")
        expect_error((await conn.request("me", {}))[1], "denied", "me after a begin")
        tried += 1
    if not tried:
        raise Skip("the server refused every handshake or login begin")


@check("webauthn.shape.register-begin", "4.10", "a register begin requires a discoverable credential and user verification", needs=offers("webauthn"))
async def _(run):
    keys = []
    params = {"scheme": "webauthn", "action": "register", "step": "begin", "name": "Conformance"}
    for origin in (origin_of(run), None):
        conn = await open_from(run, origin)
        if not conn:
            continue
        where = f"from {from_origin(origin)}"
        _, reply = await conn.request("auth", params)
        if code(reply) == CODES["denied"] and offers("guest")(run.server):
            _, guest = await conn.request("auth", {"scheme": "guest", "name": "Conformance"})
            if signed_in(guest):
                where += ", signed in as a guest"
                _, reply = await conn.request("auth", params)
        policy(reply)
        if code(reply) == CODES["denied"]:
            run.info(f"{where}, the server's policy refused it: {describe(reply)}")
            continue
        must("result" in reply, f"{where}: {describe(reply)}")
        key = check_begin(run, reply["result"], "register", where)
        if key:
            keys.append((where, key))
    if not keys:
        raise Skip("no register begin returned public_key")
    for where, key in keys:
        user = key.get("user") or {}
        should(user.get("name") == "Conformance" and user.get("displayName") == "Conformance",
               f"{where}: user.name {user.get('name')!r} and user.displayName {user.get('displayName')!r} are not the "
               "begin's name 'Conformance'")


@check("webauthn.A5.bad-code", "4.10.1", "a webauthn finish with a made-up code is denied", needs=offers("webauthn"))
async def _(run):
    await passkey_page(run)
    conn = await run.open(auth=False)
    _, reply = await conn.request("auth", {"scheme": "webauthn", "action": "login", "step": "finish", **made_up(run)})
    policy(reply)
    expect_error(reply, "denied", "a finish with a made-up code")


# A WebAuthn ceremony in the client (§4.10), with a software authenticator.

def b64url(data):
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def unb64url(text):
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def cbor(value):
    """The CBOR encoding of value: enough for an attestation object and a COSE key."""
    def head(major, n):
        if n < 24:
            return bytes([major << 5 | n])
        size = next(size for size in (1, 2, 4, 8) if n < 1 << 8 * size)
        return bytes([major << 5 | {1: 24, 2: 25, 4: 26, 8: 27}[size]]) + n.to_bytes(size, "big")
    if isinstance(value, int):
        return head(0, value) if value >= 0 else head(1, -1 - value)
    if isinstance(value, bytes):
        return head(2, len(value)) + value
    if isinstance(value, str):
        return head(3, len(value.encode())) + value.encode()
    if isinstance(value, dict):
        return head(5, len(value)) + b"".join(cbor(k) + cbor(v) for k, v in value.items())
    raise TypeError(type(value))


class Authenticator:
    """A passkey authenticator in software: ES256, discoverable credentials, user verification, and none
    attestation. It answers WebAuthn options as a browser would, for an origin."""

    UP, UV, AT = 0x01, 0x04, 0x40

    def __init__(self):
        try:
            from cryptography.hazmat.primitives import hashes, serialization
            from cryptography.hazmat.primitives.asymmetric import ec
        except ImportError:
            raise Skip("needs the cryptography package: run with uv, or pip install cryptography") from None
        self.ec, self.hashes, self.serialization = ec, hashes, serialization
        self.credentials = {}  # rp_id -> [(credential_id, private key, user handle)]
        self.count = 0

    def client_data(self, kind, options, origin):
        return json.dumps({"type": kind, "challenge": options["challenge"], "origin": origin, "crossOrigin": False},
                          separators=(",", ":")).encode()

    def auth_data(self, rp_id, flags, attested=b""):
        self.count += 1
        return hashlib.sha256(rp_id.encode()).digest() + bytes([flags]) + self.count.to_bytes(4, "big") + attested

    def create(self, options, origin):
        """A registration credential, as PublicKeyCredential.toJSON() gives it."""
        rp_id = (options.get("rp") or {}).get("id") or urllib.parse.urlsplit(origin).hostname
        if not any(p.get("alg") == -7 for p in options.get("pubKeyCredParams", [])):
            raise Skip("the registration does not take ES256 (alg -7), the one algorithm that conform.py signs with")
        key = self.ec.generate_private_key(self.ec.SECP256R1())
        numbers = key.public_key().public_numbers()
        cose = cbor({1: 2, 3: -7, -1: 1, -2: numbers.x.to_bytes(32, "big"), -3: numbers.y.to_bytes(32, "big")})
        credential_id = secrets.token_bytes(32)
        attested = bytes(16) + len(credential_id).to_bytes(2, "big") + credential_id + cose
        auth_data = self.auth_data(rp_id, self.UP | self.UV | self.AT, attested)
        user = unb64url(options["user"]["id"])
        self.credentials.setdefault(rp_id, []).append((credential_id, key, user))
        spki = key.public_key().public_bytes(self.serialization.Encoding.DER,
                                             self.serialization.PublicFormat.SubjectPublicKeyInfo)
        extensions = {"credProps": {"rk": True}} if "credProps" in (options.get("extensions") or {}) else {}
        return {"id": b64url(credential_id), "rawId": b64url(credential_id), "type": "public-key",
                "authenticatorAttachment": "platform", "clientExtensionResults": extensions,
                "response": {"clientDataJSON": b64url(self.client_data("webauthn.create", options, origin)),
                             "attestationObject": b64url(cbor({"fmt": "none", "attStmt": {}, "authData": auth_data})),
                             "authenticatorData": b64url(auth_data), "publicKey": b64url(spki),
                             "publicKeyAlgorithm": -7, "transports": ["internal"]}}

    def get(self, options, origin):
        """A login credential with the newest passkey for the RP ID, as PublicKeyCredential.toJSON() gives it."""
        rp_id = options.get("rpId") or urllib.parse.urlsplit(origin).hostname
        if not self.credentials.get(rp_id):
            raise Skip(f"no passkey for RP ID {rp_id}")
        credential_id, key, user = self.credentials[rp_id][-1]
        auth_data = self.auth_data(rp_id, self.UP | self.UV)
        client_data = self.client_data("webauthn.get", options, origin)
        signature = key.sign(auth_data + hashlib.sha256(client_data).digest(), self.ec.ECDSA(self.hashes.SHA256()))
        return {"id": b64url(credential_id), "rawId": b64url(credential_id), "type": "public-key",
                "authenticatorAttachment": "platform", "clientExtensionResults": {},
                "response": {"clientDataJSON": b64url(client_data), "authenticatorData": b64url(auth_data),
                             "signature": b64url(signature), "userHandle": b64url(user)}}


def ceremony_origin(run):
    return run.args.origin or origin_of(run)


async def ceremony_begin(run, action, conn):
    """A begin on conn, and its result, which has challenge_id and public_key, or Skip."""
    params = {"scheme": "webauthn", "action": action, "step": "begin"}
    if action == "register":
        params["name"] = "Conformance"
    _, reply = await conn.request("auth", params)
    policy(reply)
    result = reply.get("result", {})
    if not isinstance(result.get("public_key"), dict) or "challenge_id" not in result:
        raise Skip(f"a {action} begin from Origin {ceremony_origin(run)} offers no ceremony ({describe(reply)}): pass "
                   "--origin with an origin that the server takes for passkeys")
    return result


def finish(action, begin, credential):
    return {"scheme": "webauthn", "action": action, "step": "finish", "challenge_id": begin["challenge_id"],
            "credential": credential}


async def ceremony_conn(run):
    origin = ceremony_origin(run)
    conn = await open_from(run, origin)
    if not conn:
        raise Skip(f"the server refused the handshake of a connection with Origin {origin}: pass --origin with an "
                   "origin that it takes")
    return conn


async def login(run, key, conn=None):
    """A login begin on conn, or on a new connection, and the credential that answers it: (conn, begin, credential)."""
    conn = conn or await ceremony_conn(run)
    begin = await ceremony_begin(run, "login", conn)
    return conn, begin, key.get(begin["public_key"], ceremony_origin(run))


async def ceremony_flow(run):
    """Register a passkey from --origin, as a guest where the server's policy asks for an account first, and log in
    with it."""
    key, origin, out = Authenticator(), ceremony_origin(run), {}
    conn = await ceremony_conn(run)
    _, reply = await conn.request("auth", {"scheme": "webauthn", "action": "register", "step": "begin", "name": "Conformance"})
    if code(reply) == CODES["denied"] and offers("guest")(run.server):
        _, guest = await conn.request("auth", {"scheme": "guest", "name": "Conformance"})
        out["guest"] = signed_in(guest)
    begin = await ceremony_begin(run, "register", conn)
    _, reply = await conn.request("auth", finish("register", begin, key.create(begin["public_key"], origin)))
    policy(reply)
    if not signed_in(reply):
        raise Skip(f"the registration's finish from Origin {origin} got {describe(reply)}: if the server does not "
                   "take that origin for passkeys, pass --origin with one that it takes")
    out["registered"] = reply["result"]["you"]["user_id"]
    conn, begin, credential = await login(run, key)
    _, out["login"] = await conn.request("auth", finish("login", begin, credential))
    out["key"] = key
    return out


async def ceremony(run):
    if "ceremony" not in run.flows:
        try:
            run.flows["ceremony"] = await ceremony_flow(run)
        except (Fail, Skip) as error:
            run.flows["ceremony"] = error
    outcome = run.flows["ceremony"]
    if isinstance(outcome, Exception):
        raise outcome
    return outcome


@check("webauthn.shape.ceremony", "4.10", "a ceremony in the client registers a passkey, and logs in with it",
       needs=offers("webauthn"))
async def _(run):
    out = await ceremony(run)
    run.info(f"Origin {ceremony_origin(run)}" + (", registered as a guest" if out.get("guest") else ""))
    reply = out["login"]
    must(signed_in(reply), f"a login with the new passkey: {describe(reply)}")
    must(reply["result"]["you"]["user_id"] == out["registered"],
         f"the login signed in as {reply['result']['you']['user_id']}, not {out['registered']}, who registered")


@check("webauthn.A4.one-ceremony", "4.10", "a finish on another connection, a second finish, and a finish for a "
       "replaced begin are denied", needs=offers("webauthn"))
async def _(run):
    out = await ceremony(run)
    if not signed_in(out["login"]):
        raise Skip("the passkey did not log in, so a refusal proves nothing")
    key = out["key"]
    # A finish on another connection: one with no ceremony, and one with its own.
    _, begin, credential = await login(run, key)
    for own in (False, True):
        other = await ceremony_conn(run)
        if own:
            await ceremony_begin(run, "login", other)
        _, reply = await other.request("auth", finish("login", begin, credential))
        policy(reply)
        where = "another connection" + (" with its own begin" if own else "")
        must(not signed_in(reply), f"a finish on {where} signed in")
        expect_error(reply, "denied", f"a finish on {where}")
    # A second finish of one ceremony.
    conn, begin, credential = await login(run, key)
    _, first = await conn.request("auth", finish("login", begin, credential))
    must(signed_in(first), f"a login: {describe(first)}")
    _, again = await conn.request("auth", finish("login", begin, credential))
    must(not signed_in(again), "a second finish of the ceremony signed in again")
    expect_error(again, "denied", "a second finish")
    # A new begin replaces the pending ceremony.
    conn, begin, credential = await login(run, key)
    await ceremony_begin(run, "login", conn)
    _, replaced = await conn.request("auth", finish("login", begin, credential))
    must(not signed_in(replaced), "a finish for a begin that a later begin replaced signed in")
    expect_error(replaced, "denied", "a finish for a replaced begin")


@check("webauthn.A1.token-origin", "4.10", "a token from a finish with credential signs in only from the ceremony's "
       "Origin", needs=lambda s: offers("webauthn")(s) and "token" in s.get("auth", []))
async def _(run):
    out = await ceremony(run)
    reply = out["login"]
    if not signed_in(reply):
        raise Skip("the passkey did not log in")
    token = reply["result"].get("token")
    if not isinstance(token, str):
        raise Skip("the finish returned no token, which it MAY leave out")
    origin = ceremony_origin(run)
    conn = await ceremony_conn(run)
    _, same = await conn.request("auth", {"scheme": "token", "token": token})
    policy(same)
    should(signed_in(same), f"the token, on a connection with the ceremony's Origin {origin}: {describe(same)}")
    token = same.get("result", {}).get("token", token)  # a server may rotate it (§3.2.1)
    tried = []
    for other in (None, FOREIGN if origin != FOREIGN else "https://conformance.example.org"):
        conn = await open_from(run, other)
        if not conn:
            run.info(f"the server refused the handshake of {from_origin(other)}")
            continue
        _, reply = await conn.request("auth", {"scheme": "token", "token": token})
        policy(reply)
        must(not signed_in(reply), f"the token signed in on {from_origin(other)}")
        expect_error(reply, "denied", f"the token on {from_origin(other)}")
        tried.append(other)
    if not tried:
        raise Skip("the server refused the handshake of every other Origin")


PAGES = {"external": ("the external sign-in page", offers("external")),
         "passkey": ("the passkey page", offers("webauthn"))}


async def well_formed(run, kind):
    """The page's answer to a well-formed request, fetched once: (page, request, status, headers)."""
    if kind not in run.pages:
        page = await page_of(run, kind)
        request = Grant(run, page, loopback_redirect())
        status, headers, _ = await http_request(request.url)
        run.pages[kind] = (page, request, status, headers)
    return run.pages[kind]


def page_checks(kind):
    name, needs = PAGES[kind]

    def ident(area, name):
        """external.<area>.<name> for the external page, and webauthn.<area>.page-<name> for the passkey page."""
        return f"external.{area}.{name}" if kind == "external" else f"webauthn.{area}.page-{name}"

    @check(f"{'external' if kind == 'external' else 'webauthn'}.shape.page-answer", "4.12.3", f"{name} answers a well-formed request without a redirect to redirect_uri", needs=needs)
    async def _(run):
        page, request, status, headers = await well_formed(run, kind)
        must(not redirects_to(status, headers, page, request.redirect_uri),
             f"it redirected to redirect_uri before the user allowed the client: {headers.get('Location')}")
        if 300 <= status < 400:
            run.info(f"it answered {status}, to {headers.get('Location')}: a sign-in elsewhere")
        else:
            should(200 <= status < 300, f"a request with a loopback redirect_uri got HTTP {status} (§4.12.3)")

    @check(ident("A2", "opener-policy"), "4.12.3", f"{name} sends no Cross-Origin-Opener-Policy other than unsafe-none", needs=needs)
    async def _(run):
        _, _, _, headers = await well_formed(run, kind)
        opener = headers.get("Cross-Origin-Opener-Policy")
        must(opener is None or opener.split(";")[0].strip().lower() == "unsafe-none",
             f"it sends Cross-Origin-Opener-Policy: {opener}")

    @check(ident("A2", "referrer-policy"), "4.12.3", f"{name} sends Referrer-Policy: no-referrer", needs=needs)
    async def _(run):
        _, _, status, headers = await well_formed(run, kind)
        if 300 <= status < 400:
            raise Skip(f"it answered {status}, to a sign-in elsewhere, so there is no page to check")
        tokens = [t.strip().lower() for t in headers.get("Referrer-Policy", "").split(",") if t.strip()]
        should(tokens and tokens[-1] == "no-referrer", f"Referrer-Policy is {headers.get('Referrer-Policy')!r}")

    async def refused(run, cases):
        page = await page_of(run, kind)
        for case, change in cases.items():
            request = Grant(run, page, loopback_redirect(), **change)
            status, headers, _ = await http_request(request.url)
            must(not redirects_to(status, headers, page, request.redirect_uri),
                 f"a request {case} redirected to redirect_uri, which makes the page an open redirector")
            must(not 300 <= status < 400, f"a request {case} redirected to {headers.get('Location')} instead of "
                                          "showing its error")
            if status < 300:
                run.info(f"a request {case} got HTTP {status}: make sure that the page shows an error")

    @check(ident("A3", "pkce-required"), "4.12.3", f"{name} shows the error of a request without PKCE, or with plain "
                                                   "PKCE, and never redirects it", needs=needs)
    async def _(run):
        await refused(run, {"without PKCE": {"code_challenge": None, "code_challenge_method": None},
                            "with plain PKCE": {"code_challenge_method": "plain"}})

    @check(ident("A1", "resource"), "4.12.3", f"{name} shows the error of a request without resource, or with "
                                              "another resource, and never redirects it", needs=needs)
    async def _(run):
        status, _, _ = await http_request(origin_of(run) + "/.well-known/openid-configuration")
        if 200 <= status < 300:
            raise Skip("the server publishes OpenID Connect discovery, so it is an identity provider for other sites, "
                       "and its policy decides which other requests are valid (§4.12.3)")
        await refused(run, {"without resource": {"resource": None}, "with another resource": {"resource": FOREIGN}})

    @check(ident("A2", "redirect-uri"), "4.12.3", f"{name} refuses a javascript:, data:, dotless-scheme, or non-loopback http redirect_uri, and "
                     "never redirects it", needs=needs)
    async def _(run):
        page = await page_of(run, kind)
        shown = []
        for redirect_uri in BAD_REDIRECTS:
            request = Grant(run, page, redirect_uri)
            status, headers, _ = await http_request(request.url)
            must(not redirects_to(status, headers, page, redirect_uri), f"it redirected to {redirect_uri}")
            must(not 300 <= status < 400, f"a request with redirect_uri {redirect_uri} redirected to "
                                          f"{headers.get('Location')} instead of showing its error")
            if status < 300:
                shown.append(f"{redirect_uri} (HTTP {status})")
        if shown:
            raise Manual(f"it answered {', '.join(shown)}: check that the page shows an error, and offers no sign-in")

    @check(ident("shape", "any-client"), "4.12.3", f"{name} takes any client_id, and an https or private-use redirect_uri", needs=needs)
    async def _(run):
        page = await page_of(run, kind)
        refused = []
        for redirect_uri in ("https://conformance.example/signed-in", "org.apron.conformance:/signed-in"):
            request = Grant(run, page, redirect_uri, client_id="conformance-" + secrets.token_hex(4))
            status, headers, _ = await http_request(request.url)
            must(not redirects_to(status, headers, page, redirect_uri),
                 f"it redirected to {redirect_uri} before the user allowed the client")
            if status >= 400:
                refused.append(f"{redirect_uri} (HTTP {status})")
        should(not refused, f"it refused a well-formed request to {', '.join(refused)}")


page_checks("external")
page_checks("passkey")


@check("webauthn.A2.page-frame", "4.10.1", "the passkey page refuses to be shown in a frame", needs=offers("webauthn"))
async def _(run):
    _, _, status, headers = await well_formed(run, "passkey")
    frame_options = headers.get("X-Frame-Options", "").strip().lower()
    ancestors = [d.split()[1:] for d in headers.get("Content-Security-Policy", "").lower().split(";")
                 if d.split()[:1] == ["frame-ancestors"]]
    must(frame_options in ("deny", "sameorigin") or ancestors and "*" not in ancestors[0],
         "it sends neither X-Frame-Options DENY or SAMEORIGIN nor a Content-Security-Policy frame-ancestors")


# ext:oauth, for a server that is its own authorization server.

async def own_issuer(run):
    external = await external_page(run)
    if external.get("issuer", origin_of(run)) != origin_of(run):
        raise Skip(f"issuer {external['issuer']} is another authorization server")


async def oauth_metadata(run):
    """The server's authorization server metadata (RFC 8414), fetched once."""
    await own_issuer(run)
    if "metadata" not in run.oauth:
        url = origin_of(run) + "/.well-known/oauth-authorization-server"
        status, headers, body = await http_request(url, headers={"Accept": "application/json", "Origin": FOREIGN})
        must(status == 200, f"GET {url}: HTTP {status}")
        try:
            run.oauth["metadata"] = (json.loads(body), headers)
        except ValueError:
            raise Fail(f"GET {url}: not JSON") from None
    return run.oauth["metadata"]


async def token_endpoint(run):
    try:
        endpoint = (await oauth_metadata(run))[0].get("token_endpoint")
    except Fail as error:
        raise Skip(f"no metadata: {error}") from None
    if not isinstance(endpoint, str) or unopenable(endpoint):
        raise Skip("the metadata gives no usable token_endpoint")
    return endpoint


async def token_request(endpoint, form, basic=None):
    """POST form to the token endpoint from another origin, with client_id by HTTP Basic if basic is given, and
    return (status, headers, JSON body or None)."""
    headers = {"Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json", "Origin": FOREIGN}
    if basic is not None:
        pair = f"{urllib.parse.quote_plus(basic)}:"  # RFC 6749 §2.3.1, with an empty password
        headers["Authorization"] = "Basic " + base64.b64encode(pair.encode()).decode()
    status, headers, body = await http_request(endpoint, urllib.parse.urlencode(form).encode(), headers)
    try:
        return status, headers, json.loads(body)
    except ValueError:
        return status, headers, None


@check("oauth.shape.metadata", "ext:oauth", "metadata at /.well-known/oauth-authorization-server gives the server's endpoints", needs=oauth_needs)
async def _(run):
    doc, _ = await oauth_metadata(run)
    origin, page = origin_of(run), (await external_page(run))["url"]
    must(doc.get("issuer") == origin, f"issuer is {doc.get('issuer')!r}, not {origin} (RFC 8414 §3.3)")
    endpoint = urllib.parse.urlunsplit(urllib.parse.urlsplit(page)._replace(query="", fragment=""))
    must(doc.get("authorization_endpoint") == endpoint,
         f"authorization_endpoint is {doc.get('authorization_endpoint')!r}, not the begin's {endpoint}")
    problem = unopenable(doc.get("token_endpoint"), "token_endpoint")
    must(not problem, problem)
    must("code" in doc.get("response_types_supported", []), "response_types_supported lacks code")
    should("S256" in doc.get("code_challenge_methods_supported", []), "code_challenge_methods_supported lacks S256")


@check("oauth.shape.cors", "ext:oauth", "the metadata and the token endpoint allow cross-origin requests, HTTP Basic included", needs=oauth_needs)
async def _(run):
    allows = lambda headers: headers.get("Access-Control-Allow-Origin", "").strip() in ("*", FOREIGN)
    _, headers = await oauth_metadata(run)
    must(allows(headers), "the metadata lacks Access-Control-Allow-Origin")
    endpoint = await token_endpoint(run)
    _, headers, _ = await token_request(endpoint, {"grant_type": "authorization_code", **made_up(run)})
    must(allows(headers), "the token endpoint's answer lacks Access-Control-Allow-Origin")
    status, headers, _ = await http_request(endpoint, method="OPTIONS", headers={
        "Origin": FOREIGN, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "authorization"})
    methods = {m.strip().upper() for m in headers.get("Access-Control-Allow-Methods", "").split(",")}
    allowed = {h.strip().lower() for h in headers.get("Access-Control-Allow-Headers", "").split(",")}
    must(200 <= status < 300 and allows(headers) and methods & {"POST", "*"},
         f"a preflight for POST got HTTP {status}, Allow-Origin {headers.get('Access-Control-Allow-Origin')!r}, "
         f"Allow-Methods {headers.get('Access-Control-Allow-Methods')!r}")
    must("authorization" in allowed, "a preflight does not allow the Authorization header, so a web client cannot "
                                     "send its client_id by HTTP Basic")


@check("oauth.A5.bad-code", "ext:oauth", "the token endpoint answers a made-up code with invalid_grant, with client_id in the body or by "
                    "HTTP Basic", needs=oauth_needs)
async def _(run):
    endpoint = await token_endpoint(run)
    fields = {"grant_type": "authorization_code", **made_up(run), "resource": origin_of(run)}
    status, _, doc = await token_request(endpoint, fields)
    must(status == 400 and (doc or {}).get("error") == "invalid_grant",
         f"client_id in the body: HTTP {status}, {json.dumps(doc)} (RFC 6749 §5.2)")
    status, _, doc = await token_request(endpoint, {k: v for k, v in fields.items() if k != "client_id"}, CLIENT_ID)
    must(status == 400 and (doc or {}).get("error") == "invalid_grant",
         f"client_id by HTTP Basic with an empty password: HTTP {status}, {json.dumps(doc)}")


@check("oauth.shape.resource-metadata", "ext:oauth", "protected resource metadata, where published, gives the server and its authorization server",
       needs=oauth_needs)
async def _(run):
    external, origin = await external_page(run), origin_of(run)
    issuer = external.get("issuer", origin)
    url = origin + "/.well-known/oauth-protected-resource"
    status, _, body = await http_request(url, headers={"Accept": "application/json"})
    if status == 404:
        must(issuer == origin, f"GET {url}: HTTP 404, but issuer {issuer} is another authorization server")
        raise Skip("not published, which a server that is its own authorization server need not do")
    must(status == 200, f"GET {url}: HTTP {status}")
    try:
        doc = json.loads(body)
    except ValueError:
        raise Fail(f"GET {url}: not JSON") from None
    must(doc.get("resource") == origin, f"resource is {doc.get('resource')!r}, not {origin} (RFC 9728 §3.3)")
    must(issuer in doc.get("authorization_servers", []), f"authorization_servers lacks {issuer}")


# Sign-in with a person (--sign-in): each code comes from a page that a person goes through.

class Person:
    """A person who signs in on the server's pages. Each redirect comes back to a loopback redirect URI, which
    §4.12.3 says servers SHOULD accept with any port."""

    def __init__(self):
        self.hits, self.changed, self.skip = [], threading.Condition(), threading.Event()
        self.count, self.total, self.states = 0, None, set()  # states: of the requests sent so far
        person = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                parts = urllib.parse.urlsplit(self.path)
                body = b"<!doctype html><meta charset=utf-8><title>conform.py</title><p>Done. Go back to conform.py.\n"
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                if parts.path == "/cb":
                    with person.changed:
                        person.hits.append(dict(urllib.parse.parse_qsl(parts.query)))
                        person.changed.notify_all()

            def log_message(self, *args):
                pass

        self.state = tempfile.mkdtemp(prefix="conform-portal-")  # a portal's own state, for the whole run
        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.redirect_uri = f"http://127.0.0.1:{self.server.server_address[1]}/cb"
        self.other_redirect_uri = self.redirect_uri[:-len("/cb")] + "/other"

    def hit(self, index, stale, seconds):
        """The first redirect from index on whose state is not in stale, waiting up to seconds for it, or None. A
        stale state comes from an earlier request, such as a reloaded tab."""
        fresh = lambda: next((q for q in self.hits[index:] if q.get("state") not in stale), None)
        with self.changed:
            self.changed.wait_for(lambda: fresh() is not None or self.skip.is_set(), seconds)
            return fresh()


def wait_for_enter(event):
    try:
        if sys.stdin.readline():  # "" at end of file: no one can press Enter
            event.set()
    except (OSError, ValueError):
        pass


def open_browser(url):
    try:
        webbrowser.open(url)
    except Exception:
        pass


async def sign_ins(run):
    """How many sign-ins --sign-in plans for this server, before failed tries that use up codes: for each page, one
    that redeems, and one for the tries that must fail (chain); four for a new identity and a second account
    (identities); one for ext:oauth's token endpoint; one declined."""
    total = 0
    if offers("external")(run.server) and run.profile("external"):
        total += 2 + 4
        try:
            await own_issuer(run)
            total += oauth_needs(run.server)
        except (Skip, Fail):
            pass
    try:
        if run.profile("webauthn"):
            await passkey_page(run)
            total += 2
    except (Skip, Fail):
        pass
    return total + 1 if total else 0  # and a declined one


async def sign_in(run, page, why, decline=False, keep=None, identity="default"):
    """Send the person, or the portal, to page with a new authorization request, and return its Grant with the
    redirect's query. identity names who signs in, for a portal: the same name, the same account."""
    person = run.person
    if person.total is None:
        person.total = await sign_ins(run)
        print(f"-- --sign-in: {person.total} sign-ins {'by the portal' if run.args.portal else 'in a browser'}, and "
              f"more if a failed try uses up a code. Redirects come back to {person.redirect_uri}.", flush=True)
    person.count += 1
    person.total = max(person.total, person.count)
    grant = Grant(run, page, person.redirect_uri)
    index, stale = len(person.hits), set(person.states)
    person.states.add(grant.state)
    print(f"-- sign-in {person.count} of {person.total}: {why}", flush=True)
    if run.args.portal:
        query = await portal(run, grant, decline, identity, keep, index)
        return redeemable(grant, query, decline)
    print(f"   {'Decline it there, or press Enter here to skip it' if decline else 'Sign in and allow'}, at:", flush=True)
    print(f"   {grant.url}", flush=True)
    asyncio.get_running_loop().run_in_executor(None, open_browser, grant.url)
    if decline:
        person.skip.clear()
        threading.Thread(target=wait_for_enter, args=(person.skip,), daemon=True).start()
    deadline = time.monotonic() + SIGN_IN_WAIT
    while True:
        query = await asyncio.to_thread(person.hit, index, stale, 10)
        if query is not None:
            break
        if person.skip.is_set():
            person.skip.clear()
            raise Skip("the person skipped it")
        if time.monotonic() > deadline:
            raise Skip(f"no redirect came back within {SIGN_IN_WAIT // 60} minutes")
        if keep and not keep.closed and "ping" in run.server:
            await keep.notify("ping")  # the connection outlives a sign-in that takes longer than the ping interval
    return redeemable(grant, query, decline)


def redeemable(grant, query, decline):
    grant.query, grant.code = query, query.get("code")
    if not decline and not grant.code:
        if query.get("error") == "access_denied":
            raise Skip("the person declined: run again, and allow")
        raise Fail(f"the page redirected with {json.dumps(query)}, and no code")
    return grant


async def portal(run, grant, decline, identity, keep, index):
    """Run the --portal command for one sign-in, and return the redirect's query (DEVELOPMENT.md, Conformance)."""
    person = run.person
    env = {**os.environ, "APRON_PORTAL_REDIRECT_URI": grant.redirect_uri, "APRON_PORTAL_IDENTITY": identity,
           "APRON_PORTAL_DECISION": "decline" if decline else "allow", "APRON_PORTAL_STATE": person.state}
    try:
        child = await asyncio.create_subprocess_exec(*shlex.split(run.args.portal), grant.url, env=env,
                                                     stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    except OSError as error:
        raise Skip(f"cannot run the portal: {error}") from None
    reading = asyncio.ensure_future(child.communicate())
    deadline = time.monotonic() + SIGN_IN_WAIT
    while not reading.done():
        await asyncio.wait([reading], timeout=10)
        if time.monotonic() > deadline:
            child.kill()
            raise Skip(f"the portal did not finish within {SIGN_IN_WAIT // 60} minutes")
        if keep and not keep.closed and "ping" in run.server:
            await keep.notify("ping")
    out, err = (part.decode("utf-8", "replace") for part in reading.result())
    if run.args.verbose and err.strip():
        print("\n".join("   portal: " + line for line in err.strip().splitlines()), flush=True)
    if child.returncode != 0:
        why = (err.strip().splitlines() or [f"exit status {child.returncode}"])[-1]
        raise Skip(f"the portal could not finish the sign-in: {why}")
    # The redirect that the portal printed, or else the one that reached the loopback listener.
    landed = (out.strip().splitlines() or [""])[-1].strip()
    if landed.split("?")[0] == grant.redirect_uri:
        return dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(landed).query))
    query = await asyncio.to_thread(person.hit, index, set(person.states) - {grant.state}, 1)
    if query is None:
        raise Skip(f"the portal ended without a redirect to {grant.redirect_uri}: it printed {landed[:200]!r}")
    return query


async def flow(run, name, compute):
    """Run a sign-in flow once, and return its outcome to every check that reads it."""
    if run.person is None:
        raise Skip("needs a person to sign in: run with --sign-in")
    if name not in run.flows:
        try:
            run.flows[name] = await compute(run)
        except (Fail, Skip) as error:
            run.flows[name] = error
            raise
        except Exception as error:
            run.flows[name] = Fail(f"{type(error).__name__}: {error}")
            raise
    outcome = run.flows[name]
    if isinstance(outcome, Exception):
        raise Skip(f"the sign-in did not finish: {outcome}")
    return outcome


async def redeeming_origin(run):
    """The Origin of the connections that redeem codes: the server's own origin, or none if it refuses that."""
    if "origin" not in run.flows:
        conn = await open_from(run, origin_of(run))
        run.flows["origin"] = origin_of(run) if conn else None
    return run.flows["origin"]


async def attempt_auth(run, origin, params, conn=None):
    """Send auth with params on conn, or on a new connection from origin, and return the reply."""
    conn = conn or await open_from(run, origin)
    must(conn, f"the server refused the handshake of {from_origin(origin)}, which it took before")
    return (await conn.request("auth", params))[1]


async def chain(run, fresh, negatives, redeem):
    """Get codes from fresh(why): one that redeems, then codes for the negative tries, until each try has a
    conclusive answer. negatives are (key, attempt, optional).

    The first code redeems at once, as the sign-in that it ends may create the account, and tells whether
    redemptions work at all. A refusal proves something only on a code that was still usable: a fresh one, or one
    that a later right redemption redeems, since a failed redemption MAY use up the code (§4.12.4). So the second
    code takes every negative try, then the right redemption. If that fails, failed tries use up codes (burned), and
    each remaining try takes a fresh code, except optional ones, which a person's run leaves out to save a sign-in.
    Later flows start from what earlier ones learned."""
    person = run.person
    out = {"first": None, "negatives": {}, "skipped": {}, "redeemed": None, "reuse": None, "burned": None,
           "broken": False}
    grant = out["first"] = await fresh(None)
    reply = await redeem(grant)
    out["redeemed"] = (grant, reply)
    out["broken"] = not signed_in(reply)
    out["reuse"] = None if out["broken"] else await redeem(grant)
    if out["broken"] or not negatives:
        person.total -= 1  # the planned code for the tries that must fail (sign_ins)
        return out
    pending, again = list(negatives), "sign in to the same account as before"
    if run.args.portal:  # a portal's sign-ins cost no one's time
        pending = [(key, attempt, False) for key, attempt, _ in pending]
    required = lambda: sum(1 for _, _, optional in pending if not optional)
    if run.burned is True:
        person.total += required() - 1
    else:
        grant = await fresh(f"{again}, for the tries that must fail")
        tried = [(key, await attempt(grant)) for key, attempt, _ in pending]
        if signed_in(await redeem(grant)):
            out["negatives"].update(tried)
            if all("error" in r for _, r in tried):
                run.burned = out["burned"] = False
            return out
        out["negatives"][tried[0][0]] = tried[0][1]
        pending = pending[1:]
        run.burned = True
        person.total += required()
    out["burned"] = run.burned
    for key, attempt, optional in pending:
        if optional:
            out["skipped"][key] = "left out to save a sign-in, since a failed try uses up a code on this server"
            continue
        grant = await fresh(f"{again}. A failed try uses up a code here, so each try that must fail takes its own")
        out["negatives"][key] = await attempt(grant)
    return out


async def external_flow(run):
    page = (await external_page(run))["url"]
    origin = await redeeming_origin(run)
    redeem = lambda grant, **change: attempt_auth(run, origin, {"scheme": "external", **grant.redemption(**change)})
    negatives = [("code_verifier", lambda g: redeem(g, code_verifier=secrets.token_urlsafe(48)), False),
                 ("redirect_uri", lambda g: redeem(g, redirect_uri=run.person.other_redirect_uri), False),
                 ("client_id", lambda g: redeem(g, client_id=CLIENT_ID + "-other"), False)]
    try:
        await passkey_page(run)
        negatives.append(("webauthn", lambda g: attempt_auth(run, origin, {
            "scheme": "webauthn", "action": "login", "step": "finish", **g.redemption()}), False))
    except Skip:
        pass
    why = ("external sign-in. Checks the redirect, that the code redeems once and only with its code_verifier, "
           "redirect_uri, client_id, and scheme, and the token.")
    fresh = lambda again: sign_in(run, page, f"external sign-in again: {again}." if again else why)
    return {**await chain(run, fresh, negatives, redeem), "origin": origin}


async def passkey_flow(run):
    """The passkey page. The first code is a registration from a new connection, else one as a guest (an addition,
    whose code redeems only on the guest's connection), else a login. Later codes are logins, with the passkey that
    the first one made."""
    origin = await redeeming_origin(run)
    register = {"scheme": "webauthn", "action": "register", "step": "begin", "name": "Conformance"}

    async def begin_register(as_guest):
        conn = await open_from(run, origin)
        must(conn, f"the server refused the handshake of {from_origin(origin)}, which it took before")
        if as_guest and not signed_in(await attempt_auth(run, origin, {"scheme": "guest", "name": "Conformance"}, conn)):
            return None, None
        url = (await attempt_auth(run, origin, register, conn)).get("result", {}).get("external", {}).get("url")
        return url, conn

    page, conn = await begin_register(False)
    guest = False
    if not page and offers("guest")(run.server):
        page, conn = await begin_register(True)
        guest = bool(page)
    first = "register" if page else "login"
    why = ("passkey page: create a passkey, and allow." if page else
           "passkey page: sign in with a passkey that you have on this server, and allow.")
    why += " Checks the redirect, that the code redeems once and only for its scheme and action, and the token."

    async def fresh(again):
        if again:
            grant = await sign_in(run, (await passkey_page(run))["url"], f"passkey page again: {again}.",
                                  identity="passkey")
            grant.action = "login"
            return grant
        grant = await sign_in(run, page or (await passkey_page(run))["url"], why, keep=conn if guest else None,
                              identity="passkey")
        grant.action, grant.conn = first, conn if guest else None
        return grant

    other = lambda g: "login" if g.action == "register" else "register"
    params = lambda g, act=None, **change: {"scheme": "webauthn", "action": act or g.action, "step": "finish",
                                            **g.redemption(**change)}
    finish = lambda g, **change: attempt_auth(run, origin, params(g, **change), g.conn)
    negatives = [("external", lambda g: attempt_auth(run, origin, {"scheme": "external", **g.redemption()}, g.conn), False),
                 ("action", lambda g: attempt_auth(run, origin, params(g, other(g)), g.conn), False),
                 ("code_verifier", lambda g: finish(g, code_verifier=secrets.token_urlsafe(48)), True)]
    if oauth_needs(run.server):
        try:
            endpoint = await token_endpoint(run)

            async def at_token_endpoint(g):
                status, _, doc = await token_request(endpoint, {"grant_type": "authorization_code", **g.redemption()})
                return {"error": {"status": status, "body": doc}} if status != 200 else {"result": doc}
            negatives.append(("token endpoint", at_token_endpoint, True))
        except Skip:
            pass
    return {**await chain(run, fresh, negatives, finish), "action": first, "origin": origin, "guest": guest}


async def token_flow(run):
    """ext:oauth's token endpoint, with a code from the external page."""
    await own_issuer(run)
    endpoint = await token_endpoint(run)
    grant = await sign_in(run, (await external_page(run))["url"],
                          "external sign-in again, for ext:oauth's token endpoint. Checks HTTP Basic, and its token.")
    form = {"grant_type": "authorization_code", "resource": origin_of(run),
            **{k: v for k, v in grant.redemption().items() if k != "client_id"}}
    refused = await token_request(endpoint, {**form, "grant_type": "urn:conformance:unknown", "client_id": CLIENT_ID})
    redeemed = await token_request(endpoint, form, CLIENT_ID)
    reuse = await token_request(endpoint, form, CLIENT_ID)
    return {"refused": refused, "redeemed": redeemed, "reuse": reuse}


def redirect_checks(run, grant, issuer):
    query = grant.query
    must(query.get("state") == grant.state, f"the redirect's state is {query.get('state')!r}, not the request's")
    must("iss" in query, "the redirect has no iss")
    must(query["iss"] == issuer, f"the redirect's iss is {query['iss']!r}, not {issuer}")


def negative(out, key, what, offered=True):
    """The reply to a negative try, which must be denied, or unsupported for a scheme the server does not offer (§3.2)."""
    if key in out["skipped"]:
        raise Skip(out["skipped"][key])
    if key not in out["negatives"]:
        if out["broken"]:
            raise Skip("no code redeemed, so a refusal proves nothing")
        raise Skip("not tried")
    reply = out["negatives"][key]
    must(not signed_in(reply), f"{what} signed in")
    expect_error(reply, "denied" if offered else "unsupported", what)


def burn_note(run, out):
    if out["burned"] is not None:
        run.info("a failed try used up the code, which servers MAY do (§4.12.4)" if out["burned"] else
                 "a failed try left the code usable")


async def token_elsewhere(run, token, used=""):
    """The token signs in with scheme token on connections with no Origin or another Origin than used (§4.12.4)."""
    if "token" not in run.server.get("auth", []):
        raise Skip("the server does not offer token")
    tried = []
    for origin in (None, origin_of(run), FOREIGN):
        if origin == used:
            continue
        conn = await open_from(run, origin)
        if not conn:
            run.info(f"the server refused the handshake of {from_origin(origin)}: origin policy, not the token")
            continue
        _, reply = await conn.request("auth", {"scheme": "token", "token": token})
        must(signed_in(reply), f"the token on {from_origin(origin)}: {describe(reply)}")
        token = reply["result"].get("token", token)  # a server may rotate it (§3.2.1)
        tried.append(origin)
    if not tried:
        raise Skip("the server refused the handshake of every other Origin")


@check("external.shape.redirect", "4.12.3", "external sign-in: the page redirects with the request's state, and iss", needs=offers("external"))
async def _(run):
    out = await flow(run, "external", external_flow)
    redirect_checks(run, out["first"], (await external_page(run)).get("issuer", origin_of(run)))


@check("external.shape.redeem", "4.12.4", "external sign-in: a code signs in, with you and a token", needs=offers("external"))
async def _(run):
    out = await flow(run, "external", external_flow)
    grant, reply = out["redeemed"]
    must(signed_in(reply), f"a fresh code: {describe(reply)}")
    must(isinstance(reply["result"].get("token"), str), "the result has no token")


@check("external.A3.single-use", "4.12.3", "external sign-in: a code signs in once", needs=offers("external"))
async def _(run):
    out = await flow(run, "external", external_flow)
    if out["broken"]:
        raise Skip("no code redeemed, so a refusal proves nothing")
    must(not signed_in(out["reuse"]), "the code signed in again")
    expect_error(out["reuse"], "denied", "a used code")


@check("external.A3.verifier", "4.12.3", "external sign-in: a code redeems only with its code_verifier", needs=offers("external"))
async def _(run):
    out = await flow(run, "external", external_flow)
    burn_note(run, out)
    negative(out, "code_verifier", "a code with another code_verifier")


@check("external.A3.redirect-bound", "4.12.3", "external sign-in: a code redeems only with its redirect_uri", needs=offers("external"))
async def _(run):
    negative(await flow(run, "external", external_flow), "redirect_uri", "a code with another redirect_uri")


@check("external.A3.client-bound", "4.12.3", "external sign-in: a code redeems only with its client_id", needs=offers("external"))
async def _(run):
    negative(await flow(run, "external", external_flow), "client_id", "a code with another client_id")


@check("external.A3.scheme-bound", "4.10.1", "external sign-in: its code does not finish webauthn", needs=offers("external", "webauthn"))
async def _(run):
    negative(await flow(run, "external", external_flow), "webauthn", "an external code in a webauthn finish")


@check("external.shape.token-origin", "4.12.4", "external sign-in: the token works from a connection with another Origin", needs=offers("external"))
async def _(run):
    out = await flow(run, "external", external_flow)
    _, reply = out["redeemed"]
    if not isinstance(reply.get("result", {}).get("token"), str):
        raise Skip("no token")
    await token_elsewhere(run, reply["result"]["token"], out["origin"])


async def identities_flow(run):
    """Codes for other identities, redeemed on a connection that is signed in (§4.12.4): a new identity, which adds
    to the account, and one that another account has, which is denied. The portal, or the person, signs in as the
    identity that each sign-in names."""
    page = (await external_page(run))["url"]
    origin = await redeeming_origin(run)
    redeem = lambda grant, conn=None: attempt_auth(run, origin, {"scheme": "external", **grant.redemption()}, conn)
    out = {}
    tag = secrets.token_hex(3)  # identities that are new on a server that outlives runs
    conn = await open_from(run, origin)
    must(conn, f"the server refused the handshake of {from_origin(origin)}, which it took before")
    grant = await sign_in(run, page, "external sign-in again, to the same account as before, on a connection that "
                                     "then redeems codes for other identities.", keep=conn)
    reply = await redeem(grant, conn)
    if not signed_in(reply):
        raise Skip(f"a code for the first identity did not sign in: {describe(reply)}")
    out["account"] = reply["result"]["you"]["user_id"]
    grant = await sign_in(run, page, "external sign-in with a new identity, which no account has yet, such as another "
                                     "subject or a new passkey. Checks that it adds to the account.",
                          keep=conn, identity=f"addition-{tag}")
    out["addition"] = await redeem(grant, conn)
    if code(out["addition"]) == CODES["denied"] and offers("webauthn")(run.server):
        # Such as a limit of one external identity per account: try an account that signed in with a passkey.
        try:
            passkey = await ceremony(run)
            if signed_in(passkey["login"]):
                other, begin, credential = await login(run, passkey["key"])
                _, reply = await other.request("auth", finish("login", begin, credential))
                if signed_in(reply):
                    grant = await sign_in(run, page, "external sign-in with another new identity, for an account that "
                                                     "signed in with a passkey.", keep=other,
                                          identity=f"addition-passkey-{tag}")
                    out["passkey-account"] = reply["result"]["you"]["user_id"]
                    out["passkey-addition"] = await redeem(grant, other)
        except Skip:
            pass
    grant = await sign_in(run, page, "external sign-in with another new identity, to make a second account.",
                          keep=conn, identity=f"other-{tag}")
    other = await redeem(grant)
    out["other"] = other
    if signed_in(other) and other["result"]["you"]["user_id"] != out["account"]:
        grant = await sign_in(run, page, "external sign-in again, as the second account. Checks that it does not "
                                         "switch the first account's connection.", keep=conn, identity=f"other-{tag}")
        out["switch"] = await redeem(grant, conn)
        _, out["after"] = await conn.request("me", {})
    return out


@check("external.A4.addition", "4.12.4", "external sign-in: on a signed-in connection, a code for a new identity adds "
       "it to the account, and returns you", needs=offers("external"))
async def _(run):
    out = await flow(run, "identities", identities_flow)
    reply = out["addition"]
    policy(reply)
    if code(reply) == CODES["denied"] and "passkey-addition" in out:
        run.info(f"the server refused it for the account that signed in by external: {describe(reply)}; tried an "
                 "account that signed in with a passkey instead")
        reply, out = out["passkey-addition"], {**out, "account": out["passkey-account"]}
        policy(reply)
    if code(reply) == CODES["denied"]:
        # Server policy, such as a limit of identities per account (§1.1), or a page that made the new identity an
        # account of its own before the redemption: neither breaks a rule, and conform.py cannot tell them apart.
        raise Skip(f"the server refused the addition, which its policy may do: {describe(reply)}")
    must(signed_in(reply), f"a code for a new identity, on a connection signed in to {out['account']}: {describe(reply)}")
    you = reply["result"]["you"]["user_id"]
    must(you == out["account"], f"it returned {you}, not the account {out['account']} that the connection is signed in to")


@check("external.A4.no-switch", "4.12.4", "external sign-in: on a signed-in connection, a code for another account's "
       "identity is denied", needs=offers("external"))
async def _(run):
    out = await flow(run, "identities", identities_flow)
    other = out["other"]
    policy(other)
    if not signed_in(other):
        raise Skip(f"a code for a new identity on a new connection made no account: {describe(other)}")
    if other["result"]["you"]["user_id"] == out["account"]:
        raise Skip(f"the page gave the second identity the first account, {out['account']}, so there is no second "
                   "account: the portal or the person could not sign in as someone else")
    reply = out["switch"]
    must(not signed_in(reply), f"it switched the connection to {reply.get('result', {}).get('you', {}).get('user_id')}")
    expect_error(reply, "denied", "a code for another account's identity")
    after = out["after"]
    must(after.get("result", {}).get("you", {}).get("user_id") == out["account"],
         f"me after it got {describe(after)}, not the first account")


@check("oauth.shape.token-basic", "ext:oauth", "the token endpoint redeems a code by HTTP Basic, after a request that it refused",
       needs=oauth_needs)
async def _(run):
    out = await flow(run, "token", token_flow)
    status, _, doc = out["refused"]
    must(status >= 400, f"an unknown grant_type got HTTP {status}")
    should((doc or {}).get("error") == "unsupported_grant_type",
           f"an unknown grant_type got {json.dumps(doc)}, not unsupported_grant_type (RFC 6749 §5.2)")
    status, _, doc = out["redeemed"]
    must(status == 200 and isinstance((doc or {}).get("access_token"), str),
         f"HTTP {status}, {json.dumps(doc)}: either the refused request used up the code, or HTTP Basic with an "
         "empty password is not accepted")
    must(str(doc.get("token_type", "")).lower() == "bearer", f"token_type is {doc.get('token_type')!r}")


@check("oauth.shape.token-endpoint", "ext:oauth", "the token endpoint redeems a code once, and its access token works with scheme token",
       needs=oauth_needs)
async def _(run):
    out = await flow(run, "token", token_flow)
    status, _, doc = out["redeemed"]
    if status != 200 or not isinstance((doc or {}).get("access_token"), str):
        raise Skip("no access token")
    reuse_status, _, reuse = out["reuse"]
    must(reuse_status == 400 and (reuse or {}).get("error") == "invalid_grant",
         f"a used code got HTTP {reuse_status}, {json.dumps(reuse)}")
    await token_elsewhere(run, doc["access_token"])


@check("webauthn.shape.page-redirect", "4.10.1", "passkey page: the page redirects with the request's state, and iss", needs=offers("webauthn"))
async def _(run):
    await passkey_page(run)
    out = await flow(run, "passkey", passkey_flow)
    redirect_checks(run, out["first"], origin_of(run))


@check("webauthn.shape.page-redeem", "4.10.1", "passkey page: a code finishes webauthn, with you", needs=offers("webauthn"))
async def _(run):
    await passkey_page(run)
    out = await flow(run, "passkey", passkey_flow)
    run.info(f"the person used {'a registration' if out['action'] == 'register' else 'a login'}"
             + (", as a guest, redeemed on that connection" if out["guest"] else ""))
    _, reply = out["redeemed"]
    must(signed_in(reply), f"a fresh code: {describe(reply)}")
    if "token" not in reply["result"]:
        run.info("the result has no token, which a finish MAY leave out")


@check("webauthn.A3.page-single-use", "4.12.3", "passkey page: a code finishes webauthn once", needs=offers("webauthn"))
async def _(run):
    await passkey_page(run)
    out = await flow(run, "passkey", passkey_flow)
    if out["broken"]:
        raise Skip("no code redeemed, so a refusal proves nothing")
    must(not signed_in(out["reuse"]), "the code finished again")
    expect_error(out["reuse"], "denied", "a used code")


@check("webauthn.A3.page-scheme-bound", "4.10.1", "passkey page: its code finishes neither external nor the other action", needs=offers("webauthn"))
async def _(run):
    await passkey_page(run)
    out = await flow(run, "passkey", passkey_flow)
    negative(out, "external", "a passkey page code in an external redemption",
             offered="external" in run.server.get("auth", []) + run.server.get("signup", []))
    negative(out, "action", "a passkey page code in a finish with the other action")


@check("webauthn.A3.page-verifier", "4.12.3", "passkey page: a code redeems only with its code_verifier", needs=offers("webauthn"))
async def _(run):
    await passkey_page(run)
    out = await flow(run, "passkey", passkey_flow)
    burn_note(run, out)
    negative(out, "code_verifier", "a code with another code_verifier")


@check("oauth.A3.passkey-code", "ext:oauth", "the token endpoint does not redeem a passkey page code",
       needs=lambda s: oauth_needs(s) and offers("webauthn")(s))
async def _(run):
    await passkey_page(run)
    out = await flow(run, "passkey", passkey_flow)
    if "token endpoint" not in out["negatives"]:
        raise Skip(out["skipped"].get("token endpoint")
                   or ("no code redeemed, so a refusal proves nothing" if out["broken"] else "not tried"))
    must("error" in out["negatives"]["token endpoint"],
         f"it returned {json.dumps(out['negatives']['token endpoint'].get('result'))[:120]}")


@check("webauthn.shape.page-token-origin", "4.10.1", "passkey page: the token works from a connection with another Origin", needs=offers("webauthn"))
async def _(run):
    await passkey_page(run)
    out = await flow(run, "passkey", passkey_flow)
    _, reply = out["redeemed"]
    if not isinstance(reply.get("result", {}).get("token"), str):
        raise Skip("the finish returned no token")
    await token_elsewhere(run, reply["result"]["token"], out["origin"])


@check("external.shape.declined", "4.12.3", "a sign-in that the person declines redirects with error=access_denied",
       needs=lambda s: offers("external")(s) or offers("webauthn")(s), schemes={"external", "webauthn"})
async def _(run):
    if run.person is None:
        raise Skip("needs a person to sign in: run with --sign-in")
    kind = "external" if offers("external")(run.server) and run.profile("external") else "passkey"
    page = await page_of(run, kind)
    grant = await sign_in(run, page, f"{PAGES[kind][0]}, to decline. Checks error=access_denied.", decline=True)
    must(grant.query.get("state") == grant.state, f"the redirect's state is {grant.query.get('state')!r}, not the request's")
    must("code" not in grant.query, "the redirect has a code")
    must(grant.query.get("error") == "access_denied", f"the redirect has error {grant.query.get('error')!r}")


# Rules that a machine cannot check: a person checks them, on the page or in the email.

def try_page(kind):
    def how(run):
        _, request, _, _ = run.pages.get(kind, (None, None, None, None))
        return ("open a sign-in, such as " + request.url if request else "open a sign-in") + ", and check it"
    return how


manual("external.A2.consent", "4.12.3", "the external sign-in page shows the server, and the host or scheme of "
       "redirect_uri, before it redirects", needs=offers("external"), how=try_page("external"))
manual("webauthn.A2.page-consent", "4.12.3", "the passkey page shows the server, and the host or scheme of "
       "redirect_uri, before it redirects", needs=offers("webauthn"), how=try_page("passkey"))
manual("external.A2.confirm-signed-in", "5.2", "the sign-in page confirms before it redirects, also when the user is "
       "already signed in there", needs=lambda s: offers("external")(s) or offers("webauthn")(s),
       schemes={"external", "webauthn"}, how="sign in once, then open a new sign-in in the same browser: the page asks again before it redirects")
manual("external.A2.allowed-once", "4.12.3", "the sign-in page keeps a user's choice only for an exact https "
       "redirect_uri, and asks again at each sign-in for an app's scheme or a loopback redirect_uri",
       needs=lambda s: offers("external")(s) or offers("webauthn")(s),
       schemes={"external", "webauthn"}, how="allow a loopback redirect_uri, then sign in again with the same one: the page asks again")
manual("external.A2.client-named", "5.2", "the sign-in page names the client by the host of redirect_uri, marks "
       "clients that the server does not know, and says that the client will act as the user",
       needs=lambda s: offers("external")(s) or offers("webauthn")(s),
       schemes={"external", "webauthn"}, how="guidance (§5.2), not a rule: check that a user can recognize the client and refuse one they do not know")
manual("webauthn.A4.page-addition-account", "4.10.1", "for an addition, the passkey page shows the account before it "
       "creates the passkey", needs=offers("webauthn"),
       how="on a connection signed in to an account, register a passkey through the page: it shows the account first")
manual("email.A1.code-names-server", "4.11.2", "an email with a code gives the server's address, and tells the user to "
       "type the code only in a client that is connected to that server", needs=offers("email"),
       how="propose a sign-in to an address that you read, and check the email")


# Rules checked on every frame along the way.

def seen(key):
    async def fn(run):
        found = sorted(run.violations.get(key, []))
        must(not found, "; ".join(found[:3]) + (f" (+{len(found) - 3} more)" if len(found) > 3 else ""))
    return fn


check("core.shape.schema", "1", "every frame matches schema/apron.schema.json")(seen("schema"))
check("core.shape.one-reply", "1.1", "every request gets exactly one reply")(seen("replies"))
check("core.shape.ids", "2", "IDs are well formed")(seen("ids"))
check("core.delivery.order", "3.5.3", "each room's snapshots arrive in ascending log_id")(seen("order"))
check("history.shape.room-records", "4.3.3", "listed room records carry log_id, latest_log_id, and history_log_id", needs="history")(seen("listed-rooms"))
check("status.seen.offline", "4.5.2", "seen stays the same while the shown status stays offline, and arrives where it must", needs="status")(seen("shown-seen"))


STATUSES = ("PASS", "FAIL", "WARN", "SKIP", "MANUAL")


async def run_check(run, item):
    """Run one check, and return (status, detail)."""
    try:
        if run.server is None and item is not CHECKS[0]:
            raise Skip("no server frame")
        if isinstance(item.needs, str) and not run.has(item.needs):
            raise Skip(f"no capability {item.needs}")
        if callable(item.needs) and not item.needs(run.server):
            raise Skip("not advertised")
        await item.fn(run)
        return "PASS", ""
    except Fail as e:
        return "FAIL", str(e)
    except Warn as e:
        return "WARN", str(e)
    except Skip as e:
        return "SKIP", str(e)
    except Manual as e:
        return "MANUAL", str(e)
    except Exception as e:  # a crash in a check is the server's failure to answer as expected
        if run.args.verbose:
            traceback.print_exc()
        return "FAIL", f"{type(e).__name__}: {e}"
    finally:
        for conn in run.conns:
            await conn.ws.close()
        run.conns.clear()


def selected(args, item):
    if args.scheme and item.schemes and not item.schemes & set(args.scheme):
        return False
    return not args.only or any(fnmatch.fnmatchcase(item.id, pattern) for pattern in args.only)


async def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("url", nargs="?", help="WebSocket URL, such as ws://127.0.0.1:8765")
    parser.add_argument("--token", help="sign in with scheme token instead of guest")
    parser.add_argument("--sign-in", action="store_true",
                        help="also run the checks that need someone to sign in on the server's pages")
    parser.add_argument("--portal", metavar="COMMAND",
                        help="with --sign-in, run COMMAND to sign in on each page instead of a person, such as "
                             "'node tests/conformance/portals/passkey.cjs'")
    parser.add_argument("--origin", metavar="ORIGIN",
                        help="the Origin of a WebAuthn ceremony in the client (default: the server's own origin)")
    parser.add_argument("--json", metavar="PATH", help="write the results to PATH as JSON")
    parser.add_argument("--only", metavar="PATTERN", action="append",
                        help="run only the checks whose ID matches this glob, such as 'external.A3.*'; repeatable")
    parser.add_argument("--scheme", metavar="NAME", action="append", choices=sorted(KNOWN["auth scheme"]),
                        help="run only this sign-in scheme's profile, and the core checks; repeatable")
    parser.add_argument("--list", action="store_true", help="list the checks, and exit")
    parser.add_argument("-v", "--verbose", action="store_true", help="print tracebacks of crashed checks")
    args = parser.parse_args()
    if args.list:
        for item in CHECKS:
            if selected(args, item):
                print(f"{item.id:<36} {('§' if item.ref[:1].isdigit() else '') + item.ref:<9} {item.title}")
        return 0
    if not args.url:
        parser.error("the url is required")
    args.sign_in = args.sign_in or bool(args.portal)
    run, counts, results = Run(args), dict.fromkeys(STATUSES, 0), []
    started = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    if not run.schema.schema:
        print(f"note: {SCHEMA_PATH} not found; frames are not validated against the schema")
    chosen = [item for item in CHECKS if selected(args, item)]
    if not chosen:
        parser.error("no check matches --only and --scheme")
    last = CHECKS.index(chosen[-1])
    for index, item in enumerate(CHECKS):
        if item not in chosen:
            if not item.setup or index > last:
                continue
            status, detail = await run_check(run, item)  # learns what later checks use, such as the default room
            if status != "FAIL":  # a failure, such as no server frame, is reported all the same
                run.notes.clear()
                continue
        else:
            status, detail = await run_check(run, item)
        counts[status] += 1
        label = f"§{item.ref}" if item.ref[:1].isdigit() else item.ref
        print(f"{status:<6} {item.id:<36} {label:<9} {item.title}" + (f": {detail}" if detail else ""), flush=True)
        for note in run.notes:
            print(f"       note: {note}", flush=True)
        results.append({"id": item.id, "section": item.ref, "status": status,
                        "message": item.title + (f": {detail}" if detail else ""), "notes": list(run.notes)})
        run.notes.clear()
    if run.server:
        print(f"{run.server.get('agent', 'server')}: {', '.join(run.server.get('capabilities', [])) or 'core only'}")
    checklist = [r for r in results if r["status"] == "MANUAL"]
    if checklist:
        print("For a person to check:")
        for r in checklist:
            item = next(c for c in CHECKS if c.id == r["id"])
            print(f"  [ ] {item.id}: {item.title}")
    print(", ".join(f"{counts[s]} {s.lower()}" for s in STATUSES))
    if run.person:
        shutil.rmtree(run.person.state, ignore_errors=True)
    if args.json:
        report = {"tool": "conform.py", "version": VERSION, "target": args.url, "started": started,
                  "results": results, "summary": counts}
        Path(args.json).write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n")
    return 1 if counts["FAIL"] else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
