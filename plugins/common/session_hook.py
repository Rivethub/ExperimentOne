#!/usr/bin/env python3
"""Optional harness metadata for Rivet — never a capture ingress path.

Live capture is proxy-only (`rivetsink` → `/v1/ingest`). This hook only:
  - binds session_id → cwd/provider (so ingest can attach project_id)
  - clears the binding on SessionEnd
  - on SessionStart, injects budgeted startup memory including workspace
    SOUL.md / IDENTITY.md / MEMORY.md when present

It does not post tool/thinking/content into Rivet.
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

# Well-known workspace identity files (RivetOS-style). First path wins per title.
_WORKSPACE_FILES: list[tuple[str, str]] = [
    ("SOUL.md", "soul"),
    ("IDENTITY.md", "identity"),
    ("MEMORY.md", "memory"),
    ("AGENTS.md", "agents"),
    (".rivet/SOUL.md", "soul"),
    (".rivet/IDENTITY.md", "identity"),
    (".rivet/MEMORY.md", "memory"),
    ("memory/SOUL.md", "soul"),
    ("memory/IDENTITY.md", "identity"),
    ("memory/MEMORY.md", "memory"),
]


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
    for env_key in ("CURSOR_PROJECT_DIR", "CLAUDE_PROJECT_DIR", "PWD"):
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


def _is_bind_event(event: str) -> bool:
    """Only session/cwd/prompt heartbeats refresh bindings — never tool/stop hooks."""
    normalized = event.replace("_", "").replace("-", "").lower()
    return normalized in {
        "sessionstart",
        "cwdchanged",
        "userpromptsubmit",
        "beforesubmitprompt",
    }


def _is_session_start(event: str) -> bool:
    return event.replace("_", "").replace("-", "").lower() == "sessionstart"


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


def _read_workspace_files(cwd: str) -> dict[str, str]:
    """Load SOUL / IDENTITY / MEMORY from the project root (plugin-side)."""
    root = Path(cwd)
    out: dict[str, str] = {}
    for rel, key in _WORKSPACE_FILES:
        if key in out:
            continue
        for candidate in (root / rel, root / rel.lower()):
            try:
                text = candidate.read_text(encoding="utf-8")
            except OSError:
                continue
            body = text.strip()
            if body:
                out[key] = body
                break
    return out


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

    if not _is_bind_event(event):
        # Tool/stop/thinking hooks must not ingress content — ignore.
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
    # Optional: inject budgeted startup memory (workspace SOUL/IDENTITY/MEMORY + Rivet recall).
    if _is_session_start(event):
        if os.environ.get("RIVET_STARTUP_INJECT", "1").strip() not in {"0", "false", "no"}:
            memory = _fetch_startup_memory(key, cwd)
            if memory:
                _emit_startup_context(memory, _provider(data))
    return 0


def _fetch_startup_memory(key: str, cwd: str) -> str:
    workspace = _read_workspace_files(cwd)
    # Prefer project folder name as a soft search hint — not the full path.
    hint = Path(cwd).name if cwd else ""
    payload = {
        "cwd": cwd,
        "q": hint,
        "limit": 8,
        "workspace": workspace,
    }
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        f"{_api_base()}/v1/memory/startup",
        data=data,
        headers={
            "Host": "127.0.0.1",
            "X-Rivet-Key": key,
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            body = json.loads(resp.read().decode("utf-8"))
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, ValueError):
        # Fall back to GET with cwd if POST is unavailable.
        return _fetch_startup_memory_get(key, cwd, hint)
    if not isinstance(body, dict):
        return ""
    markdown = body.get("markdown")
    if isinstance(markdown, str) and markdown.strip():
        return markdown.strip()[:6000]
    return ""


def _fetch_startup_memory_get(key: str, cwd: str, hint: str) -> str:
    params = urllib.parse.urlencode({"cwd": cwd, "q": hint, "limit": "8"})
    req = urllib.request.Request(
        f"{_api_base()}/v1/memory/startup?{params}",
        headers={"Host": "127.0.0.1", "X-Rivet-Key": key},
        method="GET",
    )
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            body = json.loads(resp.read().decode("utf-8"))
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, ValueError):
        return ""
    if not isinstance(body, dict):
        return ""
    markdown = body.get("markdown")
    if isinstance(markdown, str) and markdown.strip():
        return markdown.strip()[:6000]
    return ""


def _emit_startup_context(markdown: str, provider: str) -> None:
    """Emit SessionStart context for Claude Code and Cursor (dual field names)."""
    # Claude Code: hookSpecificOutput.additionalContext (camelCase)
    # Cursor: top-level additional_context (snake_case); requires valid JSON stdout
    payload: dict = {
        "additional_context": markdown,
        "hookSpecificOutput": {
            "hookEventName": "SessionStart",
            "additionalContext": markdown,
        },
    }
    if provider == "cursor":
        # Cursor sessionStart is fire-and-forget; keep the payload minimal + dual keys.
        payload = {
            "additional_context": markdown,
            "additionalContext": markdown,
        }
    try:
        sys.stdout.write(json.dumps(payload))
        sys.stdout.write("\n")
        sys.stdout.flush()
    except OSError:
        return


if __name__ == "__main__":
    raise SystemExit(main())
