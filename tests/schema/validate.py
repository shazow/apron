# /// script
# requires-python = ">=3.10"
# dependencies = ["jsonschema>=4.18"]
# ///
"""Validate the fixtures and PROTOCOL.md examples against schema/apron.schema.json.

Besides the schema, it checks rules the schema cannot express: every server
frame speaks protocol 8, names that PROTOCOL.md does not define start with
ext:, no session fixture delivers a frame between an auth request and its
result, a client writes each ext key only to a server with capability ext or
the capability of the extension that defines the key (ext:<key>), no fixture
repeats a variant, and the cases of tests/fixtures/push.json are valid, or
break a rule, as they say (including the 2048-byte payload limit).

Run from the repository root: uv run tests/schema/validate.py
"""

import glob
import json
import re
import sys
from pathlib import Path

from jsonschema import Draft202012Validator

ROOT = Path(__file__).resolve().parents[2]
SCHEMA = json.loads((ROOT / "schema/apron.schema.json").read_text())
Draft202012Validator.check_schema(SCHEMA)
validators = {}
errors = []
checked = {}


def camel(method):
    return "".join(part.capitalize() for part in method.split("_"))


def check(instance, name, where):
    """Validate instance against $defs/name and record any errors."""
    if name not in SCHEMA["$defs"]:
        errors.append(f"{where}: no schema {name}")
        return
    if name not in validators:
        wrapper = {k: v for k, v in SCHEMA.items() if k != "anyOf"}
        wrapper["$ref"] = f"#/$defs/{name}"
        validators[name] = Draft202012Validator(wrapper)
    source = where.split(":")[0].split(" ")[0]
    source = "PROTOCOL.md" if source == "PROTOCOL.md" else "fixtures"
    checked[source] = checked.get(source, 0) + 1
    for error in validators[name].iter_errors(instance):
        path = "/".join(str(p) for p in error.absolute_path)
        errors.append(f"{where}: {name} at /{path}: {error.message}")


# Frames a fixture sends on purpose to test that clients reject them.
INVALID = {
    ("history-recovery-failure.json", "invalid-page", 15): "a page without metadata",
}

VERSION = 8

# Names that PROTOCOL.md defines, by the list that an extension can add to (§1).
# Any other name starts with "ext:".
KNOWN = {
    "method": set(SCHEMA["$defs"]["UnknownMethod"]["not"]["enum"]),
    "capability": {"command", "history", "rooms", "edit", "status", "activity", "reactions", "embed:upload", "embed:stream", "ext"},
    "auth scheme": {"guest", "token", "webauthn", "email"},
    "embed kind": {"upload", "stream", "iframe", "html"},
    "push kind": {"relay", "webpush"},
    "wake scope": {"mentions", "private", "replies", "joined", "badge"},
}

# Unknown names a fixture keeps without the prefix on purpose.
UNPREFIXED = {
    ("core-session.json", "method", "future_notice"): "a method that a later protocol version defines",
}

PUSH_LIMIT = 2048

def names(value):
    """Yield (list, name) for each extensible name in a frame or params."""
    if isinstance(value, list):
        for item in value:
            yield from names(item)
    if not isinstance(value, dict):
        return
    if isinstance(value.get("method"), str):
        yield "method", value["method"]
    params = value.get("params") if isinstance(value.get("params"), dict) else {}
    if value.get("method") == "server":
        yield from (("capability", c) for c in params.get("capabilities", []))
        yield from (("auth scheme", s) for s in params.get("auth", []) + params.get("signup", []))
        push = params.get("push", {})
        yield from (("push kind", k) for k in push if k != "wake")
        yield from (("wake scope", w) for w in push.get("wake", []))
    if value.get("method") == "auth" and "scheme" in params:
        yield "auth scheme", params["scheme"]
    if value.get("method") == "push_register":
        if "kind" in params:
            yield "push kind", params["kind"]
        yield from (("wake scope", w) for w in params.get("wake", []))
    for key, item in value.items():
        if key == "embeds" and isinstance(item, list):
            yield from (("embed kind", e["kind"]) for e in item if isinstance(e, dict) and isinstance(e.get("kind"), str))
        if key not in ("method", "ext"):
            yield from names(item)


def check_names(value, where, file=None):
    for kind, name in names(value):
        if name in KNOWN[kind] or name.startswith("ext:") or (file, kind, name) in UNPREFIXED:
            continue
        errors.append(f"{where}: unknown {kind} {name!r} does not start with ext:")


def check_version(frame, where):
    if frame.get("method") == "server" and frame.get("params", {}).get("apron") != VERSION:
        errors.append(f"{where}: server frame apron is not {VERSION}")


def check_result(method, reply, where):
    if "error" in reply:
        check(reply["error"], "Error", where)
    elif camel(method) + "Result" in SCHEMA["$defs"]:
        check(reply["result"], camel(method) + "Result", where)


def check_steps(steps, where, file, variant):
    requests = {}
    signing_in = set()  # auth requests captured and not yet answered
    capabilities = []  # of the latest server frame
    for i, step in enumerate(steps):
        at = f"{where} step {i}"
        check_names(step, at, file)
        frame = step.get("receive", {})
        if frame.get("method") == "server":
            capabilities = frame.get("params", {}).get("capabilities", [])
        match = step.get("request", {}).get("match", {})
        ext = match.get("params", {}).get("ext")
        for key in ext if isinstance(ext, dict) and "ext" not in capabilities else ():
            if f"ext:{key}" not in capabilities:
                errors.append(f"{at}: the client writes ext.{key} to a server without capability ext or ext:{key} (§4.12)")
        if "receive" in step and signing_in:
            errors.append(f"{at}: a frame arrives between auth {sorted(signing_in)} and its result (§3.2)")
        if "request" in step and step["request"]["match"].get("method") == "auth":
            signing_in.add(step["request"]["as"])
        if "reply" in step:
            signing_in.discard(step["reply"]["to"])
        if "receive" in step:
            check_version(step["receive"], at)
        if (file, variant, i) in INVALID:
            continue
        if "receive" in step:
            frame = step["receive"]
            check(frame, "ServerFrame", at)
            if "result" in frame:
                result = frame["result"]
                method = "history" if "more" in result else "room_list"
                check(result, camel(method) + "Result", at)
        elif "request" in step:
            match = step["request"]["match"]
            requests[step["request"]["as"]] = match["method"]
            if "params" in match:
                check(match["params"], camel(match["method"]) + "Params", at)
        elif "reply" in step:
            reply = step["reply"]
            check_result(requests[reply["to"]], reply, at)


def check_fixtures():
    for path in sorted(glob.glob(str(ROOT / "tests/fixtures/**/*.json"), recursive=True)):
        where = Path(path).relative_to(ROOT)
        data = json.loads(Path(path).read_text())
        kind = data.get("kind")
        if kind in ("session", "replay"):
            seen = {}
            for variant in data["variants"]:
                name = variant.get("name", "")
                check_steps(variant["steps"], f"{where} {name}", Path(path).name, name)
                steps = json.dumps(variant["steps"], sort_keys=True)
                if steps in seen:
                    errors.append(f"{where} {name}: same steps as variant {seen[steps]}")
                seen.setdefault(steps, name)
        elif kind == "history":
            for case in data["cases"]:
                at = f"{where} {case['name']}"
                if "room" in case:
                    check(case["room"], "Room", at)
                for message in case.get("messages", []):
                    check(message, "Message", at)
                if "history" in case:
                    check(case["history"], "Response", at)
                    check(case["history"]["result"], "HistoryResult", at)
        elif kind == "webauthn":
            for case in data["cases"]:
                for key in ("begin", "finish"):
                    if key in case:
                        check(case[key], "ClientRequest", f"{where} {case['name']} {key}")
                check(case["begin_result"], "AuthResult", f"{where} {case['name']}")
        elif kind == "push":
            for case in data["payloads"]:
                check_case(case, case["payload"], "PushPayload", f"{where} payload {case['name']}", PUSH_LIMIT)
            for case in data["registrations"]:
                check_case(case, case["params"], "PushRegisterParams", f"{where} registration {case['name']}")


def check_case(case, instance, name, where, limit=None):
    """Check a case that is valid, or that breaks at least one rule."""
    found = []
    check(instance, name, where)
    while errors and errors[-1].startswith(where + ":"):
        found.append(errors.pop())
    check_names(instance if name != "PushRegisterParams" else {"method": "push_register", "params": instance}, where)
    while errors and errors[-1].startswith(where + ":"):
        found.append(errors.pop())
    size = len(json.dumps(instance, ensure_ascii=False, separators=(",", ":")).encode())
    if limit is not None and size > limit:
        found.append(f"{where}: {size} bytes, over {limit}")
    if case["valid"]:
        errors.extend(reversed(found))
    elif not found:
        errors.append(f"{where}: expected to break a rule ({case['why']}), but conforms")


def check_protocol():
    """Validate each complete frame in PROTOCOL.md's JSON examples."""
    text = (ROOT / "PROTOCOL.md").read_text()
    # Appendix C uses the names of designs that are not part of the protocol yet.
    proposals = text.index("## Appendix C")
    decoder = json.JSONDecoder()
    for block in re.finditer(r"```jsonc?\n(.*?)```", text, re.S):
        line = text[: block.start()].count("\n") + 1
        lines = block.group(1).splitlines()
        body = "\n".join("" if l.strip().startswith("//") else l for l in lines)
        requests = {}
        for start in (m.start() for m in re.finditer(r"^\s*\{", body, re.M)):
            try:
                frame, _ = decoder.raw_decode(body, start + body[start:].index("{"))
            except json.JSONDecodeError:
                continue  # an elided example, such as one with "..."
            where = f"PROTOCOL.md:{line}"
            if block.start() < proposals:
                check_names(frame, where)
            check_version(frame, where)
            if "method" in frame and "id" in frame:
                requests[frame["id"]] = frame["method"]
                check(frame, "ClientRequest", where)
            elif "method" in frame:
                client = frame["method"] in ("activity", "ping") and "from" not in frame.get("params", {})
                check(frame, "ClientNotification" if client else "ServerNotification", where)
            elif "push_id" in frame or "unread" in frame:
                check(frame, "PushPayload", where)
            elif "result" in frame or "error" in frame:
                check(frame, "ServerFrame", where)
                if frame.get("id") in requests:
                    check_result(requests[frame["id"]], frame, where)


check_fixtures()
check_protocol()
for error in errors:
    print(error)
print(", ".join(f"{n} checks in {s}" for s, n in sorted(checked.items())) + f", {len(errors)} errors")
sys.exit(1 if errors else 0)
