# /// script
# requires-python = ">=3.10"
# dependencies = ["jsonschema>=4.18"]
# ///
"""Validate the fixtures and PROTOCOL.md examples against schema/apron.schema.json.

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


def check_result(method, reply, where):
    if "error" in reply:
        check(reply["error"], "Error", where)
    elif camel(method) + "Result" in SCHEMA["$defs"]:
        check(reply["result"], camel(method) + "Result", where)


def check_steps(steps, where, file, variant):
    requests = {}
    for i, step in enumerate(steps):
        at = f"{where} step {i}"
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
            for variant in data["variants"]:
                name = variant.get("name", "")
                check_steps(variant["steps"], f"{where} {name}", Path(path).name, name)
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


def check_protocol():
    """Validate each complete frame in PROTOCOL.md's JSON examples."""
    text = (ROOT / "PROTOCOL.md").read_text()
    decoder = json.JSONDecoder()
    for block in re.finditer(r"```jsonc?\n(.*?)```", text, re.S):
        line = text[: block.start()].count("\n") + 1
        body = "\n".join(l for l in block.group(1).splitlines() if not l.strip().startswith("//"))
        requests = {}
        for start in (m.start() for m in re.finditer(r"^\s*\{", body, re.M)):
            try:
                frame, _ = decoder.raw_decode(body, start + body[start:].index("{"))
            except json.JSONDecodeError:
                continue  # an elided example, such as one with "..."
            where = f"PROTOCOL.md:{line}"
            if "method" in frame and "id" in frame:
                requests[frame["id"]] = frame["method"]
                check(frame, "ClientRequest", where)
            elif "method" in frame:
                check(frame, "ClientNotification" if frame["method"] in ("activity", "ping", "status") and "from" not in frame.get("params", {}) else "ServerNotification", where)
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
