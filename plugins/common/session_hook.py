#!/usr/bin/env python3
"""Report or clear harness session → project bindings with Rivet."""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request


def _api_base() -> str:
    return os.environ.get("RIVET_API_BASE", "http://127.0.0.1:8741").rstrip("/")


def _load_payload() -> dict:
    raw = sys.stdin.read()
    if not raw.strip():
        return {}
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return {}
    return data if isinstance(data, dict) else {}


def _session_id(data: dict) -> str:
    for key in ("session_id", "conversation_id", "thread_id"):
        value = data.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""


def _cwd(data: dict) -> str:
    for key in ("cwd", "working_directory"):
        value = data.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    roots = data.get("workspace_roots")
    if isinstance(roots, list):
        for root in roots:
            if isinstance(root, str) and root.strip():
                return root.strip()
    for env_key in ("CLAUDE_PROJECT_DIR", "PWD"):
        value = os.environ.get(env_key, "").strip()
        if value:
            return value
    return os.getcwd()


def _event_name(data: dict) -> str:
    value = data.get("hook_event_name")
    if isinstance(value, str) and value.strip():
        return value.strip()
    return os.environ.get("RIVET_HOOK_EVENT", "SessionStart")


def _is_end(event: str) -> bool:
    normalized = event.replace("_", "").replace("-", "").lower()
    return normalized == "sessionend"


def _provider(data: dict) -> str:
    explicit = os.environ.get("RIVET_PROVIDER", "").strip()
    if explicit:
        return explicit
    if os.environ.get("CURSOR_PLUGIN_ROOT") or data.get("cursor_version"):
        return "cursor"
    if os.environ.get("CLAUDE_PLUGIN_ROOT"):
        return "claude"
    if os.environ.get("CODEX_HOME") or os.environ.get("PLUGIN_ROOT"):
        return "codex"
    return "unknown"


def _fetch_key() -> str:
    key = os.environ.get("RIVET_KEY", "").strip()
    if key:
        return key
    req = urllib.request.Request(
        f"{_api_base()}/v1/session",
        headers={"Host": "127.0.0.1"},
        method="GET",
    )
    try:
        with urllib.request.urlopen(req, timeout=2) as resp:
            body = json.loads(resp.read().decode("utf-8"))
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, ValueError):
        return ""
    value = body.get("api_key") if isinstance(body, dict) else None
    return value.strip() if isinstance(value, str) else ""


def _request(method: str, path: str, payload: dict | None, key: str) -> None:
    data = None if payload is None else json.dumps(payload).encode("utf-8")
    headers = {"Host": "127.0.0.1", "X-Rivet-Key": key}
    if data is not None:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(
        f"{_api_base()}{path}",
        data=data,
        headers=headers,
        method=method,
    )
    try:
        with urllib.request.urlopen(req, timeout=3):
            return
    except (urllib.error.URLError, TimeoutError):
        return


def main() -> int:
    data = _load_payload()
    session_id = _session_id(data)
    if not session_id:
        return 0
    key = _fetch_key()
    if not key:
        return 0
    event = _event_name(data)
    if _is_end(event):
        quoted = urllib.parse.quote(session_id)
        _request("DELETE", f"/v1/harness/session?session_id={quoted}", None, key)
        return 0
    cwd = _cwd(data)
    if not cwd:
        return 0
    _request(
        "POST",
        "/v1/harness/session",
        {
            "session_id": session_id,
            "cwd": cwd,
            "provider": _provider(data),
            "source": event,
        },
        key,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
