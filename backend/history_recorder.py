"""
backend/history_recorder.py

Business layer that turns a single ``POST /api/generate`` invocation into a
``History_Record`` and hands it off to ``HistoryStore``. Called from
``app.py`` at the end of ``generate_image()``.

Design goals
------------
* Zero impact on the generate endpoint: any exception inside the recorder
  is swallowed and downgraded to a runtime-log warning. The caller wraps
  the invocation in its own try/except as well, so we have two lines of
  defense.
* Honour the ``history_recorder_enabled`` kill-switch in
  ``system_config.json`` (Clarification C4). When disabled, return
  immediately without touching the store.
* Normalise ``source`` to one of ``canvas`` / ``eagle_plugin`` / ``script``
  / ``unknown``; keep the original value under ``raw_source`` only when we
  demoted it to ``unknown``.
* Auto-derive ``mode`` (``text2img`` vs ``img2img``) from
  ``reference_images``; never store the base64 bodies.
* Build a stable id shaped like ``{machine_id}-{ts_ms}-{rand6}``.

Requirements covered
--------------------
* Requirement 2   - task_meta normalisation (source, canvas save state)
* Requirement 3   - mode auto-detection + reference_count
* Requirement 4   - full History_Record field set + id / created_at / schema_version
* Requirement 10  - eagle_item_ids from task_meta when plugin already knows them
* Requirement 11  - batch_id / script_name fields
* Requirement 19.1 - write a record regardless of success/failure
* Clarification C4 - history_recorder_enabled kill switch
"""

from __future__ import annotations

import secrets
import time
from datetime import datetime
from typing import Any, Optional


# The JSONL schema is versioned so future field changes can be detected by
# readers. Bump only on breaking shape changes.
_SCHEMA_VERSION = "1"

_VALID_SOURCES = ("canvas", "eagle_plugin", "script")


def record_generation(
    request_body: Optional[dict],
    result: Optional[dict],
    provider: Optional[dict],
    elapsed_sec: float,
    machine_id: str,
    store: Any,
) -> Optional[dict]:
    """Persist a ``History_Record`` for one ``/api/generate`` invocation.

    Parameters
    ----------
    request_body:
        The JSON body that ``generate_image()`` received. May be ``None``
        when the caller never parsed it.
    result:
        The generator's return dict, typically
        ``{"success": True, "images": [...], "count": N}`` or
        ``{"success": False, "error": "..."}``.
    provider:
        The provider config dict as returned by ``get_provider_by_id`` /
        ``get_active_provider``.
    elapsed_sec:
        Wall-clock seconds between the start of ``generate_image()`` and
        the recorder call.
    machine_id:
        Per-machine identifier from ``system_config.machine_id``.
    store:
        A ``HistoryStore`` instance. The recorder only calls ``append``.

    Returns
    -------
    The record that was appended, or ``None`` when the recorder is
    disabled / something went wrong. Never raises.
    """
    # Lazy import to avoid circular dependency with ``app.py`` at import time.
    load_system_config, push_runtime_log = _lazy_app_hooks()

    try:
        try:
            config = load_system_config() if load_system_config else {}
        except Exception:
            config = {}
        if not bool(config.get("history_recorder_enabled", True)):
            return None

        request_body = request_body if isinstance(request_body, dict) else {}
        result = result if isinstance(result, dict) else {}
        provider = provider if isinstance(provider, dict) else {}
        task_meta = request_body.get("task_meta")
        task_meta = task_meta if isinstance(task_meta, dict) else {}

        source, raw_source = _normalize_source(task_meta.get("source"))

        reference_images = request_body.get("reference_images") or []
        if not isinstance(reference_images, (list, tuple)):
            reference_images = []
        non_empty_refs = [r for r in reference_images if r]
        mode = "img2img" if non_empty_refs else "text2img"

        success = bool(result.get("success"))
        output_files = _extract_output_paths(result) if success else []
        error_message = None
        if not success:
            err = result.get("error")
            error_message = str(err) if err is not None else "unknown error"

        canvas_save_state = _resolve_canvas_save_state(source, task_meta)
        eagle_item_ids = _coerce_string_list(task_meta.get("eagle_item_ids"))

        record: dict = {
            "id": _build_record_id(machine_id),
            "schema_version": _SCHEMA_VERSION,
            "created_at": _now_iso(),
            "machine_id": str(machine_id or "").strip() or "unknown",
            "source": source,
            "raw_source": raw_source,
            "mode": mode,
            "prompt": _coerce_str(request_body.get("prompt")),
            "aspect_ratio": _coerce_optional_str(request_body.get("aspect_ratio")),
            "resolution": _coerce_optional_str(request_body.get("resolution")),
            "size": _coerce_optional_str(request_body.get("size")),
            "quality": _coerce_optional_str(request_body.get("quality")),
            "provider_id": _coerce_optional_str(provider.get("id")),
            "provider_name": _coerce_optional_str(provider.get("name")),
            "model": _coerce_optional_str(provider.get("model")),
            "count": _coerce_int(request_body.get("count"), default=1),
            "reference_count": len(non_empty_refs),
            "output_files": output_files,
            "eagle_item_ids": eagle_item_ids,
            "elapsed_sec": _round_elapsed(elapsed_sec),
            "success": success,
            "error_message": error_message,
            "canvas_save_state": canvas_save_state,
            "canvas_node_id": _coerce_optional_str(task_meta.get("canvas_node_id")),
            "batch_id": _coerce_optional_str(task_meta.get("batch_id")),
            "script_name": _coerce_optional_str(task_meta.get("script_name")),
        }

        try:
            store.append(record)
        except Exception as exc:
            _warn(push_runtime_log, f"[history] 记录写入失败: {exc}")
            return None

        return record

    except Exception as exc:
        # Absolute backstop: no matter what blows up, never propagate.
        _warn(push_runtime_log, f"[history] 记录构造失败: {exc}")
        return None


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------


def _lazy_app_hooks():
    """Return ``(load_system_config, push_runtime_log)`` from ``app`` if available."""
    try:
        from app import load_system_config as _lsc  # type: ignore
    except Exception:
        _lsc = None
    try:
        from app import push_runtime_log as _prl  # type: ignore
    except Exception:
        _prl = None
    return _lsc, _prl


def _normalize_source(raw: Any) -> tuple[str, Optional[str]]:
    """Return ``(source, raw_source)``.

    * Valid values pass through and ``raw_source`` stays ``None``.
    * Anything else degrades to ``"unknown"`` and the original string is
      preserved in ``raw_source`` for forensic lookup.
    """
    if isinstance(raw, str) and raw in _VALID_SOURCES:
        return raw, None
    if raw is None or raw == "":
        return "unknown", None
    return "unknown", str(raw)


def _resolve_canvas_save_state(source: str, task_meta: dict) -> Optional[str]:
    """Canvas records default to ``canvas_unsaved`` (per Requirement 2.6)."""
    provided = task_meta.get("canvas_save_state")
    if isinstance(provided, str) and provided in ("canvas_unsaved", "canvas_saved"):
        return provided
    if source == "canvas":
        return "canvas_unsaved"
    return None


def _extract_output_paths(result: dict) -> list[str]:
    """Pull absolute file paths out of the generator's ``images`` list."""
    images = result.get("images")
    if not isinstance(images, list):
        return []
    paths: list[str] = []
    for item in images:
        if isinstance(item, dict):
            candidate = item.get("filepath") or item.get("path")
            if isinstance(candidate, str) and candidate:
                paths.append(candidate)
        elif isinstance(item, str) and item:
            paths.append(item)
    return paths


def _coerce_string_list(value: Any) -> list[str]:
    if not isinstance(value, (list, tuple)):
        return []
    return [str(v) for v in value if v is not None and str(v) != ""]


def _coerce_str(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    return str(value)


def _coerce_optional_str(value: Any) -> Optional[str]:
    if value is None:
        return None
    if isinstance(value, str):
        return value if value != "" else None
    text = str(value)
    return text if text != "" else None


def _coerce_int(value: Any, default: int = 1) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _round_elapsed(value: Any) -> float:
    try:
        return round(float(value), 3)
    except (TypeError, ValueError):
        return 0.0


def _build_record_id(machine_id: str) -> str:
    safe_machine = (str(machine_id or "").strip() or "unknown").replace(" ", "_")
    return f"{safe_machine}-{int(time.time() * 1000)}-{secrets.token_hex(3)}"


def _now_iso() -> str:
    """Local time with timezone offset, second precision."""
    return datetime.now().astimezone().isoformat(timespec="seconds")


def _warn(push_runtime_log, message: str) -> None:
    if push_runtime_log is None:
        # Fallback path: don't raise, don't silently swallow - use stderr.
        try:
            import sys

            print(message, file=sys.stderr)
        except Exception:
            pass
        return
    try:
        push_runtime_log(message, level="warn")
    except Exception:
        pass
