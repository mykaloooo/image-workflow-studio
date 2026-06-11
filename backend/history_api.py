"""
backend/history_api.py

Flask Blueprint serving the ``/api/history*`` endpoints consumed by the
Generation History Panel and local tooling.

The blueprint is intentionally stateless. The hosting application (``app.py``)
injects runtime dependencies as attributes on the blueprint object right
after it is registered:

    from history_api import bp as history_bp
    app.register_blueprint(history_bp)
    history_bp.store = _history_store
    history_bp.machine_id = _machine_id
    history_bp.peer_machines = _peer_machines
    history_bp.history_store_path = _history_store.path
    history_bp.history_store_max_mb = _history_store.max_mb

Every handler looks those attributes up defensively so a misconfigured host
yields an empty-but-valid JSON response instead of a 500.

Endpoints
---------
* ``GET  /api/history``           - paginated, filtered list
* ``GET  /api/history/thumbnail`` - on-demand JPEG thumbnail for an output file
* ``PATCH /api/history/<id>``     - update canvas_save_state / eagle_item_ids / output_files
* ``POST /api/history/import``    - (enhancement) import legacy JSONL dumps
* ``GET  /api/history/config``    - expose effective machine_id / peers / paths

Requirements covered
--------------------
* Requirement 7  - list endpoint, filters, limit clamp, empty-store shape, warnings
* Requirement 8  - thumbnail generation, caching, 404 / 422 error codes, slow-log
* Requirement 9  - PATCH endpoint semantics and validation
* Requirement 10 - eagle_item_ids patch support
* Requirement 11 - batch_id query filter
* Requirement 16 - thumbnail fallback JSON payloads
* Requirement 24 - /import route skeleton
* Requirement 25.3 - /config endpoint
"""

from __future__ import annotations

import json
import os
import re
import secrets
import time
from datetime import datetime
from io import BytesIO
from typing import Any, Iterable, Optional

from flask import Blueprint, current_app, jsonify, make_response, request

try:
    from PIL import Image, UnidentifiedImageError
except ImportError:  # pragma: no cover - PIL is listed in requirements.txt
    Image = None  # type: ignore[assignment]
    UnidentifiedImageError = Exception  # type: ignore[assignment]


bp = Blueprint("history", __name__, url_prefix="/api/history")


# ---------------------------------------------------------------------------
# constants
# ---------------------------------------------------------------------------

_VALID_CANVAS_STATES = {"canvas_unsaved", "canvas_saved"}
_PATCHABLE_FIELDS = ("canvas_save_state", "eagle_item_ids", "output_files")

_DEFAULT_LIMIT = 100
_MAX_LIMIT = 500

_THUMB_MAX_EDGE = 256
_THUMB_JPEG_QUALITY = 80
_THUMB_SLOW_SEC = 3.0
_THUMB_CACHE_SEC = 86400

# ---- legacy import constants ----
_IMPORT_VALID_SOURCES = ("canvas", "eagle_plugin", "script")
_IMPORT_VALID_MODES = ("text2img", "img2img")
_IMPORT_VALID_CANVAS_STATES = ("canvas_unsaved", "canvas_saved")
_IMPORT_SCHEMA_VERSION = "1"
_IMPORT_MAX_FILE_BYTES = 100 * 1024 * 1024  # 100 MB safety cap for uploads
_IMPORT_MAX_ERRORS = 200  # cap error list length in response


# ---------------------------------------------------------------------------
# dependency lookup helpers
# ---------------------------------------------------------------------------

def _get_store():
    """Return the HistoryStore attached to the blueprint, or ``None``."""
    store = getattr(bp, "store", None)
    if store is not None:
        return store
    # fallback: some deployments may stash it on app.extensions
    try:
        return current_app.extensions.get("history_store")  # type: ignore[attr-defined]
    except RuntimeError:
        return None


def _get_machine_id() -> str:
    value = getattr(bp, "machine_id", None)
    if isinstance(value, str) and value:
        return value
    try:
        cfg_value = current_app.config.get("MACHINE_ID")
    except RuntimeError:
        cfg_value = None
    return cfg_value or ""


def _get_peer_machines() -> list[dict]:
    peers = getattr(bp, "peer_machines", None)
    if isinstance(peers, list):
        return peers
    return []


def _get_history_path() -> Optional[str]:
    path = getattr(bp, "history_store_path", None)
    if isinstance(path, str) and path:
        return path
    store = _get_store()
    if store is not None and getattr(store, "path", None):
        return store.path
    return None


def _get_history_max_mb() -> Optional[int]:
    value = getattr(bp, "history_store_max_mb", None)
    if isinstance(value, int):
        return value
    store = _get_store()
    if store is not None and getattr(store, "max_mb", None) is not None:
        return store.max_mb
    return None


# ---------------------------------------------------------------------------
# request parsing helpers
# ---------------------------------------------------------------------------

def _query_value(key: str) -> Optional[str]:
    """Return the trimmed query-string value or ``None`` when empty."""
    raw = request.args.get(key)
    if raw is None:
        return None
    if isinstance(raw, str):
        trimmed = raw.strip()
        return trimmed or None
    return raw


def _query_int(key: str, default: int) -> int:
    raw = request.args.get(key)
    if raw is None or raw == "":
        return default
    try:
        return int(raw)
    except (TypeError, ValueError):
        return default


def _build_filters() -> dict[str, Any]:
    filters: dict[str, Any] = {}
    for key in (
        "source",
        "mode",
        "provider_id",
        "canvas_save_state",
        "batch_id",
        "keyword",
        "date_from",
        "date_to",
    ):
        value = _query_value(key)
        if value is not None:
            filters[key] = value
    return filters


def _log_warn(msg: str) -> None:
    try:
        current_app.logger.warning(msg)
    except RuntimeError:
        # outside of app context; swallow to avoid masking the real error
        pass


# ---------------------------------------------------------------------------
# GET /api/history
# ---------------------------------------------------------------------------

@bp.get("")
def list_history():
    """Return a paginated, filtered view of History_Record entries."""
    machine_id = _get_machine_id()
    store = _get_store()

    if store is None:
        return jsonify({
            "success": True,
            "machine_id": machine_id,
            "records": [],
            "total": 0,
            "has_more": False,
        })

    filters = _build_filters()
    limit = _query_int("limit", _DEFAULT_LIMIT)
    offset = _query_int("offset", 0)

    # Requirement 7.5 / 7.6: default 100, clamp to 500 without erroring.
    if limit <= 0:
        limit = _DEFAULT_LIMIT
    if limit > _MAX_LIMIT:
        limit = _MAX_LIMIT
    if offset < 0:
        offset = 0

    try:
        records, total, has_more, warnings = store.read_page(
            filters=filters, limit=limit, offset=offset
        )
    except Exception as exc:  # defensive: keep endpoint responsive
        _log_warn(f"[history] list read failed: {exc}")
        return jsonify({
            "success": True,
            "machine_id": machine_id,
            "records": [],
            "total": 0,
            "has_more": False,
        })

    body: dict[str, Any] = {
        "success": True,
        "machine_id": machine_id,
        "records": records,
        "total": total,
        "has_more": has_more,
    }
    if warnings:
        body["warnings"] = warnings
    return jsonify(body)


# ---------------------------------------------------------------------------
# GET /api/history/thumbnail
# ---------------------------------------------------------------------------

@bp.get("/thumbnail")
def get_thumbnail():
    """Return a JPEG thumbnail (long edge ≤ 256 px) for one output image."""
    record_id = _query_value("record_id")
    if not record_id:
        return jsonify({"success": False, "reason": "missing_record_id"}), 400

    try:
        index = int(request.args.get("index", "0"))
    except (TypeError, ValueError):
        return jsonify({"success": False, "reason": "invalid_index"}), 400
    if index < 0:
        return jsonify({"success": False, "reason": "invalid_index"}), 400

    store = _get_store()
    if store is None:
        return jsonify({"success": False, "reason": "source_missing"}), 404

    record = store.find_by_id(record_id)
    if not record:
        return jsonify({"success": False, "reason": "source_missing"}), 404

    output_files = record.get("output_files") or []
    if not isinstance(output_files, list) or index >= len(output_files):
        return jsonify({"success": False, "reason": "source_missing"}), 404

    src_path = output_files[index]
    if not isinstance(src_path, str) or not src_path:
        return jsonify({"success": False, "reason": "source_missing"}), 404
    if not os.path.exists(src_path):
        return jsonify({"success": False, "reason": "source_missing"}), 404

    if Image is None:
        _log_warn("[history] PIL not installed; thumbnail generation unavailable")
        return jsonify({"success": False, "reason": "decode_failed"}), 422

    t_start = time.time()
    try:
        with Image.open(src_path) as img:
            img.load()
            resample = getattr(Image, "Resampling", Image).LANCZOS  # Pillow 10 compat
            img.thumbnail((_THUMB_MAX_EDGE, _THUMB_MAX_EDGE), resample)
            rgb = img.convert("RGB") if img.mode != "RGB" else img
            buf = BytesIO()
            rgb.save(buf, format="JPEG", quality=_THUMB_JPEG_QUALITY)
    except (UnidentifiedImageError, OSError, ValueError) as exc:
        _log_warn(f"[history] thumbnail decode failed for {src_path}: {exc}")
        return jsonify({"success": False, "reason": "decode_failed"}), 422

    elapsed = time.time() - t_start
    if elapsed > _THUMB_SLOW_SEC:
        _log_warn(
            f"[history] thumbnail slow: {elapsed:.2f}s for record_id={record_id} "
            f"path={src_path}"
        )

    resp = make_response(buf.getvalue())
    resp.headers["Content-Type"] = "image/jpeg"
    resp.headers["Cache-Control"] = f"public, max-age={_THUMB_CACHE_SEC}"
    resp.headers["Content-Length"] = str(len(resp.get_data()))
    return resp


# ---------------------------------------------------------------------------
# PATCH /api/history/<record_id>
# ---------------------------------------------------------------------------

@bp.patch("/<record_id>")
def patch_record(record_id: str):
    """Update a History_Record's canvas_save_state / eagle_item_ids / output_files."""
    store = _get_store()
    if store is None:
        return jsonify({"success": False, "reason": "store_unavailable"}), 503

    body = request.get_json(silent=True) or {}
    if not isinstance(body, dict):
        return jsonify({"success": False, "reason": "invalid_body"}), 400

    patch_fields: dict[str, Any] = {}

    if "canvas_save_state" in body:
        value = body["canvas_save_state"]
        if value is not None and value not in _VALID_CANVAS_STATES:
            return (
                jsonify({
                    "success": False,
                    "reason": "invalid_canvas_save_state",
                    "allowed": sorted(_VALID_CANVAS_STATES),
                }),
                400,
            )
        patch_fields["canvas_save_state"] = value

    if "eagle_item_ids" in body:
        value = body["eagle_item_ids"]
        if not isinstance(value, list) or not all(
            isinstance(item, str) for item in value
        ):
            return (
                jsonify({
                    "success": False,
                    "reason": "invalid_eagle_item_ids",
                }),
                400,
            )
        patch_fields["eagle_item_ids"] = value

    if "output_files" in body:
        value = body["output_files"]
        if not isinstance(value, list) or not all(
            isinstance(item, str) for item in value
        ):
            return (
                jsonify({
                    "success": False,
                    "reason": "invalid_output_files",
                }),
                400,
            )
        patch_fields["output_files"] = value

    if not patch_fields:
        return (
            jsonify({
                "success": False,
                "reason": "no_patchable_fields",
                "allowed": list(_PATCHABLE_FIELDS),
            }),
            400,
        )

    try:
        updated = store.patch(record_id, patch_fields)
    except Exception as exc:
        _log_warn(f"[history] patch failed for {record_id}: {exc}")
        return jsonify({"success": False, "reason": "patch_failed"}), 500

    if updated is None:
        return jsonify({"success": False, "reason": "not_found"}), 404

    return jsonify({"success": True, "record": updated})


# ---------------------------------------------------------------------------
# POST /api/history/import  (Windsurf legacy history ingestion - Task 26)
# ---------------------------------------------------------------------------

@bp.post("/import")
def import_legacy():
    """Ingest legacy Windsurf-era JSONL history into the active store.

    Accepts either:

    * a multipart upload with a ``file`` field holding JSONL content
      (one record per line) and optional ``fallback_machine_id`` form
      field; OR
    * a JSON body ``{"path": "<absolute path to .jsonl>",
      "fallback_machine_id": "legacy-pc2"}`` pointing at a local file.

    Each input line is mapped to a ``History_Record`` (schema v1):

    * A fresh ``id`` is always generated so legacy records can never
      collide with live ones.
    * ``created_at`` is preserved when the source value parses as ISO
      8601; otherwise the current time is stamped in.
    * ``machine_id`` priority: record value > ``fallback_machine_id`` >
      literal ``"legacy"``.
    * Missing required fields are filled with safe defaults so the
      record is always valid for the rest of the pipeline.

    Responds with ``{success, imported, skipped, errors}``.

    _Requirements: 24_
    """
    store = _get_store()
    if store is None:
        return jsonify({
            "success": False,
            "reason": "store_unavailable",
            "imported": 0,
            "skipped": 0,
            "errors": [],
        }), 503

    try:
        source_iter, fallback_machine_id, source_label = _parse_import_input()
    except _ImportInputError as exc:
        return jsonify({
            "success": False,
            "reason": exc.reason,
            "message": exc.message,
            "imported": 0,
            "skipped": 0,
            "errors": [],
        }), exc.status_code

    imported = 0
    skipped = 0
    errors: list[dict] = []
    machine_id = _get_machine_id()
    t0 = time.time()

    for line_number, raw_line in source_iter:
        text = raw_line.strip() if isinstance(raw_line, str) else ""
        if not text:
            continue
        try:
            legacy = json.loads(text)
        except json.JSONDecodeError as exc:
            skipped += 1
            _append_import_error(errors, line_number, f"invalid_json: {exc.msg}")
            continue
        if not isinstance(legacy, dict):
            skipped += 1
            _append_import_error(errors, line_number, "not_an_object")
            continue

        try:
            record = _map_legacy_record(
                legacy,
                fallback_machine_id=fallback_machine_id,
                default_machine_id=machine_id,
            )
        except Exception as exc:  # pragma: no cover - defensive guard
            skipped += 1
            _append_import_error(errors, line_number, f"map_failed: {exc}")
            continue

        try:
            store.append(record)
        except Exception as exc:
            skipped += 1
            _append_import_error(errors, line_number, f"append_failed: {exc}")
            continue

        imported += 1

    _log_warn(
        f"[history] import completed source={source_label} imported={imported} "
        f"skipped={skipped} elapsed={time.time() - t0:.2f}s"
    )

    return jsonify({
        "success": True,
        "imported": imported,
        "skipped": skipped,
        "errors": errors,
    })


# ---- import helpers -------------------------------------------------------


class _ImportInputError(Exception):
    """Structured error raised while parsing the /import request envelope."""

    def __init__(self, reason: str, message: str, status_code: int = 400) -> None:
        super().__init__(message)
        self.reason = reason
        self.message = message
        self.status_code = status_code


def _parse_import_input() -> tuple[Iterable[tuple[int, str]], Optional[str], str]:
    """Return ``(line_iter, fallback_machine_id, source_label)``.

    Supports both multipart upload and JSON-body-with-path. The returned
    iterator yields ``(1-based line number, raw line)`` tuples.
    """
    upload = request.files.get("file") if request.files else None
    if upload is not None and upload.filename:
        data = upload.read(_IMPORT_MAX_FILE_BYTES + 1)
        if len(data) > _IMPORT_MAX_FILE_BYTES:
            raise _ImportInputError(
                "file_too_large",
                f"uploaded file exceeds {_IMPORT_MAX_FILE_BYTES} bytes",
                status_code=413,
            )
        fallback = (request.form.get("fallback_machine_id") or "").strip() or None
        try:
            text = data.decode("utf-8")
        except UnicodeDecodeError:
            try:
                text = data.decode("utf-8-sig")
            except UnicodeDecodeError as exc:
                raise _ImportInputError(
                    "invalid_encoding",
                    f"upload is not valid UTF-8: {exc}",
                )
        return _enumerate_lines(text), fallback, f"upload:{upload.filename}"

    body = request.get_json(silent=True) or {}
    if not isinstance(body, dict):
        raise _ImportInputError("invalid_body", "JSON body must be an object")

    raw_path = body.get("path")
    if not isinstance(raw_path, str) or not raw_path.strip():
        raise _ImportInputError(
            "missing_input",
            "provide either a multipart 'file' field or JSON body with 'path'",
        )
    path = raw_path.strip()
    if not os.path.isabs(path):
        raise _ImportInputError("path_not_absolute", f"path must be absolute: {path}")
    if not os.path.exists(path):
        raise _ImportInputError(
            "path_not_found", f"file does not exist: {path}", status_code=404
        )
    if not os.path.isfile(path):
        raise _ImportInputError("path_not_file", f"path is not a regular file: {path}")

    try:
        size = os.path.getsize(path)
    except OSError as exc:
        raise _ImportInputError("path_unreadable", f"cannot stat path: {exc}")
    if size > _IMPORT_MAX_FILE_BYTES:
        raise _ImportInputError(
            "file_too_large",
            f"file exceeds {_IMPORT_MAX_FILE_BYTES} bytes",
            status_code=413,
        )

    fallback_raw = body.get("fallback_machine_id")
    fallback = (
        fallback_raw.strip()
        if isinstance(fallback_raw, str) and fallback_raw.strip()
        else None
    )

    try:
        with open(path, "r", encoding="utf-8-sig") as fp:
            content = fp.read()
    except OSError as exc:
        raise _ImportInputError("path_unreadable", f"cannot read path: {exc}")

    return _enumerate_lines(content), fallback, f"path:{path}"


def _enumerate_lines(text: str) -> Iterable[tuple[int, str]]:
    """Yield ``(1-based line number, line)`` for every line in ``text``."""
    for idx, line in enumerate(text.splitlines(), start=1):
        yield idx, line


def _append_import_error(errors: list[dict], line: int, reason: str) -> None:
    if len(errors) >= _IMPORT_MAX_ERRORS:
        return
    errors.append({"line": line, "reason": reason})


# Matches valid ISO-8601 timestamps that datetime.fromisoformat understands
# (including optional timezone offset like +08:00 or Z).
_ISO_TZ_RE = re.compile(
    r"^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$"
)


def _map_legacy_record(
    legacy: dict,
    *,
    fallback_machine_id: Optional[str],
    default_machine_id: str,
) -> dict:
    """Map a Windsurf-era record onto the current History_Record schema.

    The mapping is intentionally permissive: any missing or malformed
    field is replaced with a safe default so the resulting record can
    be rendered by the panel.
    """
    machine_id = _first_non_empty_str(
        legacy.get("machine_id"),
        fallback_machine_id,
        "legacy",
    )

    created_at = _coerce_created_at(
        legacy.get("created_at") or legacy.get("timestamp")
    )

    raw_source = legacy.get("source")
    if isinstance(raw_source, str) and raw_source in _IMPORT_VALID_SOURCES:
        source = raw_source
        raw_source_field: Optional[str] = None
    elif raw_source in (None, ""):
        source = "unknown"
        raw_source_field = None
    else:
        source = "unknown"
        raw_source_field = str(raw_source)

    mode = legacy.get("mode")
    if not isinstance(mode, str) or mode not in _IMPORT_VALID_MODES:
        # Derive mode from reference presence when the legacy field is absent.
        refs = legacy.get("reference_images") or []
        non_empty = [r for r in refs if r] if isinstance(refs, (list, tuple)) else []
        reference_count = _coerce_int(
            legacy.get("reference_count"), default=len(non_empty)
        )
        mode = "img2img" if reference_count > 0 else "text2img"
    else:
        reference_count = _coerce_int(legacy.get("reference_count"), default=0)

    canvas_save_state_raw = legacy.get("canvas_save_state")
    canvas_save_state = (
        canvas_save_state_raw
        if isinstance(canvas_save_state_raw, str)
        and canvas_save_state_raw in _IMPORT_VALID_CANVAS_STATES
        else None
    )

    success_raw = legacy.get("success")
    if success_raw is None:
        success = True
    else:
        success = bool(success_raw)

    record: dict[str, Any] = {
        "id": _build_legacy_id(machine_id),
        "schema_version": _IMPORT_SCHEMA_VERSION,
        "created_at": created_at,
        "machine_id": machine_id,
        "source": source,
        "raw_source": raw_source_field,
        "mode": mode,
        "prompt": _coerce_optional_str(legacy.get("prompt")) or "",
        "aspect_ratio": _coerce_optional_str(legacy.get("aspect_ratio")),
        "resolution": _coerce_optional_str(legacy.get("resolution")),
        "size": _coerce_optional_str(legacy.get("size")),
        "quality": _coerce_optional_str(legacy.get("quality")),
        "provider_id": _coerce_optional_str(legacy.get("provider_id")),
        "provider_name": _coerce_optional_str(legacy.get("provider_name")),
        "model": _coerce_optional_str(legacy.get("model")),
        "count": _coerce_int(legacy.get("count"), default=1),
        "reference_count": reference_count,
        "output_files": _coerce_string_list(legacy.get("output_files")),
        "eagle_item_ids": _coerce_string_list(legacy.get("eagle_item_ids")),
        "elapsed_sec": _coerce_float(legacy.get("elapsed_sec"), default=0.0),
        "success": success,
        "error_message": _coerce_optional_str(legacy.get("error_message")),
        "canvas_save_state": canvas_save_state,
        "canvas_node_id": _coerce_optional_str(legacy.get("canvas_node_id")),
        "batch_id": _coerce_optional_str(legacy.get("batch_id")),
        "script_name": _coerce_optional_str(legacy.get("script_name")),
        # Provenance breadcrumb so operators can trace legacy rows back to
        # the Windsurf ingestion run. Extra field — ignored by readers that
        # don't know about it.
        "imported_from_legacy": True,
    }
    # Preserve the original id so imports are traceable: a second run over
    # the same dump won't literally be the same row but the original
    # identity is recoverable.
    legacy_id = legacy.get("id")
    if isinstance(legacy_id, str) and legacy_id:
        record["legacy_id"] = legacy_id

    return record


def _coerce_created_at(raw: Any) -> str:
    """Return ``raw`` as-is when it parses as ISO 8601, else a fresh timestamp."""
    if isinstance(raw, str) and raw:
        text = raw.strip()
        if _ISO_TZ_RE.match(text):
            try:
                # datetime.fromisoformat rejects a trailing 'Z' prior to 3.11,
                # so normalise it before testing.
                candidate = (
                    text.replace("Z", "+00:00") if text.endswith("Z") else text
                )
                datetime.fromisoformat(candidate)
                return text
            except ValueError:
                pass
    # numeric epoch (seconds or milliseconds) — Windsurf sometimes stored this
    if isinstance(raw, (int, float)) and raw > 0:
        try:
            ts = float(raw)
            if ts > 1e12:  # looks like milliseconds
                ts = ts / 1000.0
            return (
                datetime.fromtimestamp(ts).astimezone().isoformat(timespec="seconds")
            )
        except (OverflowError, OSError, ValueError):
            pass
    return datetime.now().astimezone().isoformat(timespec="seconds")


def _build_legacy_id(machine_id: str) -> str:
    safe = (str(machine_id or "").strip() or "legacy").replace(" ", "_")
    return f"{safe}-{int(time.time() * 1000)}-{secrets.token_hex(3)}"


def _first_non_empty_str(*values: Any) -> str:
    for value in values:
        if isinstance(value, str):
            stripped = value.strip()
            if stripped:
                return stripped
    return "legacy"


def _coerce_optional_str(value: Any) -> Optional[str]:
    if value is None:
        return None
    if isinstance(value, str):
        stripped = value.strip()
        return stripped or None
    text = str(value)
    return text or None


def _coerce_int(value: Any, *, default: int) -> int:
    if isinstance(value, bool):  # bool is subclass of int, but nonsensical here
        return default
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _coerce_float(value: Any, *, default: float) -> float:
    if isinstance(value, bool):
        return default
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _coerce_string_list(value: Any) -> list[str]:
    if not isinstance(value, (list, tuple)):
        return []
    return [str(v) for v in value if v is not None and str(v) != ""]


# ---------------------------------------------------------------------------
# GET /api/history/config
# ---------------------------------------------------------------------------

@bp.get("/config")
def get_config():
    """Expose the effective runtime configuration for the history subsystem."""
    return jsonify({
        "success": True,
        "machine_id": _get_machine_id(),
        "peer_machines": _get_peer_machines(),
        "history_store_path": _get_history_path(),
        "history_store_max_mb": _get_history_max_mb(),
    })
