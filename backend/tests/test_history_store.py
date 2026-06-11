"""
Unit tests for ``backend/history_store.py``.

Covers:
* Concurrent append of many records preserves completeness and line atomicity
* Reverse-order filtered reads and pagination
* In-place patch: existing record, missing record, invalid id
* Size-based rotation
* Corrupted line handling (skipped + surfaced via warnings)
* Over-long records (>4 KiB) taking the tempfile+rename fallback
"""

from __future__ import annotations

import json
import os
import threading

import pytest

from history_store import HistoryStore


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------


def _make_record(idx: int, **overrides) -> dict:
    record = {
        "id": f"pc1-{1700000000000 + idx}-{idx:06x}",
        "schema_version": "1",
        "created_at": f"2026-05-09T10:{idx % 60:02d}:00+08:00",
        "machine_id": "pc1",
        "source": "canvas",
        "mode": "text2img",
        "prompt": f"hello world {idx}",
        "provider_id": "gpt-image",
        "count": 1,
        "reference_count": 0,
        "output_files": [],
        "eagle_item_ids": [],
        "elapsed_sec": 1.23,
        "success": True,
        "error_message": None,
        "canvas_save_state": "canvas_unsaved",
        "batch_id": None,
    }
    record.update(overrides)
    return record


def _read_all_lines(path: str) -> list[dict]:
    with open(path, "r", encoding="utf-8") as f:
        return [json.loads(line) for line in f if line.strip()]


# ---------------------------------------------------------------------------
# append + read
# ---------------------------------------------------------------------------


def test_append_creates_parent_directory(tmp_path):
    path = tmp_path / "nested" / "deeper" / "generation_history.jsonl"
    store = HistoryStore(str(path))
    store.append(_make_record(1))
    assert path.exists()
    assert _read_all_lines(str(path))[0]["id"].startswith("pc1-")


def test_concurrent_append_preserves_all_records(jsonl_path):
    """Spin up 10 threads writing 10 records each and verify the file has
    exactly 100 valid JSON lines with no interleaving."""
    store = HistoryStore(jsonl_path)
    total = 100
    threads_count = 10
    per_thread = total // threads_count

    def worker(thread_idx: int) -> None:
        for j in range(per_thread):
            store.append(_make_record(thread_idx * per_thread + j,
                                      prompt=f"t{thread_idx}-p{j}"))

    threads = [threading.Thread(target=worker, args=(i,))
               for i in range(threads_count)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    records = _read_all_lines(jsonl_path)
    assert len(records) == total
    ids = {r["id"] for r in records}
    assert len(ids) == total, "duplicate ids detected, writes interleaved"


def test_read_page_returns_newest_first(jsonl_path):
    store = HistoryStore(jsonl_path)
    for i in range(5):
        store.append(_make_record(i, prompt=f"prompt-{i}"))

    records, total, has_more, warnings = store.read_page(limit=10, offset=0)
    assert total == 5
    assert has_more is False
    assert warnings == []
    # newest first => last appended (idx=4) comes first
    assert [r["prompt"] for r in records] == [
        "prompt-4", "prompt-3", "prompt-2", "prompt-1", "prompt-0"
    ]


def test_read_page_pagination_and_has_more(jsonl_path):
    store = HistoryStore(jsonl_path)
    for i in range(12):
        store.append(_make_record(i))

    page1, total1, more1, _ = store.read_page(limit=5, offset=0)
    assert len(page1) == 5
    assert total1 == 12
    assert more1 is True

    page2, total2, more2, _ = store.read_page(limit=5, offset=5)
    assert len(page2) == 5
    assert total2 == 12
    assert more2 is True

    page3, total3, more3, _ = store.read_page(limit=5, offset=10)
    assert len(page3) == 2
    assert total3 == 12
    assert more3 is False


def test_iter_filtered_by_source(jsonl_path):
    store = HistoryStore(jsonl_path)
    store.append(_make_record(0, source="canvas"))
    store.append(_make_record(1, source="eagle_plugin"))
    store.append(_make_record(2, source="script"))

    only_canvas = list(store.iter_filtered(source="canvas"))
    assert len(only_canvas) == 1
    assert only_canvas[0]["source"] == "canvas"


def test_iter_filtered_by_keyword_case_insensitive(jsonl_path):
    store = HistoryStore(jsonl_path)
    store.append(_make_record(0, prompt="A beautiful SUNSET"))
    store.append(_make_record(1, prompt="cats and dogs"))
    store.append(_make_record(2, prompt="sunset BLVD"))

    hits = list(store.iter_filtered(keyword="sunset"))
    assert len(hits) == 2


def test_iter_filtered_by_date_range(jsonl_path):
    store = HistoryStore(jsonl_path)
    store.append(_make_record(0, created_at="2026-05-01T10:00:00+08:00"))
    store.append(_make_record(1, created_at="2026-05-05T10:00:00+08:00"))
    store.append(_make_record(2, created_at="2026-05-10T10:00:00+08:00"))

    hits = list(store.iter_filtered(
        date_from="2026-05-03T00:00:00+08:00",
        date_to="2026-05-08T00:00:00+08:00",
    ))
    assert len(hits) == 1
    assert hits[0]["created_at"].startswith("2026-05-05")


def test_empty_file_returns_empty_page(jsonl_path):
    store = HistoryStore(jsonl_path)
    # Don't even create the file
    records, total, has_more, warnings = store.read_page(limit=10)
    assert records == []
    assert total == 0
    assert has_more is False
    assert warnings == []


# ---------------------------------------------------------------------------
# corrupted line handling
# ---------------------------------------------------------------------------


def test_corrupted_line_is_skipped_and_reported(jsonl_path):
    store = HistoryStore(jsonl_path)
    store.append(_make_record(0))
    # inject a garbage line
    with open(jsonl_path, "a", encoding="utf-8") as f:
        f.write("{not: valid json\n")
    store.append(_make_record(1))

    records, total, has_more, warnings = store.read_page(limit=10)
    assert total == 2  # two valid records
    assert len(records) == 2
    assert any("parse_error_line_" in w for w in warnings)


def test_non_dict_json_line_is_skipped(jsonl_path):
    store = HistoryStore(jsonl_path)
    store.append(_make_record(0))
    with open(jsonl_path, "a", encoding="utf-8") as f:
        f.write("[1, 2, 3]\n")  # valid JSON but not a dict
    store.append(_make_record(1))

    records, total, _has_more, warnings = store.read_page(limit=10)
    assert total == 2
    assert any("parse_error_line_" in w for w in warnings)


# ---------------------------------------------------------------------------
# patch
# ---------------------------------------------------------------------------


def test_patch_existing_record_updates_fields(jsonl_path):
    store = HistoryStore(jsonl_path)
    store.append(_make_record(0))
    store.append(_make_record(1))
    store.append(_make_record(2))

    target_id = _make_record(1)["id"]
    updated = store.patch(target_id, {
        "canvas_save_state": "canvas_saved",
        "eagle_item_ids": ["ABC"],
    })
    assert updated is not None
    assert updated["canvas_save_state"] == "canvas_saved"
    assert updated["eagle_item_ids"] == ["ABC"]

    # file should still have 3 records in original order
    lines = _read_all_lines(jsonl_path)
    assert len(lines) == 3
    assert lines[1]["id"] == target_id
    assert lines[1]["canvas_save_state"] == "canvas_saved"
    assert lines[1]["eagle_item_ids"] == ["ABC"]
    # other rows untouched
    assert lines[0]["canvas_save_state"] == "canvas_unsaved"
    assert lines[2]["canvas_save_state"] == "canvas_unsaved"


def test_patch_missing_record_returns_none(jsonl_path):
    store = HistoryStore(jsonl_path)
    store.append(_make_record(0))
    result = store.patch("pc1-does-not-exist", {"canvas_save_state": "canvas_saved"})
    assert result is None
    # file still intact
    assert len(_read_all_lines(jsonl_path)) == 1


def test_patch_on_nonexistent_file_returns_none(tmp_path):
    store = HistoryStore(str(tmp_path / "missing.jsonl"))
    assert store.patch("whatever", {"canvas_save_state": "canvas_saved"}) is None


def test_patch_empty_id_returns_none(jsonl_path):
    store = HistoryStore(jsonl_path)
    store.append(_make_record(0))
    assert store.patch("", {"canvas_save_state": "canvas_saved"}) is None


def test_find_by_id_returns_record_after_append(jsonl_path):
    store = HistoryStore(jsonl_path)
    store.append(_make_record(0))
    store.append(_make_record(1))
    target_id = _make_record(1)["id"]
    found = store.find_by_id(target_id)
    assert found is not None
    assert found["id"] == target_id


def test_find_by_id_missing_returns_none(jsonl_path):
    store = HistoryStore(jsonl_path)
    store.append(_make_record(0))
    assert store.find_by_id("nope") is None


# ---------------------------------------------------------------------------
# rotation
# ---------------------------------------------------------------------------


def test_rotation_triggers_when_file_exceeds_max_mb(tmp_path):
    path = tmp_path / "generation_history.jsonl"
    # Pre-populate the file with > 1 MiB of data so the next append triggers rotation.
    path.write_bytes(b'{"id":"old","prompt":"x"}\n' * 80000)
    assert path.stat().st_size > 1024 * 1024

    store = HistoryStore(str(path), max_mb=1)
    store.append(_make_record(999, prompt="after-rotation"))

    # Original file should now contain just the new record.
    remaining = _read_all_lines(str(path))
    assert len(remaining) == 1
    assert remaining[0]["prompt"] == "after-rotation"

    # A rotated archive file must exist alongside.
    siblings = [p.name for p in tmp_path.iterdir() if p.name != path.name]
    rotated = [n for n in siblings
               if n.startswith("generation_history.") and n.endswith(".jsonl")]
    assert rotated, f"expected a rotated archive, got: {siblings}"


def test_rotation_disabled_when_max_mb_zero(tmp_path):
    path = tmp_path / "generation_history.jsonl"
    path.write_bytes(b'{"id":"old","prompt":"x"}\n' * 80000)
    original_size = path.stat().st_size

    store = HistoryStore(str(path), max_mb=0)
    store.append(_make_record(1))

    # File kept growing, no sibling archive
    assert path.stat().st_size > original_size
    siblings = [p.name for p in tmp_path.iterdir() if p.name != path.name]
    assert siblings == []


# ---------------------------------------------------------------------------
# over-long record fallback (tempfile + rename)
# ---------------------------------------------------------------------------


def test_long_record_uses_tempfile_path(jsonl_path):
    store = HistoryStore(jsonl_path)
    # Pre-existing lines must survive the tempfile-based rewrite.
    store.append(_make_record(0, prompt="short-a"))
    store.append(_make_record(1, prompt="short-b"))

    huge_prompt = "x" * 6000  # definitely >4 KiB after JSON encoding
    store.append(_make_record(2, prompt=huge_prompt))

    records = _read_all_lines(jsonl_path)
    assert len(records) == 3
    assert records[0]["prompt"] == "short-a"
    assert records[1]["prompt"] == "short-b"
    assert records[2]["prompt"] == huge_prompt

    # No leftover temp files from the rename dance.
    leftovers = [p.name for p in os.scandir(os.path.dirname(jsonl_path))
                 if p.name.endswith(".tmp")]
    assert leftovers == []
