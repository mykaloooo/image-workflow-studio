"""
backend/history_store.py

JSON Lines store for Generation History records. Pure I/O layer, no Flask
dependency so it can be unit-tested in isolation.

Responsibilities
----------------
* Atomic append of a single record per line (thread-safe).
* Filtered read with reverse (newest-first) scan.
* Paginated read that returns total / has_more / per-line parse warnings.
* In-place line patch via tempfile + os.replace.
* Size-based rotation to ``generation_history.YYYYMMDD-HHMMSS.jsonl``.
* In-memory ``(byte_offset, record_id)`` index cache for fast id lookup
  (used by the thumbnail / patch endpoints).

The class is defensive by design: read paths never raise on a corrupted
line, they surface the line number in a ``warnings`` list and move on.

This module is imported by ``history_recorder.py`` and ``history_api.py``
in Phase 1 of the generation-history-unified-panel feature.

Requirements covered
--------------------
* Requirement 5  - local JSONL storage, directory auto-create, rotation
* Requirement 6.1-6.2 - machine_id is stored as part of the record (caller
  supplies it, store is agnostic)
* Requirement 7.10 - return warnings for bad JSON lines
* Requirement 9   - in-place patch preserving line order
* Requirement 21  - concurrent-write safety + flush to disk + retry
"""

from __future__ import annotations

import json
import os
import secrets
import tempfile
import threading
import time
from datetime import datetime
from typing import Any, Iterator, Optional


# A single O_APPEND write is atomic on both Linux and Windows as long as the
# buffer is below the OS pipe-buffer / filesystem-block threshold. 4 KiB is a
# conservative lower bound that is safe everywhere. Records that exceed this
# (typically due to very long prompts) fall back to a tempfile-rename path.
_SAFE_APPEND_MAX_BYTES = 4096

_RETRY_ATTEMPTS = 3
_RETRY_DELAY_SEC = 0.1


class HistoryStore:
    """JSON Lines store for ``History_Record`` entries."""

    # ------------------------------------------------------------------ init
    def __init__(self, path: str, max_mb: int = 50) -> None:
        """Create a store bound to ``path``.

        ``max_mb`` is the rotation threshold in megabytes. Pass ``0`` or a
        negative value to disable rotation entirely.
        """
        self.path = path
        self.max_mb = max_mb
        self._write_lock = threading.Lock()
        # Each entry is ``(byte_offset, record_id)`` in file order.
        self._index_cache: Optional[list[tuple[int, str]]] = None
        self._index_mtime: Optional[float] = None

    # ------------------------------------------------------------- helpers
    def _ensure_dir(self) -> None:
        directory = os.path.dirname(os.path.abspath(self.path))
        if directory and not os.path.isdir(directory):
            os.makedirs(directory, exist_ok=True)

    def _file_size(self) -> int:
        try:
            return os.path.getsize(self.path)
        except OSError:
            return 0

    def _invalidate_index(self) -> None:
        self._index_cache = None
        self._index_mtime = None

    # ------------------------------------------------------------ rotation
    def rotate_if_needed(self) -> bool:
        """Rename the current file if it grew past ``max_mb``.

        Returns ``True`` when a rotation happened. The rotated file is named
        ``<base>.YYYYMMDD-HHMMSS.jsonl`` alongside the original; on the rare
        chance of a timestamp collision a short random suffix is appended.
        """
        if self.max_mb is None or self.max_mb <= 0:
            return False
        if self._file_size() < self.max_mb * 1024 * 1024:
            return False

        base, ext = os.path.splitext(self.path)
        if not ext:
            ext = ".jsonl"
        ts = datetime.now().strftime("%Y%m%d-%H%M%S")
        rotated = f"{base}.{ts}{ext}"
        if os.path.exists(rotated):
            rotated = f"{base}.{ts}-{secrets.token_hex(2)}{ext}"
        try:
            os.replace(self.path, rotated)
        except OSError:
            return False
        self._invalidate_index()
        return True

    # --------------------------------------------------------------- append
    def append(self, record: dict) -> None:
        """Serialize ``record`` and append it as a single JSONL line.

        Thread-safe. Performs up to 3 retries (100 ms apart) on transient
        ``OSError`` - typically caused by another process briefly holding
        the file on Windows. On persistent failure the error propagates.
        """
        self._ensure_dir()
        line = json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n"
        data = line.encode("utf-8")

        with self._write_lock:
            # Rotate first so a freshly-rotated file begins with this record.
            self.rotate_if_needed()

            last_err: Optional[OSError] = None
            for attempt in range(_RETRY_ATTEMPTS):
                try:
                    if len(data) < _SAFE_APPEND_MAX_BYTES:
                        self._atomic_append(data)
                    else:
                        # Over-long record: rebuild via tempfile to avoid
                        # partial interleaving with concurrent writers.
                        self._append_via_tempfile(data)
                    last_err = None
                    break
                except OSError as exc:
                    last_err = exc
                    if attempt + 1 < _RETRY_ATTEMPTS:
                        time.sleep(_RETRY_DELAY_SEC)
            if last_err is not None:
                raise last_err

            # Incrementally keep the index cache warm when it was already
            # built. Otherwise a subsequent find_by_id() call will trigger a
            # full rebuild lazily.
            if self._index_cache is not None:
                try:
                    offset = self._file_size() - len(data)
                    rec_id = record.get("id")
                    if isinstance(rec_id, str) and offset >= 0:
                        self._index_cache.append((offset, rec_id))
                    self._index_mtime = os.path.getmtime(self.path)
                except OSError:
                    self._invalidate_index()

    def _atomic_append(self, data: bytes) -> None:
        flags = os.O_WRONLY | os.O_CREAT | os.O_APPEND
        if hasattr(os, "O_BINARY"):
            flags |= os.O_BINARY  # pragma: no cover (Windows-only flag)
        fd = os.open(self.path, flags, 0o644)
        try:
            written = 0
            while written < len(data):
                n = os.write(fd, data[written:])
                if n <= 0:
                    raise OSError("short write while appending history record")
                written += n
            try:
                os.fsync(fd)
            except OSError:
                # fsync may fail on some network filesystems; that's tolerable
                pass
        finally:
            os.close(fd)

    def _append_via_tempfile(self, data: bytes) -> None:
        directory = os.path.dirname(os.path.abspath(self.path)) or "."
        tmp_fd, tmp_path = tempfile.mkstemp(
            prefix=".history-", suffix=".tmp", dir=directory
        )
        try:
            with os.fdopen(tmp_fd, "wb") as tmp:
                if os.path.exists(self.path):
                    with open(self.path, "rb") as src:
                        while True:
                            chunk = src.read(1024 * 1024)
                            if not chunk:
                                break
                            tmp.write(chunk)
                tmp.write(data)
                tmp.flush()
                try:
                    os.fsync(tmp.fileno())
                except OSError:
                    pass
            os.replace(tmp_path, self.path)
        except Exception:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass
            raise

    # ------------------------------------------------------------ read API
    def iter_filtered(self, **filters: Any) -> Iterator[dict]:
        """Yield matching records, newest first. Bad lines are silently skipped."""
        for record, warning in self._iter_records_reverse(filters):
            if warning is None and record is not None:
                yield record

    def read_page(
        self,
        filters: Optional[dict] = None,
        limit: int = 100,
        offset: int = 0,
    ) -> tuple[list[dict], int, bool, list[str]]:
        """Return ``(records, total, has_more, warnings)``.

        * ``records`` - up to ``limit`` matching records starting at ``offset``
          (newest first).
        * ``total`` - number of records that match ``filters`` across the
          whole file.
        * ``has_more`` - True when ``total > offset + len(records)``.
        * ``warnings`` - line numbers (1-based) that failed to parse, formatted
          as ``parse_error_line_<n>``.
        """
        filters = dict(filters or {})
        try:
            limit = int(limit)
        except (TypeError, ValueError):
            limit = 0
        try:
            offset = int(offset)
        except (TypeError, ValueError):
            offset = 0
        limit = max(0, limit)
        offset = max(0, offset)

        matched: list[dict] = []
        warnings: list[str] = []
        count_seen = 0

        for record, warning in self._iter_records_reverse(filters):
            if warning is not None:
                warnings.append(warning)
                continue
            if record is None:
                continue
            count_seen += 1
            if count_seen <= offset:
                continue
            if len(matched) < limit:
                matched.append(record)
            # keep counting so has_more / total are accurate

        has_more = count_seen > offset + len(matched)
        return matched, count_seen, has_more, warnings

    def _iter_records_reverse(
        self, filters: dict
    ) -> Iterator[tuple[Optional[dict], Optional[str]]]:
        """Reverse-order iterator yielding ``(record, warning)`` tuples.

        Reads the whole file into memory. Given the 50 MB rotation
        threshold this stays within a few tens of MB at most and keeps the
        implementation simple for the Phase-1 scope.
        """
        if not os.path.exists(self.path):
            return
        try:
            with open(self.path, "rb") as f:
                raw = f.read()
        except OSError:
            return
        if not raw:
            return

        lines = raw.split(b"\n")
        # ``split`` on a trailing newline leaves an empty final element; drop it.
        if lines and lines[-1] == b"":
            lines.pop()

        for idx in range(len(lines) - 1, -1, -1):
            line = lines[idx]
            if not line.strip():
                continue
            line_number = idx + 1
            try:
                record = json.loads(line.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError):
                yield None, f"parse_error_line_{line_number}"
                continue
            if not isinstance(record, dict):
                yield None, f"parse_error_line_{line_number}"
                continue
            if _match_filters(record, filters):
                yield record, None

    # ---------------------------------------------------------------- index
    def rebuild_index(self) -> None:
        """Rebuild ``_index_cache`` by scanning the file top-to-bottom."""
        cache: list[tuple[int, str]] = []
        if not os.path.exists(self.path):
            self._index_cache = cache
            self._index_mtime = None
            return
        try:
            with open(self.path, "rb") as f:
                offset = 0
                while True:
                    start = offset
                    line = f.readline()
                    if not line:
                        break
                    offset += len(line)
                    stripped = line.strip()
                    if not stripped:
                        continue
                    try:
                        record = json.loads(stripped.decode("utf-8"))
                    except (UnicodeDecodeError, json.JSONDecodeError):
                        continue
                    if isinstance(record, dict):
                        rec_id = record.get("id")
                        if isinstance(rec_id, str):
                            cache.append((start, rec_id))
        except OSError:
            pass
        self._index_cache = cache
        try:
            self._index_mtime = os.path.getmtime(self.path)
        except OSError:
            self._index_mtime = None

    def _ensure_index(self) -> None:
        try:
            mtime = os.path.getmtime(self.path)
        except OSError:
            mtime = None
        if self._index_cache is None or mtime != self._index_mtime:
            self.rebuild_index()

    def find_by_id(self, record_id: str) -> Optional[dict]:
        """Return the record with ``id == record_id`` or ``None``."""
        if not record_id or not os.path.exists(self.path):
            return None
        self._ensure_index()
        if not self._index_cache:
            return None
        # Scan newest-first for better hit locality (recent ids are queried
        # more often by the thumbnail endpoint).
        for offset, rid in reversed(self._index_cache):
            if rid == record_id:
                rec = self._read_line_at(offset)
                if rec is not None:
                    return rec
        return None

    def _read_line_at(self, offset: int) -> Optional[dict]:
        try:
            with open(self.path, "rb") as f:
                f.seek(offset)
                line = f.readline()
        except OSError:
            return None
        stripped = line.strip()
        if not stripped:
            return None
        try:
            rec = json.loads(stripped.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            return None
        return rec if isinstance(rec, dict) else None

    # ---------------------------------------------------------------- patch
    def patch(
        self, record_id: str, patch_fields: dict
    ) -> Optional[dict]:
        """Update the first record with ``id == record_id``.

        Returns the updated record, or ``None`` if no matching id exists.
        The rewrite is atomic (tempfile + ``os.replace``) and preserves
        the original line order so pagination by age stays stable.
        """
        if not record_id:
            return None
        patch_fields = dict(patch_fields or {})

        with self._write_lock:
            if not os.path.exists(self.path):
                return None

            directory = os.path.dirname(os.path.abspath(self.path)) or "."
            tmp_fd, tmp_path = tempfile.mkstemp(
                prefix=".history-", suffix=".tmp", dir=directory
            )
            updated_record: Optional[dict] = None
            try:
                with os.fdopen(tmp_fd, "wb") as tmp, open(self.path, "rb") as src:
                    for raw_line in src:
                        stripped = raw_line.rstrip(b"\r\n")
                        if not stripped:
                            tmp.write(raw_line)
                            continue
                        try:
                            record = json.loads(stripped.decode("utf-8"))
                        except (UnicodeDecodeError, json.JSONDecodeError):
                            tmp.write(raw_line)
                            continue
                        if (
                            isinstance(record, dict)
                            and record.get("id") == record_id
                            and updated_record is None
                        ):
                            record.update(patch_fields)
                            updated_record = record
                            new_bytes = (
                                json.dumps(
                                    record,
                                    ensure_ascii=False,
                                    separators=(",", ":"),
                                )
                                + "\n"
                            ).encode("utf-8")
                            tmp.write(new_bytes)
                        else:
                            tmp.write(raw_line)
                    tmp.flush()
                    try:
                        os.fsync(tmp.fileno())
                    except OSError:
                        pass
                if updated_record is None:
                    try:
                        os.unlink(tmp_path)
                    except OSError:
                        pass
                    return None
                os.replace(tmp_path, self.path)
                self._invalidate_index()
                return updated_record
            except Exception:
                try:
                    os.unlink(tmp_path)
                except OSError:
                    pass
                raise


# ---------------------------------------------------------------------------
# filter helpers
# ---------------------------------------------------------------------------


_EQUALITY_FILTER_KEYS = (
    "source",
    "mode",
    "provider_id",
    "canvas_save_state",
    "batch_id",
    "machine_id",
)


def _match_filters(record: dict, filters: dict) -> bool:
    """Return True when ``record`` matches every non-empty filter entry."""
    if not filters:
        return True

    for key in _EQUALITY_FILTER_KEYS:
        expected = filters.get(key)
        if expected in (None, ""):
            continue
        actual = record.get(key)
        if isinstance(expected, (list, tuple, set)):
            if actual not in expected:
                return False
        elif actual != expected:
            return False

    keyword = filters.get("keyword")
    if keyword:
        prompt = record.get("prompt") or ""
        if not isinstance(prompt, str):
            prompt = str(prompt)
        if str(keyword).lower() not in prompt.lower():
            return False

    # created_at is an ISO 8601 string with tz offset; lexical compare is a
    # correct ordering within a single machine's records.
    date_from = filters.get("date_from")
    if date_from:
        created = record.get("created_at") or ""
        if created < date_from:
            return False
    date_to = filters.get("date_to")
    if date_to:
        created = record.get("created_at") or ""
        if created > date_to:
            return False

    success = filters.get("success")
    if success is not None and bool(record.get("success")) is not bool(success):
        return False

    return True
