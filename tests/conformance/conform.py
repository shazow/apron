#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = ["websockets>=14,<17", "jsonschema>=4.18"]
# ///
"""Check a running Apron server against PROTOCOL.md.

Connects to a WebSocket URL, runs the core checklist (§3.6) and checks for each
capability that the server advertises, and prints one line per check: PASS,
FAIL (a rule the server breaks), WARN (a SHOULD it does not follow), or SKIP.
Every server frame is also validated against schema/apron.schema.json. Exits 1
if any check fails.

It signs in as a guest, or with --token. Guests are created and messages
posted, so point it at a test server. Not covered: passkey, email, and external
sign-in, push registration, token rotation, compaction, and redaction.

Run from the repository root:
  uv run tests/conformance/conform.py ws://127.0.0.1:8765
  uv run tests/conformance/conform.py wss://chat.example/ws --token SECRET
"""

import argparse
import asyncio
import itertools
import json
import re
import sys
import time
import traceback
import urllib.request
from pathlib import Path

from jsonschema import Draft202012Validator
from websockets.asyncio.client import connect
from websockets.exceptions import ConnectionClosed

VERSION = 9
WAIT = 2.0  # seconds to wait for an expected frame
QUIET = 0.5  # seconds to wait for a frame that should not come
MISSING = "9007199254740991"  # a log_id no test server has reached (2^53 - 1)
CODES = {"parse_error": -32700, "invalid_request": -32600, "unsupported": -32601,
         "invalid_params": -32602, "internal_error": -32603, "denied": -32001,
         "retry_after": -32002, "too_large": -32003}
KNOWN = {
    "capability": {"command", "history", "rooms", "edit", "status", "activity", "reactions",
                   "embed:upload", "embed:stream", "ext"},
    "auth scheme": {"guest", "token", "webauthn", "email", "external"},
}
SCHEMA_PATH = Path(__file__).resolve().parents[2] / "schema/apron.schema.json"
ids = (f"conf{n}" for n in itertools.count(1))


class Fail(Exception): pass
class Warn(Exception): pass
class Skip(Exception): pass


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


class Conn:
    """One WebSocket connection: frames in arrival order, and replies matched by id."""

    def __init__(self, run, ws):
        self.run, self.ws = run, ws
        self.frames, self.closed, self.you = [], False, None
        self.methods = {}  # request id -> method
        self.asked, self.answered = {}, {}
        self.changed = asyncio.Condition()
        self.reader = asyncio.create_task(self.read())

    async def read(self):
        try:
            async for raw in self.ws:
                try:
                    frame = json.loads(raw)
                except ValueError:
                    frame = None
                self.run.inspect(self, frame, raw)
                async with self.changed:
                    self.frames.append(frame)
                    self.changed.notify_all()
        except ConnectionClosed:
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

    def violate(self, key, text):
        self.violations.setdefault(key, set()).add(text)

    def has(self, capability):
        return capability in self.server.get("capabilities", [])

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
        """Delivery fields (§4.2) are on room_list and room_update records, and not on history records."""
        result, params = frame.get("result", {}), frame.get("params", {})
        rooms = []
        if isinstance(result, dict):
            rooms += result.get("joined", []) + result.get("not_joined", [])
        if frame.get("method") == "room_update" and isinstance(params, dict):
            rooms += params.get("joined", []) + params.get("updated", [])
        for room in rooms:
            missing = [k for k in ("log_id", "latest_log_id", "history_log_id") if k not in room]
            if isinstance(room, dict) and missing:
                self.violate("history-rooms", f"room {room.get('room_id')} lacks {', '.join(missing)}")
        logged = result.get("rooms", []) if isinstance(result, dict) and "more" in result else []
        for room in logged:
            extra = [k for k in ("latest_log_id", "history_log_id", "members", "member_count") if k in room]
            if isinstance(room, dict) and extra:
                self.violate("history-rooms", f"history room {room.get('room_id')} carries {', '.join(extra)}")

    async def open(self, auth=True, name="Conformance"):
        """Open a connection, wait for its server frame, and sign in."""
        for attempt in itertools.count():
            try:
                ws = await connect(self.args.url, max_size=None, open_timeout=WAIT)
                break
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

    async def joined(self, name="Conformance"):
        """Open a signed-in connection that receives the deliveries of the default room."""
        if not self.room:
            raise Skip("the default room is unknown")
        conn = await self.open(name=name)
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


def check(ref, title, needs=None):
    def wrap(fn):
        CHECKS.append((ref, title, needs, fn))
        return fn
    return wrap


# §3.6 core checklist, with the rules of §1 and §2 it points to.

@check("3.1", "sends a server frame on connect")
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


@check("3.2.2", "requests before auth get error/denied")
async def _(run):
    conn = await run.open(auth=False)
    expect_error((await conn.request("me", {}))[1], "denied", "me before auth")


@check("1", "ping before auth gets pong", needs=lambda s: "ping" in s)
async def _(run):
    conn = await run.open(auth=False)
    await conn.notify("ping")
    must((await conn.wait(lambda f: f == {"method": "pong"}))[1], "no exact {\"method\":\"pong\"}")


@check("3.2", "auth replies with you")
async def _(run):
    conn = await run.open(auth=False)
    you = (await conn.call("auth", run.auth("Conformance"))).get("you")
    must(isinstance(you, dict) and isinstance(you.get("user_id"), str), "result has no you.user_id")


@check("3.2.2", "auth finishes before later frames")
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


@check("1", "an unknown auth scheme is error/invalid_params, or accepted as a guest")
async def _(run):
    conn = await run.open(auth=False)
    reply = (await conn.request("auth", {"scheme": "ext:conformance-unknown"}))[1]
    must("result" in reply or code(reply) == CODES["invalid_params"], f"got {describe(reply)}")


@check("3.2", "a defined scheme the server does not offer is error/unsupported")
async def _(run):
    offered = run.server.get("auth", []) + run.server.get("signup", [])
    params = {"webauthn": {"action": "login", "step": "begin"}, "email": {"email": "conformance@example.invalid"},
              "external": {"return_url": "https://example.invalid/"}}
    scheme = next((s for s in params if s not in offered), None)
    if not scheme:
        raise Skip("the server offers webauthn, email, and external")
    conn = await run.open(auth=False)
    expect_error((await conn.request("auth", {"scheme": scheme, **params[scheme]}))[1], "unsupported", f"auth {scheme}")


@check("3.6.3", "accepts message without room_id into its default room")
async def _(run):
    conn = await run.open()
    i, reply = await conn.request("message", {"body": {"text": "conformance: default room"}})
    must("result" in reply and isinstance(reply["result"].get("message_id"), str), f"got {describe(reply)}")
    message_id = reply["result"]["message_id"]
    _, snapshot = await conn.wait(snapshot_of(message_id))
    if snapshot:
        must(isinstance(snapshot["params"].get("room_id"), str), "the snapshot has no room_id")
        run.room = snapshot["params"]["room_id"]
    elif run.has("history"):
        page = await conn.call("history", {"after": message_id, "before": message_id})
        run.room = next((m.get("room_id") for m in page.get("messages", []) if m.get("message_id") == message_id), None)
    must(run.room or run.has("rooms"), "no broadcast to the poster")
    if not run.room:
        raise Warn("the poster got no broadcast and the room is unknown; later checks skip")


@check("3.6.4", "message creation replies with message_id and broadcasts the snapshot first")
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


@check("3.5.1", "a message with no text and no embeds is not logged")
async def _(run):
    a, b = await run.joined(), await run.joined()
    start = len(b.frames)
    result = await a.call("message", {"room_id": run.room, "body": {"text": ""}})
    await asyncio.sleep(QUIET)
    should(result == {}, f"result is {json.dumps(result)}")
    should(not b.since(start, lambda f: f.get("method") == "message"), "it was broadcast")


@check("3.5.4", "reply_to must refer to an existing message")
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


@check("3.6.5", "unknown requests are error/unsupported")
async def _(run):
    conn = await run.open()
    expect_error((await conn.request("ext:conformance-unknown", {}))[1], "unsupported", "unknown method")


@check("3.6.5", "message with message_id is error/unsupported without edit", needs=lambda s: "edit" not in s.get("capabilities", []))
async def _(run):
    if not run.message:
        raise Skip("no message to save")
    conn = await run.joined()
    reply = (await conn.request("message", {"message_id": run.message["message_id"], "room_id": run.room,
                                            "body": {"text": "conformance: edited"}}))[1]
    expect_error(reply, "unsupported", "a save")


@check("3.6.5", "unknown notifications are ignored")
async def _(run):
    conn = await run.open()
    start = len(conn.frames)
    await conn.notify("ext:conformance-unknown", {"x": 1})
    if not run.has("activity"):  # defined, but unknown to this server
        await conn.notify("activity", {"room_id": run.room or "general", "typing": 5})
    await conn.sync()
    errors = conn.since(start, lambda f: "error" in f and "id" not in f)
    must(not errors, errors and f"got {describe(errors[0])}")


@check("1", "unknown keys are ignored")
async def _(run):
    conn = await run.joined()
    reply = (await conn.request("message", {"room_id": run.room, "conformance_unknown": True,
                                            "body": {"text": "conformance: unknown keys", "conformance_unknown": 1}}))[1]
    must("result" in reply, describe(reply))


@check("1.1", "a request for a room that does not exist is error/invalid_params")
async def _(run):
    conn = await run.open()
    reply = (await conn.request("message", {"room_id": "conformance-no-such-room", "body": {"text": "x"}}))[1]
    expect_error(reply, "invalid_params", "posting to an unknown room")


@check("1", "frames up to 256 KiB are accepted")
async def _(run):
    conn = await run.joined()
    try:
        _, reply = await conn.request("message", {"room_id": run.room, "body": {"text": "x" * 250_000}})
    except Fail as error:
        raise Warn(str(error)) from None
    should("result" in reply, f"a 250 kB message: {describe(reply)}")


@check("1.2", "retries are deduplicated by (user_id, id)")
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


@check("3.3.2", "me returns the user's complete object")
async def _(run):
    conn = await run.open()
    you = (await conn.call("me", {"name": "Conformance Renamed"})).get("you", {})
    must(you.get("user_id") == conn.you["user_id"], "you.user_id changed")


# §4 capabilities

@check("4.3", "history without room_id pages the default room", needs="history")
async def _(run):
    conn = await run.open()
    page = await conn.call("history", {})
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


@check("4.3.2", "after and before are inclusive bounds", needs="history")
async def _(run):
    if not run.message:
        raise Skip("no message")
    conn = await run.open()
    log_id = run.message["log_id"]
    page = await conn.call("history", {"room_id": run.room, "after": log_id, "before": log_id})
    must([m.get("log_id") for m in page.get("messages", [])] == [log_id], "the slice is not the one record")
    must(page.get("first_log_id") == log_id == page.get("last_log_id"), "first_log_id and last_log_id are not the record")


@check("4.3.2", "limit takes the oldest with after and the newest without", needs="history")
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


@check("4.3.2", "an empty slice has more: false and no bounds", needs="history")
async def _(run):
    conn = await run.open()
    page = await conn.call("history", {"after": MISSING})
    must(page.get("more") is False, "more is not false")
    must("first_log_id" not in page and "last_log_id" not in page, "the result has bounds")


@check("4.4", "a save is a new snapshot at a later log_id", needs="edit")
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


@check("4.4", "delete is a tombstone without body or ext", needs="edit")
async def _(run):
    a, b = await run.joined(), await run.joined()
    _, message_id = await run.post(a, "conformance: delete me")
    start = (await b.expect(snapshot_of(message_id), "no broadcast to another member"))[0] + 1
    await a.call("message", {"message_id": message_id, "room_id": run.room, "deleted": True})
    _, tomb = await b.wait(snapshot_of(message_id), start)
    must(tomb, "no tombstone")
    must(tomb["params"].get("deleted") is True, "deleted is not true")
    must("body" not in tomb["params"] and "ext" not in tomb["params"], "the tombstone has body or ext")


@check("4.4", "deleted: true on creation is error/invalid_params", needs="edit")
async def _(run):
    conn = await run.joined()
    reply = (await conn.request("message", {"room_id": run.room, "body": {"text": "x"}, "deleted": True}))[1]
    expect_error(reply, "invalid_params", "creating a deleted message")


@check("4.4", "saving an unknown message is error/invalid_params", needs="edit")
async def _(run):
    conn = await run.joined()
    reply = (await conn.request("message", {"message_id": MISSING, "room_id": run.room, "body": {"text": "x"}}))[1]
    expect_error(reply, "invalid_params", "saving an unknown message")


@check("4.2.1", "room_list returns the arrays its filter asks for", needs="rooms")
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


@check("4.2.4", "room_set creates a room, joins the creator, and edits it", needs="rooms")
async def _(run):
    conn = await run.open()
    start = len(conn.frames)
    i, reply = await conn.request("room_set", {"title": "Conformance"})
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


@check("4.2.2", "room_join and room_leave update the user and the room", needs="rooms")
async def _(run):
    room_id = getattr(run, "new_room", None)
    if not room_id:
        raise Skip("no room was created")
    a = await run.open()
    await a.call("room_join", {"room_id": room_id})
    b = await run.open()
    a_start, b_start = len(a.frames), len(b.frames)
    i, reply = await b.request("room_join", {"room_id": room_id})
    must(reply.get("result") == {}, f"room_join got {describe(reply)}")
    j, update = await b.wait(room_update("joined", room_id), b_start)
    must(update and j < i, "no room_update joined before the result")
    _, membership = await a.wait(room_update("memberships", room_id), a_start)
    should(membership, "another member got no membership record")
    b_start = len(b.frames)
    i, reply = await b.request("room_leave", {"room_id": room_id})
    must(reply.get("result") == {}, f"room_leave got {describe(reply)}")
    j, update = await b.wait(room_update("left", room_id), b_start)
    must(update and j < i, "no room_update left before the result")


@check("4.2.3", "a room that a sign-in joins arrives in room_update joined, after the auth result", needs="rooms")
async def _(run):
    conn = await run.open()
    you = conn.you["user_id"]
    await conn.sync()
    after = next(i for i, f in enumerate(conn.frames) if isinstance(f, dict) and "result" in f and "you" in f["result"])
    updates = conn.since(0, lambda f: f.get("method") == "room_update")
    rooms = {m["room_id"] for f in updates for m in f["params"].get("memberships", [])
             if any(e.get("user", {}).get("user_id") == you and e.get("joined") for e in m.get("members", []))}
    if not rooms:
        raise Skip("the sign-in joined no room")
    listed = {r["room_id"] for f in conn.since(after + 1, lambda f: f.get("method") == "room_update")
              for r in f["params"].get("joined", [])}
    must(rooms <= listed, f"no joined after the auth result for {', '.join(sorted(rooms - listed))}")


@check("4.2.2", "joining an unknown room is error/invalid_params", needs="rooms")
async def _(run):
    conn = await run.open()
    expect_error((await conn.request("room_join", {"room_id": "conformance-no-such-room"}))[1], "invalid_params", "room_join")


@check("4.2.4", "a private room is kept private or refused as error/unsupported", needs="rooms")
async def _(run):
    a = await run.open()
    start = len(a.frames)
    _, reply = await a.request("room_set", {"title": "Conformance private", "private": True})
    if code(reply) == CODES["unsupported"]:
        return
    must("result" in reply, f"got {describe(reply)}")
    room_id = reply["result"]["room_id"]
    _, update = await a.wait(room_update("joined", room_id), start)
    must(update and records(update, "joined", room_id)[0].get("private") is True, "joined lacks private: true")
    b = await run.open()
    listing = await b.call("room_list", {"filter": "not_joined"})
    must(all(r.get("room_id") != room_id for r in listing.get("not_joined", [])), "a non-member sees it")


@check("4.7", "reactions are logged and broadcast before the result", needs="reactions")
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


@check("4.6", "activity is a notification and gets no reply", needs="activity")
async def _(run):
    conn = await run.joined()
    start = len(conn.frames)
    await conn.notify("activity", {"room_id": run.room, "typing": 5})
    await conn.notify("activity", {"room_id": run.room, "typing": 0})
    await conn.sync()
    must(not conn.since(start, lambda f: "error" in f and "id" not in f), "activity got an error")


@check("4.5.3", "status reports idle, and sends mutes to the user's connections", needs="status")
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


@check("4.5.1", "me sets a listed status", needs=lambda s: "status" in s.get("capabilities", []) and s.get("status"))
async def _(run):
    conn = await run.open()
    value = run.server["status"][0]
    you = (await conn.call("me", {"status": value})).get("you", {})
    must(you.get("status") == value, f"you.status is {you.get('status')!r}, not {value!r}")
    await conn.call("me", {"status": "online"})


@check("4.1", "/help replies with a ~private notice", needs="command")
async def _(run):
    conn = await run.joined()
    start = len(conn.frames)
    i, reply = await conn.request("command", {"room_id": run.room, "body": {"text": "/help"}})
    must("result" in reply and "message_id" not in reply["result"], f"got {describe(reply)}")
    j, notice = await conn.wait(lambda f: f.get("method") == "message" and f["params"].get("from", {}).get("user_id") == "~private", start)
    should(notice and j < i, "no ~private notice before the result")
    must("message_id" not in notice["params"], "the notice has a message_id")


@check("4.1", "a command with message_id is error/invalid_params", needs="command")
async def _(run):
    conn = await run.joined()
    reply = (await conn.request("command", {"room_id": run.room, "message_id": MISSING, "body": {"text": "/help"}}))[1]
    expect_error(reply, "invalid_params", "command with message_id")


@check("4.12", "me merges ext one level deep", needs="ext")
async def _(run):
    conn = await run.open()
    ext = lambda params: conn.call("me", params)
    you = (await ext({"ext": {"conformance": {"a": 1}}}))["you"]
    must(you.get("ext", {}).get("conformance") == {"a": 1}, "ext.conformance was not kept")
    you = (await ext({"ext": {"conformance2": "x"}}))["you"]
    must(you.get("ext", {}).get("conformance") == {"a": 1}, "a write of another key dropped ext.conformance")
    you = (await ext({"ext": {"conformance": "", "conformance2": ""}}))["you"]
    must("conformance" not in you.get("ext", {}), "an empty value did not clear the key")


@check("4.12", "messages keep ext, and saves merge it", needs="ext")
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


async def write(conn, run, embed, body):
    """Post one embed, PUT body to its write_url, and return (embed as broadcast, embed when done)."""
    i, reply = await conn.request("message", {"room_id": run.room, "body": {"text": "conformance: embed", "embeds": [embed]}})
    result = reply.get("result", {})
    must(result.get("message_id") and len(result.get("embeds", [])) == 1, f"got {describe(reply)}")
    written = result["embeds"][0]
    must(written.get("embed_id") and written.get("write_url"), "the result embed lacks embed_id or write_url")
    _, first = await conn.wait(snapshot_of(result["message_id"]))
    must(first, "no broadcast")
    start = len(conn.frames)
    put = urllib.request.Request(written["write_url"], data=body, method="PUT")
    await asyncio.to_thread(lambda: urllib.request.urlopen(put, timeout=WAIT * 5).read())
    done = lambda f: snapshot_of(result["message_id"])(f) and not [
        e for e in f["params"]["body"].get("embeds", []) if e.get("embed_id") == written["embed_id"] and "url" not in e
        and "text" not in e]
    _, last = await conn.wait(done, start, timeout=WAIT * 5)
    must(last, "no snapshot completed the embed after the write")
    pick = lambda s: next((e for e in s["params"]["body"].get("embeds", []) if e.get("embed_id") == written["embed_id"]), {})
    return pick(first), pick(last)


@check("4.8.4", "an upload gets a write_url and completes after the PUT", needs="embed:upload")
async def _(run):
    conn = await run.joined()
    pending, done = await write(conn, run, {"kind": "upload", "title": "conformance.txt"}, b"conformance\n")
    must(pending.get("embed_id") and "url" not in pending, "the first broadcast is not pending")
    must(done.get("url"), "the completed upload has no url")


@check("4.8.5", "a stream keeps its text when the write ends", needs="embed:stream")
async def _(run):
    conn = await run.joined()
    live, done = await write(conn, run, {"kind": "stream"}, b"conformance\n")
    must(live.get("url"), "the first broadcast has no url")
    must(done.get("text") == "conformance\n" and "url" not in done, f"the finished stream is {json.dumps(done)}")


@check("4.9.1", "unregistering an unknown push url succeeds", needs=lambda s: "push" in s)
async def _(run):
    conn = await run.open()
    must(await conn.call("push_unregister", {"url": "https://push.example.invalid/conformance"}) == {}, "result is not {}")


# Rules checked on every frame along the way.

def seen(key):
    async def fn(run):
        found = sorted(run.violations.get(key, []))
        must(not found, "; ".join(found[:3]) + (f" (+{len(found) - 3} more)" if len(found) > 3 else ""))
    return fn


check("1", "every frame matches schema/apron.schema.json")(seen("schema"))
check("1.1", "every request gets exactly one reply")(seen("replies"))
check("2", "IDs are well formed")(seen("ids"))
check("3.5.3", "each room's snapshots arrive in ascending log_id")(seen("order"))
check("4.3.3", "only listed room records carry delivery fields", needs="history")(seen("history-rooms"))


async def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("url", help="WebSocket URL, such as ws://127.0.0.1:8765")
    parser.add_argument("--token", help="sign in with scheme token instead of guest")
    parser.add_argument("-v", "--verbose", action="store_true", help="print tracebacks of crashed checks")
    args = parser.parse_args()
    run, counts = Run(args), {}
    if not run.schema.schema:
        print(f"note: {SCHEMA_PATH} not found; frames are not validated against the schema")
    for ref, title, needs, fn in CHECKS:
        status, detail = "PASS", ""
        try:
            if run.server is None and fn is not CHECKS[0][3]:
                raise Skip("no server frame")
            if isinstance(needs, str) and not run.has(needs):
                raise Skip(f"no capability {needs}")
            if callable(needs) and not needs(run.server):
                raise Skip("not advertised")
            await fn(run)
        except Fail as e:
            status, detail = "FAIL", str(e)
        except Warn as e:
            status, detail = "WARN", str(e)
        except Skip as e:
            status, detail = "SKIP", str(e)
        except Exception as e:  # a crash in a check is the server's failure to answer as expected
            status, detail = "FAIL", f"{type(e).__name__}: {e}"
            if args.verbose:
                traceback.print_exc()
        for conn in run.conns:
            await conn.ws.close()
        run.conns.clear()
        counts[status] = counts.get(status, 0) + 1
        print(f"{status}  §{ref:<6} {title}" + (f": {detail}" if detail else ""), flush=True)
    if run.server:
        print(f"{run.server.get('agent', 'server')}: {', '.join(run.server.get('capabilities', [])) or 'core only'}")
    print(", ".join(f"{counts.get(s, 0)} {s.lower()}" for s in ("PASS", "FAIL", "WARN", "SKIP")))
    return 1 if counts.get("FAIL") else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
