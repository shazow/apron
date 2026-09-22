#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = ["websockets>=14,<17"]
# ///
"""Apron Chat v3 for trusted, compliant clients.

Run: uv run apron_server.py [--host 0.0.0.0] [--port 8765]
Or:  python -m pip install 'websockets>=14,<17'; python apron_server.py

One room, guest identities, names, replies, ext pass-through, and the latest
1,000 log records of history. No edits, room changes, reactions, persistence,
or retry deduplication. Reconnects get new IDs. Input shapes/types are assumed
valid; malformed input may close a connection instead of returning protocol
errors. No outgoing buffer limits.
"""

import argparse
import asyncio
import json
import time
from collections import deque
from uuid import uuid4

from websockets.asyncio.server import broadcast, serve
from websockets.exceptions import ConnectionClosed


GREETING = {"protocol": 3, "name": "apron-python/3", "auth": ["guest"],
            "caps": ["history"]}


class Error(Exception):
    def __init__(self, code, message):
        self.payload = {"code": code, "message": message}


def require(condition, message="Invalid parameters", code=-32602):
    if not condition:
        raise Error(code, message)


def send(peers, **frame):
    # Synchronous writes preserve room order without awaiting slow clients.
    broadcast(peers, json.dumps(frame, ensure_ascii=False))


class ApronServer:
    def __init__(self, history_size=1000):
        self.clients = {}  # Only authenticated connections receive broadcasts.
        self.log = deque(maxlen=history_size)  # Room and message records.
        self.last_id = 0
        self.room = {"room_id": "general", "log_id": self.next_id(), "title": "General"}
        self.log.append(self.room)

    def next_id(self):
        self.last_id = max(time.time_ns() // 1_000_000, self.last_id + 1)
        return str(self.last_id)

    def availability(self):
        return {"latest_log_id": str(self.last_id), "history_log_id": self.log[0]["log_id"]}

    def history(self, p):
        limit = p.get("limit", 50)
        require(type(limit) is int and limit > 0, "Invalid limit")
        require(all(str(p.get(k, "0")).isdigit() for k in ("after", "before")), "Invalid bounds")
        limit = min(limit, 200)
        after, before = int(p.get("after", "0")), int(p.get("before", self.last_id))
        matches = [r for r in self.log if after <= int(r["log_id"]) <= before]
        page = matches[:limit] if "after" in p else matches[-limit:]
        result = {"rooms": [r for r in page if "message_id" not in r],
                  "entries": [r for r in page if "message_id" in r],
                  "more": len(matches) > limit, **self.availability()}
        if page:
            result.update(first_id=page[0]["log_id"], last_id=page[-1]["log_id"])
        return result

    def create_message(self, you, p):
        require(isinstance(p.get("body"), dict), "Missing body")
        require(not p.get("deleted"), "Cannot create a deleted message")
        reply_to = p.get("reply_to")
        # The new ID is minted below, so a known target can never be the message itself.
        if "reply_to" in p:
            target = reply_to.get("message_id") if isinstance(reply_to, dict) else None
            require(isinstance(target, str) and any(r.get("message_id") == target for r in self.log),
                    "Unknown reply target")
        message_id = self.next_id()
        message = {"message_id": message_id, "log_id": message_id, "room_id": "general",
                   "from": dict(you), "body": {"format": "plain", **p["body"]}}
        if reply_to:
            message["reply_to"] = {"message_id": reply_to["message_id"]}
        if p.get("ext"):
            message["ext"] = p["ext"]
        self.log.append(message)
        send(self.clients, method="message", params=message)
        return {"message_id": message_id}

    def dispatch(self, ws, method, p):
        # No awaits: mutation, history selection, and live delivery are atomic
        # with respect to other connections on this event loop.
        if method == "auth" and ws not in self.clients:  # Any scheme is accepted.
            self.clients[ws] = {"user_id": "guest_" + uuid4().hex}

        require(ws in self.clients, "Authenticate first", -32001)
        if method in ("auth", "name"):
            if isinstance(p.get("name"), str):
                self.clients[ws] = {**self.clients[ws], "name": p["name"]}
            return {"you": self.clients[ws]}

        require(method in ("message", "history"), "Unsupported method", -32601)
        require(method != "message" or "message_id" not in p, "Editing is unsupported", -32601)
        require(p.get("room_id") == "general", "Unknown room")
        return self.history(p) if method == "history" else self.create_message(self.clients[ws], p)

    def receive(self, ws, raw):
        frame = json.loads(raw)
        try:
            result = self.dispatch(ws, frame["method"], frame.get("params", {}))
            if "id" in frame:
                send([ws], id=frame["id"], result=result)
            if frame["method"] == "auth":
                send([ws], method="room", params={**self.room, **self.availability()})
        except Error as error:
            if "id" in frame:
                send([ws], id=frame["id"], error=error.payload)

    async def handle(self, ws):
        send([ws], method="server", params=GREETING)
        try:
            async for raw in ws:
                self.receive(ws, raw)
        except ConnectionClosed:
            pass
        finally:
            self.clients.pop(ws, None)


async def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    server = ApronServer()
    async with serve(server.handle, args.host, args.port, max_size=256 * 1024):
        print(f"Apron Chat listening on ws://{args.host}:{args.port}", flush=True)
        await asyncio.Future()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
