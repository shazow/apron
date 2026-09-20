#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = ["websockets>=14,<17"]
# ///
"""Apron Chat v2 for trusted, compliant clients.

Run: uv run apron_server.py [--host 0.0.0.0] [--port 8765]
Or:  python -m pip install 'websockets>=14,<17'; python apron_server.py

One room, anonymous identities, names, replies, and 1,000 messages of history.
No edits, threads, persistence, or retry deduplication. Reconnects get new IDs.
Input shapes/types are assumed valid; malformed input may close a connection
instead of returning protocol errors. No outgoing buffer limits.
"""

import argparse
import asyncio
import json
import time
from collections import deque
from uuid import uuid4

from websockets.asyncio.server import broadcast, serve
from websockets.exceptions import ConnectionClosed


GREETING = {"protocol": 2, "name": "apron-python/1", "auth": ["anonymous"],
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
        self.log = deque(maxlen=history_size)
        self.last_id = 0

    def boundaries(self):
        return {"latest_log_id": str(self.last_id),
                "history_log_id": self.log[0]["log_id"] if self.log else None}

    def dispatch(self, ws, method, p):
        # No awaits: mutation, history selection, and live delivery are atomic
        # with respect to other connections on this event loop.
        if method == "auth":
            require(p.get("scheme") == "anonymous", "Use anonymous auth", -32001)
            if ws not in self.clients:
                self.clients[ws] = {"user_id": "guest_" + uuid4().hex}

        require(ws in self.clients, "Authenticate first", -32001)
        if method in ("auth", "name"):
            if "name" in p:
                self.clients[ws] = {**self.clients[ws], "name": p["name"]}
            return {"you": self.clients[ws]}

        require(method in ("message", "history"), "Unsupported method", -32601)
        if method == "message":
            require("message_id" not in p, "Editing is unsupported", -32601)
        require(p.get("room_id") == "general", "Unknown room")
        require("thread_id" not in p, "Unknown thread")

        if method == "history":
            limit = min(p.get("limit", 50), 200)
            after, before = int(p.get("after", "0")), int(p.get("before", self.last_id))
            matches = [e for e in self.log if after <= int(e["log_id"]) <= before]
            entries = matches[:limit] if "after" in p else matches[-limit:]
            result = {"entries": entries, "more": len(matches) > limit,
                      **self.boundaries()}
            if entries:
                result.update(first_id=entries[0]["log_id"], last_id=entries[-1]["log_id"])
            return result

        if "reply_message_id" in p:
            require(any(e["log_id"] == p["reply_message_id"] for e in self.log),
                    "Unknown reply target")
        self.last_id = max(time.time_ns() // 1_000_000, self.last_id + 1)
        message_id = str(self.last_id)
        message = {k: v for k, v in p.items()
                   if k not in ("room_id", "from", "log_id")}
        message.update({"message_id": message_id, "from": dict(self.clients[ws])})
        entry = {"log_id": message_id, "message": message}
        self.log.append(entry)
        send(self.clients, method="message", params={"room_id": "general", **entry})
        return {"message_id": message_id}

    def receive(self, ws, raw):
        frame = json.loads(raw)
        try:
            result = self.dispatch(ws, frame["method"], frame.get("params", {}))
            if "id" in frame:
                send([ws], id=frame["id"], result=result)
            if frame["method"] == "auth":
                send([ws], method="room", params={"room_id": "general", "name": "General",
                                                 **self.boundaries()})
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
