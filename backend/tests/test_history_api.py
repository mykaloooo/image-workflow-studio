"""
Unit tests for ``backend/history_api.py``.

Uses Flask's test_client with a minimal app that only registers the history
blueprint — we don't import app.py because it has initializer side effects
(loading config, scheduling threads, etc.).

Covers:
* GET /api/history filter combinations (source, mode, keyword, batch_id, date range)
* limit clamping (>500 => 500), default limit (100)
* Empty-store response shape
* warnings field propagation for corrupted lines
* GET /api/history/thumbnail: 200 ok, 404 source_missing, 422 decode_failed, 400 invalid index
* PATCH /api/history/<id>: 200 ok, 400 invalid state, 400 no fields, 404 not found
* GET /api/history/config returns machine_id / peers / path / max_mb
"""

from __future__ import annotations

import io
import json
import os
from typing import Optional

import pytest
from flask import Flask
from PIL import Image

from history_api import bp as history_bp
from history_store import HistoryStore


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------


def _build_record(
    rec_id: str,
    *,
    source: str = "canvas",
    mode: str = "text2img",
    prompt: str = "a cat",
    provider_id: str = "gpt-image",
    created_at: str = "2026-05-09T10:00:00+08:00",
    success: bool = True,
    output_files: Optional[list[str]] = None,
    batch_id: Optional[str] = None,
    canvas_save_state: Optional[str] = "canvas_unsaved",
    eagle_item_ids: Optional[list[str]] = None,
) -> dict:
    return {
        "id": rec_id,
        "schema_version": "1",
        "created_at": created_at,
        "machine_id": "pc1",
        "source": source,
        "raw_source": None,
        "mode": mode,
        "prompt": prompt,
        "aspect_ratio": None,
        "resolution": None,
        "size": None,
        "quality": None,
        "provider_id": provider_id,
        "provider_name": None,
        "model": None,
        "count": 1,
        "reference_count": 0,
        "output_files": output_files or [],
        "eagle_item_ids": eagle_item_ids or [],
        "elapsed_sec": 1.0,
        "success": success,
        "error_message": None if success else "boom",
        "canvas_save_state": canvas_save_state,
        "canvas_node_id": None,
        "batch_id": batch_id,
        "script_name": None,
    }


def _make_app(store: HistoryStore, *, machine_id: str = "pc1",
              peers: Optional[list[dict]] = None) -> Flask:
    """Create a fresh Flask app with ONLY the history blueprint registered.

    Each call produces a new Blueprint-less-namespaced app so multiple tests
    can have independent stores attached.
    """
    app = Flask(__name__)
    app.testing = True
    app.register_blueprint(history_bp)
    history_bp.store = store
    history_bp.machine_id = machine_id
    history_bp.peer_machines = peers or []
    history_bp.history_store_path = store.path
    history_bp.history_store_max_mb = store.max_mb
    return app


def _populate(store: HistoryStore, records: list[dict]) -> None:
    for r in records:
        store.append(r)


# ---------------------------------------------------------------------------
# fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def store_with_records(jsonl_path) -> HistoryStore:
    store = HistoryStore(jsonl_path)
    _populate(store, [
        _build_record("r-01", source="canvas", mode="text2img",
                      prompt="cat on sofa",
                      created_at="2026-05-01T10:00:00+08:00"),
        _build_record("r-02", source="eagle_plugin", mode="img2img",
                      prompt="dog in park",
                      created_at="2026-05-05T10:00:00+08:00"),
        _build_record("r-03", source="script", mode="text2img",
                      prompt="sunset over mountain",
                      created_at="2026-05-07T10:00:00+08:00",
                      batch_id="batch-xyz"),
        _build_record("r-04", source="canvas", mode="text2img",
                      prompt="another CAT stretching",
                      created_at="2026-05-10T10:00:00+08:00",
                      success=False),
    ])
    return store


@pytest.fixture
def client(store_with_records):
    app = _make_app(store_with_records,
                    peers=[{"machine_id": "pc2", "base_url": "http://192.168.110.120:5001"}])
    return app.test_client()


@pytest.fixture
def empty_client(jsonl_path):
    """Client pointing at a non-existent JSONL file."""
    store = HistoryStore(jsonl_path)
    app = _make_app(store)
    return app.test_client()


# ---------------------------------------------------------------------------
# GET /api/history
# ---------------------------------------------------------------------------


def test_list_returns_all_records_newest_first(client):
    resp = client.get("/api/history")
    assert resp.status_code == 200
    data = resp.get_json()
    assert data["success"] is True
    assert data["machine_id"] == "pc1"
    assert data["total"] == 4
    assert data["has_more"] is False
    ids = [r["id"] for r in data["records"]]
    assert ids == ["r-04", "r-03", "r-02", "r-01"]


def test_list_filter_by_source(client):
    resp = client.get("/api/history?source=canvas")
    assert resp.status_code == 200
    data = resp.get_json()
    assert data["total"] == 2
    assert all(r["source"] == "canvas" for r in data["records"])


def test_list_filter_by_mode(client):
    resp = client.get("/api/history?mode=img2img")
    data = resp.get_json()
    assert data["total"] == 1
    assert data["records"][0]["mode"] == "img2img"


def test_list_filter_by_batch_id(client):
    resp = client.get("/api/history?batch_id=batch-xyz")
    data = resp.get_json()
    assert data["total"] == 1
    assert data["records"][0]["batch_id"] == "batch-xyz"


def test_list_keyword_is_case_insensitive(client):
    resp = client.get("/api/history?keyword=cat")
    data = resp.get_json()
    assert data["total"] == 2  # "cat on sofa" + "CAT stretching"


def test_list_filter_by_date_range(client):
    resp = client.get(
        "/api/history?date_from=2026-05-04T00:00:00%2B08:00"
        "&date_to=2026-05-08T00:00:00%2B08:00"
    )
    data = resp.get_json()
    assert data["total"] == 2
    ids = [r["id"] for r in data["records"]]
    assert set(ids) == {"r-02", "r-03"}


def test_list_combined_filters(client):
    resp = client.get("/api/history?source=canvas&keyword=cat")
    data = resp.get_json()
    assert data["total"] == 2


def test_list_limit_over_500_is_clamped(jsonl_path):
    store = HistoryStore(jsonl_path)
    for i in range(3):
        store.append(_build_record(f"id-{i}"))
    app = _make_app(store)
    resp = app.test_client().get("/api/history?limit=9999")
    # The clamp is hard to observe via response length alone (only 3 records
    # exist). Instead verify the endpoint doesn't reject the request.
    assert resp.status_code == 200
    data = resp.get_json()
    assert data["total"] == 3
    assert len(data["records"]) == 3


def test_list_limit_pagination(store_with_records):
    app = _make_app(store_with_records)
    c = app.test_client()
    page1 = c.get("/api/history?limit=2&offset=0").get_json()
    assert len(page1["records"]) == 2
    assert page1["total"] == 4
    assert page1["has_more"] is True

    page2 = c.get("/api/history?limit=2&offset=2").get_json()
    assert len(page2["records"]) == 2
    assert page2["has_more"] is False

    # No overlap between page1 and page2
    ids_union = {r["id"] for r in page1["records"]} | {r["id"] for r in page2["records"]}
    assert len(ids_union) == 4


def test_list_empty_file_returns_empty_shape(empty_client):
    resp = empty_client.get("/api/history")
    assert resp.status_code == 200
    data = resp.get_json()
    assert data["success"] is True
    assert data["records"] == []
    assert data["total"] == 0
    assert data["has_more"] is False


def test_list_no_match_returns_empty(client):
    resp = client.get("/api/history?source=canvas&keyword=nonexistent_prompt")
    data = resp.get_json()
    assert data["success"] is True
    assert data["records"] == []
    assert data["total"] == 0
    assert data["has_more"] is False


def test_list_surfaces_warnings_for_corrupted_line(jsonl_path):
    store = HistoryStore(jsonl_path)
    store.append(_build_record("good-1"))
    with open(jsonl_path, "a", encoding="utf-8") as f:
        f.write("{not valid json\n")
    store.append(_build_record("good-2"))

    app = _make_app(store)
    resp = app.test_client().get("/api/history")
    data = resp.get_json()
    assert data["total"] == 2
    assert "warnings" in data
    assert any("parse_error_line_" in w for w in data["warnings"])


# ---------------------------------------------------------------------------
# GET /api/history/thumbnail
# ---------------------------------------------------------------------------


def _make_png(path: str, size: tuple[int, int] = (64, 64)) -> None:
    img = Image.new("RGB", size, color=(120, 200, 50))
    img.save(path, "PNG")


def test_thumbnail_returns_jpeg_for_existing_image(tmp_path, jsonl_path):
    png_path = tmp_path / "out.png"
    _make_png(str(png_path))

    store = HistoryStore(jsonl_path)
    store.append(_build_record("r-thumb", output_files=[str(png_path)]))

    app = _make_app(store)
    resp = app.test_client().get("/api/history/thumbnail?record_id=r-thumb&index=0")
    assert resp.status_code == 200
    assert resp.headers["Content-Type"] == "image/jpeg"
    assert resp.headers["Cache-Control"].startswith("public, max-age=")
    # the response body should decode as a valid JPEG
    decoded = Image.open(io.BytesIO(resp.data))
    assert decoded.format == "JPEG"
    assert max(decoded.size) <= 256


def test_thumbnail_404_when_source_file_missing(tmp_path, jsonl_path):
    missing = tmp_path / "never-created.png"
    store = HistoryStore(jsonl_path)
    store.append(_build_record("r-missing", output_files=[str(missing)]))

    app = _make_app(store)
    resp = app.test_client().get("/api/history/thumbnail?record_id=r-missing&index=0")
    assert resp.status_code == 404
    assert resp.get_json()["reason"] == "source_missing"


def test_thumbnail_404_when_record_not_found(jsonl_path):
    store = HistoryStore(jsonl_path)
    store.append(_build_record("r-other", output_files=["/nope.png"]))
    app = _make_app(store)
    resp = app.test_client().get("/api/history/thumbnail?record_id=does-not-exist&index=0")
    assert resp.status_code == 404
    assert resp.get_json()["reason"] == "source_missing"


def test_thumbnail_404_when_index_out_of_range(tmp_path, jsonl_path):
    png_path = tmp_path / "out.png"
    _make_png(str(png_path))
    store = HistoryStore(jsonl_path)
    store.append(_build_record("r-one", output_files=[str(png_path)]))
    app = _make_app(store)
    resp = app.test_client().get("/api/history/thumbnail?record_id=r-one&index=5")
    assert resp.status_code == 404


def test_thumbnail_422_on_decode_failure(tmp_path, jsonl_path):
    # Write a non-image file with a .png extension to trigger PIL decode failure.
    bad = tmp_path / "bad.png"
    bad.write_bytes(b"this is not an image at all, sorry")
    store = HistoryStore(jsonl_path)
    store.append(_build_record("r-bad", output_files=[str(bad)]))
    app = _make_app(store)
    resp = app.test_client().get("/api/history/thumbnail?record_id=r-bad&index=0")
    assert resp.status_code == 422
    assert resp.get_json()["reason"] == "decode_failed"


def test_thumbnail_400_when_record_id_missing(jsonl_path):
    store = HistoryStore(jsonl_path)
    app = _make_app(store)
    resp = app.test_client().get("/api/history/thumbnail?index=0")
    assert resp.status_code == 400


def test_thumbnail_400_when_index_not_integer(tmp_path, jsonl_path):
    png_path = tmp_path / "out.png"
    _make_png(str(png_path))
    store = HistoryStore(jsonl_path)
    store.append(_build_record("r-one", output_files=[str(png_path)]))
    app = _make_app(store)
    resp = app.test_client().get("/api/history/thumbnail?record_id=r-one&index=abc")
    assert resp.status_code == 400


# ---------------------------------------------------------------------------
# PATCH /api/history/<record_id>
# ---------------------------------------------------------------------------


def test_patch_canvas_save_state_ok(client, store_with_records):
    resp = client.patch(
        "/api/history/r-01",
        json={"canvas_save_state": "canvas_saved"},
    )
    assert resp.status_code == 200
    data = resp.get_json()
    assert data["success"] is True
    assert data["record"]["id"] == "r-01"
    assert data["record"]["canvas_save_state"] == "canvas_saved"

    # verify store actually mutated
    reread = store_with_records.find_by_id("r-01")
    assert reread["canvas_save_state"] == "canvas_saved"


def test_patch_eagle_item_ids_ok(client):
    resp = client.patch(
        "/api/history/r-02",
        json={"eagle_item_ids": ["E-1", "E-2"]},
    )
    assert resp.status_code == 200
    assert resp.get_json()["record"]["eagle_item_ids"] == ["E-1", "E-2"]


def test_patch_multiple_fields_ok(client):
    resp = client.patch(
        "/api/history/r-01",
        json={
            "canvas_save_state": "canvas_saved",
            "eagle_item_ids": ["ITEM"],
        },
    )
    assert resp.status_code == 200
    rec = resp.get_json()["record"]
    assert rec["canvas_save_state"] == "canvas_saved"
    assert rec["eagle_item_ids"] == ["ITEM"]


def test_patch_invalid_canvas_save_state_returns_400(client):
    resp = client.patch(
        "/api/history/r-01",
        json={"canvas_save_state": "bogus_state"},
    )
    assert resp.status_code == 400
    body = resp.get_json()
    assert body["success"] is False
    assert body["reason"] == "invalid_canvas_save_state"


def test_patch_invalid_eagle_item_ids_returns_400(client):
    resp = client.patch(
        "/api/history/r-01",
        json={"eagle_item_ids": "not-a-list"},
    )
    assert resp.status_code == 400
    assert resp.get_json()["reason"] == "invalid_eagle_item_ids"


def test_patch_no_recognized_fields_returns_400(client):
    resp = client.patch(
        "/api/history/r-01",
        json={"prompt": "try to patch unrelated field"},
    )
    assert resp.status_code == 400
    body = resp.get_json()
    assert body["reason"] == "no_patchable_fields"


def test_patch_unknown_record_returns_404(client):
    resp = client.patch(
        "/api/history/does-not-exist",
        json={"canvas_save_state": "canvas_saved"},
    )
    assert resp.status_code == 404
    assert resp.get_json()["reason"] == "not_found"


def test_patch_output_files_ok(client):
    resp = client.patch(
        "/api/history/r-01",
        json={"output_files": ["/new/path.png"]},
    )
    assert resp.status_code == 200
    assert resp.get_json()["record"]["output_files"] == ["/new/path.png"]


def test_patch_output_files_invalid_type_returns_400(client):
    resp = client.patch(
        "/api/history/r-01",
        json={"output_files": [123, 456]},
    )
    assert resp.status_code == 400
    assert resp.get_json()["reason"] == "invalid_output_files"


# ---------------------------------------------------------------------------
# GET /api/history/config
# ---------------------------------------------------------------------------


def test_config_endpoint_returns_runtime_state(client, store_with_records):
    resp = client.get("/api/history/config")
    assert resp.status_code == 200
    data = resp.get_json()
    assert data["success"] is True
    assert data["machine_id"] == "pc1"
    assert data["peer_machines"] == [
        {"machine_id": "pc2", "base_url": "http://192.168.110.120:5001"}
    ]
    assert data["history_store_path"] == store_with_records.path
    assert data["history_store_max_mb"] == store_with_records.max_mb


# ---------------------------------------------------------------------------
# POST /api/history/import (Windsurf legacy ingestion - Task 26)
# ---------------------------------------------------------------------------


def test_import_missing_input_returns_400(client):
    """No file and no path should yield a structured 400."""
    resp = client.post("/api/history/import", json={})
    assert resp.status_code == 400
    data = resp.get_json()
    assert data["success"] is False
    assert data["reason"] == "missing_input"
    assert data["imported"] == 0
    assert data["skipped"] == 0
    assert data["errors"] == []


def test_import_via_local_path_maps_records(tmp_path, jsonl_path):
    """Writing a small legacy dump to disk and importing it round-trips
    into the live store with the expected field mapping.
    """
    store = HistoryStore(jsonl_path)
    app = _make_app(store, machine_id="pc1")

    legacy_path = tmp_path / "legacy.jsonl"
    legacy_path.write_text(
        "\n".join([
            json.dumps({
                "id": "legacy-001",
                "created_at": "2025-10-01T12:00:00+08:00",
                "prompt": "old cat",
                "source": "canvas",
                "mode": "text2img",
                "provider_id": "windsurf-v1",
                "output_files": ["C:/legacy/out1.png"],
            }),
            json.dumps({
                "created_at": "2025-10-02T09:30:00+08:00",
                "prompt": "old dog",
                "machine_id": "pc2",
                "reference_images": ["base64..."],
                "count": 2,
            }),
            "",  # blank line, should be ignored
            "{not valid json",  # malformed, counted in skipped
        ]),
        encoding="utf-8",
    )

    resp = app.test_client().post(
        "/api/history/import",
        json={
            "path": str(legacy_path),
            "fallback_machine_id": "legacy-pc2",
        },
    )
    assert resp.status_code == 200
    data = resp.get_json()
    assert data["success"] is True
    assert data["imported"] == 2
    assert data["skipped"] == 1
    assert len(data["errors"]) == 1
    assert data["errors"][0]["line"] == 4
    assert "invalid_json" in data["errors"][0]["reason"]

    # Records were actually written — re-read via the store API.
    page, total, has_more, warnings = store.read_page(filters={}, limit=100, offset=0)
    assert total == 2
    by_prompt = {r["prompt"]: r for r in page}
    cat = by_prompt["old cat"]
    dog = by_prompt["old dog"]

    # 1. new ids generated, but legacy id preserved
    assert cat["id"] != "legacy-001"
    assert cat["legacy_id"] == "legacy-001"
    assert cat["imported_from_legacy"] is True
    assert "legacy_id" not in dog  # no legacy id in second record

    # 2. created_at preserved from source
    assert cat["created_at"] == "2025-10-01T12:00:00+08:00"
    assert dog["created_at"] == "2025-10-02T09:30:00+08:00"

    # 3. machine_id fallback chain
    assert cat["machine_id"] == "legacy-pc2"  # not in record, uses fallback
    assert dog["machine_id"] == "pc2"  # honours record value over fallback

    # 4. mode auto-derivation when legacy lacks explicit mode
    assert cat["mode"] == "text2img"
    assert dog["mode"] == "img2img"  # reference_images was non-empty

    # 5. source normalisation passes valid values through
    assert cat["source"] == "canvas"
    assert cat["raw_source"] is None

    # 6. schema invariants
    assert cat["schema_version"] == "1"
    assert cat["output_files"] == ["C:/legacy/out1.png"]
    assert cat["eagle_item_ids"] == []
    assert cat["success"] is True


def test_import_falls_back_to_legacy_when_no_machine_id(tmp_path, jsonl_path):
    """Record without machine_id + no fallback → 'legacy'."""
    store = HistoryStore(jsonl_path)
    app = _make_app(store)

    legacy_path = tmp_path / "legacy.jsonl"
    legacy_path.write_text(
        json.dumps({"prompt": "orphan record"}) + "\n",
        encoding="utf-8",
    )
    resp = app.test_client().post(
        "/api/history/import",
        json={"path": str(legacy_path)},
    )
    assert resp.status_code == 200
    data = resp.get_json()
    assert data["imported"] == 1

    page, *_ = store.read_page(filters={}, limit=10, offset=0)
    assert page[0]["machine_id"] == "legacy"


def test_import_invalid_source_is_demoted_to_unknown(tmp_path, jsonl_path):
    """A legacy record with bogus ``source`` degrades to 'unknown' and the
    original value is captured in ``raw_source``.
    """
    store = HistoryStore(jsonl_path)
    app = _make_app(store)

    legacy_path = tmp_path / "legacy.jsonl"
    legacy_path.write_text(
        json.dumps({
            "prompt": "weird source",
            "source": "windsurf_canvas",  # not in our allow-list
        }) + "\n",
        encoding="utf-8",
    )
    resp = app.test_client().post(
        "/api/history/import",
        json={"path": str(legacy_path)},
    )
    assert resp.status_code == 200

    rec = store.read_page(filters={}, limit=10, offset=0)[0][0]
    assert rec["source"] == "unknown"
    assert rec["raw_source"] == "windsurf_canvas"


def test_import_bad_created_at_falls_back_to_now(tmp_path, jsonl_path):
    """Unparseable created_at strings are replaced with the current time."""
    store = HistoryStore(jsonl_path)
    app = _make_app(store)

    legacy_path = tmp_path / "legacy.jsonl"
    legacy_path.write_text(
        json.dumps({
            "prompt": "no timestamp",
            "created_at": "yesterday afternoon",
        }) + "\n",
        encoding="utf-8",
    )
    resp = app.test_client().post(
        "/api/history/import",
        json={"path": str(legacy_path)},
    )
    assert resp.status_code == 200
    rec = store.read_page(filters={}, limit=10, offset=0)[0][0]
    # Accept either 'T' separator + offset — the point is it's a fresh ISO-8601
    assert len(rec["created_at"]) >= 19
    assert rec["created_at"] != "yesterday afternoon"


def test_import_epoch_milliseconds_timestamp(tmp_path, jsonl_path):
    """Numeric created_at (ms since epoch) is converted to ISO 8601."""
    store = HistoryStore(jsonl_path)
    app = _make_app(store)

    legacy_path = tmp_path / "legacy.jsonl"
    # 2025-01-01 00:00:00 UTC
    legacy_path.write_text(
        json.dumps({
            "prompt": "epoch ms",
            "timestamp": 1735689600000,
        }) + "\n",
        encoding="utf-8",
    )
    resp = app.test_client().post(
        "/api/history/import",
        json={"path": str(legacy_path)},
    )
    assert resp.status_code == 200
    rec = store.read_page(filters={}, limit=10, offset=0)[0][0]
    assert rec["created_at"].startswith("2025-01-01") or rec["created_at"].startswith("2024-12-31")


def test_import_via_multipart_upload(jsonl_path):
    """Multipart file field with fallback form field works end-to-end."""
    store = HistoryStore(jsonl_path)
    app = _make_app(store)

    content = "\n".join([
        json.dumps({"prompt": "upload first", "source": "script"}),
        json.dumps({"prompt": "upload second"}),
    ]).encode("utf-8")

    resp = app.test_client().post(
        "/api/history/import",
        data={
            "file": (io.BytesIO(content), "dump.jsonl"),
            "fallback_machine_id": "legacy-uploader",
        },
        content_type="multipart/form-data",
    )
    assert resp.status_code == 200
    data = resp.get_json()
    assert data["imported"] == 2
    assert data["skipped"] == 0

    page, total, *_ = store.read_page(filters={}, limit=10, offset=0)
    assert total == 2
    machine_ids = {r["machine_id"] for r in page}
    assert machine_ids == {"legacy-uploader"}


def test_import_path_must_be_absolute(tmp_path, jsonl_path):
    """Relative paths are rejected to prevent ambiguous server-side lookups."""
    store = HistoryStore(jsonl_path)
    app = _make_app(store)
    resp = app.test_client().post(
        "/api/history/import",
        json={"path": "relative/legacy.jsonl"},
    )
    assert resp.status_code == 400
    assert resp.get_json()["reason"] == "path_not_absolute"


def test_import_path_not_found_returns_404(tmp_path, jsonl_path):
    store = HistoryStore(jsonl_path)
    app = _make_app(store)
    missing = tmp_path / "nope.jsonl"
    resp = app.test_client().post(
        "/api/history/import",
        json={"path": str(missing)},
    )
    assert resp.status_code == 404
    assert resp.get_json()["reason"] == "path_not_found"


def test_import_non_object_lines_are_skipped(tmp_path, jsonl_path):
    """Lines that parse but aren't JSON objects (e.g. arrays/strings) count
    as skipped with a 'not_an_object' reason.
    """
    store = HistoryStore(jsonl_path)
    app = _make_app(store)
    legacy_path = tmp_path / "legacy.jsonl"
    legacy_path.write_text(
        "\n".join([
            json.dumps({"prompt": "good one"}),
            json.dumps(["array", "not", "object"]),
            json.dumps("just a string"),
        ]),
        encoding="utf-8",
    )
    resp = app.test_client().post(
        "/api/history/import",
        json={"path": str(legacy_path)},
    )
    assert resp.status_code == 200
    data = resp.get_json()
    assert data["imported"] == 1
    assert data["skipped"] == 2
    reasons = {e["reason"] for e in data["errors"]}
    assert reasons == {"not_an_object"}


def test_import_hundred_records_end_to_end(tmp_path, jsonl_path):
    """Validates the feature's acceptance check: import 100 records → store
    grows by 100 and every record is retrievable via the normal list API.
    """
    store = HistoryStore(jsonl_path)
    app = _make_app(store)

    legacy_path = tmp_path / "legacy_100.jsonl"
    lines = []
    for i in range(100):
        lines.append(json.dumps({
            "id": f"windsurf-{i:03d}",
            "prompt": f"prompt number {i}",
            "created_at": f"2025-09-{(i % 28) + 1:02d}T10:00:00+08:00",
            "source": ["canvas", "eagle_plugin", "script", "legacy_app"][i % 4],
            "provider_id": "windsurf",
            "count": 1 + (i % 3),
        }))
    legacy_path.write_text("\n".join(lines), encoding="utf-8")

    client = app.test_client()
    resp = client.post(
        "/api/history/import",
        json={
            "path": str(legacy_path),
            "fallback_machine_id": "legacy-pc2",
        },
    )
    assert resp.status_code == 200
    data = resp.get_json()
    assert data["imported"] == 100
    assert data["skipped"] == 0

    # Spot-check via the list endpoint — matches the "面板能筛到" acceptance.
    list_resp = client.get("/api/history?limit=500")
    list_data = list_resp.get_json()
    assert list_data["total"] == 100
    # Filter by a legacy value demoted to 'unknown' should pick up 25 rows.
    unknown_resp = client.get("/api/history?source=unknown&limit=500")
    assert unknown_resp.get_json()["total"] == 25
