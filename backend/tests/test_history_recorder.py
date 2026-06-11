"""
Unit tests for ``backend/history_recorder.py``.

Covers:
* ``mode`` auto-detection from reference_images (text2img vs img2img)
* ``source`` normalisation (canvas / eagle_plugin / script / unknown + raw_source)
* canvas_save_state defaulting for canvas source
* Failure path: success=False records are still written with error_message
* history_recorder_enabled=False short-circuits and writes nothing
* eagle_item_ids from task_meta pass through
* batch_id / script_name pass through
* Exceptions inside store.append are swallowed (returns None, does not raise)
"""

from __future__ import annotations

from typing import Any, Optional

import pytest

import history_recorder
from history_store import HistoryStore


# ---------------------------------------------------------------------------
# test doubles
# ---------------------------------------------------------------------------


class _FakeStore:
    """Minimal in-memory stand-in that records every append call."""

    def __init__(self) -> None:
        self.records: list[dict] = []

    def append(self, record: dict) -> None:
        self.records.append(record)


class _RaisingStore:
    def append(self, record: dict) -> None:
        raise OSError("disk full (simulated)")


@pytest.fixture
def fake_store() -> _FakeStore:
    return _FakeStore()


@pytest.fixture
def recorder_config(monkeypatch):
    """Factory to control what ``load_system_config`` returns inside the recorder."""
    def _set(cfg: Optional[dict]):
        def _fake_hooks():
            def _load():
                return cfg if cfg is not None else {}
            def _log(msg, level="info"):
                pass
            return _load, _log
        monkeypatch.setattr(history_recorder, "_lazy_app_hooks", _fake_hooks)
    return _set


# ---------------------------------------------------------------------------
# mode auto-detection
# ---------------------------------------------------------------------------


def test_mode_text2img_when_no_reference_images(fake_store, recorder_config):
    recorder_config({"history_recorder_enabled": True})
    rec = history_recorder.record_generation(
        request_body={"prompt": "a cat", "reference_images": []},
        result={"success": True, "images": []},
        provider={"id": "gpt-image", "name": "GPT Image"},
        elapsed_sec=1.5,
        machine_id="pc1",
        store=fake_store,
    )
    assert rec is not None
    assert rec["mode"] == "text2img"
    assert rec["reference_count"] == 0


def test_mode_text2img_when_reference_images_missing(fake_store, recorder_config):
    recorder_config({"history_recorder_enabled": True})
    rec = history_recorder.record_generation(
        request_body={"prompt": "a cat"},  # no field at all
        result={"success": True, "images": []},
        provider={"id": "x"},
        elapsed_sec=0.1,
        machine_id="pc1",
        store=fake_store,
    )
    assert rec["mode"] == "text2img"
    assert rec["reference_count"] == 0


def test_mode_img2img_when_reference_images_present(fake_store, recorder_config):
    recorder_config({"history_recorder_enabled": True})
    rec = history_recorder.record_generation(
        request_body={
            "prompt": "a cat in the style of this",
            "reference_images": ["data:image/png;base64,AAAA", "data:image/png;base64,BBBB"],
        },
        result={"success": True, "images": []},
        provider={"id": "gpt-image"},
        elapsed_sec=2.0,
        machine_id="pc1",
        store=fake_store,
    )
    assert rec["mode"] == "img2img"
    assert rec["reference_count"] == 2


def test_empty_strings_in_reference_images_are_ignored(fake_store, recorder_config):
    recorder_config({"history_recorder_enabled": True})
    rec = history_recorder.record_generation(
        request_body={
            "prompt": "p",
            "reference_images": ["", None, "data:image/png;base64,AAA"],
        },
        result={"success": True, "images": []},
        provider={"id": "x"},
        elapsed_sec=0.1,
        machine_id="pc1",
        store=fake_store,
    )
    # Only one truthy entry -> img2img with reference_count=1
    assert rec["mode"] == "img2img"
    assert rec["reference_count"] == 1


def test_reference_images_base64_is_not_stored(fake_store, recorder_config):
    """The record should never contain the raw base64 payloads."""
    recorder_config({"history_recorder_enabled": True})
    payload = "data:image/png;base64," + "A" * 1000
    rec = history_recorder.record_generation(
        request_body={"prompt": "p", "reference_images": [payload]},
        result={"success": True, "images": []},
        provider={"id": "x"},
        elapsed_sec=0.1,
        machine_id="pc1",
        store=fake_store,
    )
    assert payload not in str(rec)
    assert "reference_images" not in rec


# ---------------------------------------------------------------------------
# source normalisation
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("source_in", ["canvas", "eagle_plugin", "script"])
def test_valid_source_passes_through(fake_store, recorder_config, source_in):
    recorder_config({"history_recorder_enabled": True})
    rec = history_recorder.record_generation(
        request_body={"prompt": "p", "task_meta": {"source": source_in}},
        result={"success": True, "images": []},
        provider={"id": "x"},
        elapsed_sec=0.1,
        machine_id="pc1",
        store=fake_store,
    )
    assert rec["source"] == source_in
    assert rec["raw_source"] is None


def test_unknown_source_when_task_meta_missing(fake_store, recorder_config):
    recorder_config({"history_recorder_enabled": True})
    rec = history_recorder.record_generation(
        request_body={"prompt": "p"},
        result={"success": True, "images": []},
        provider={"id": "x"},
        elapsed_sec=0.1,
        machine_id="pc1",
        store=fake_store,
    )
    assert rec["source"] == "unknown"
    assert rec["raw_source"] is None


def test_unknown_source_preserves_raw_value(fake_store, recorder_config):
    recorder_config({"history_recorder_enabled": True})
    rec = history_recorder.record_generation(
        request_body={"prompt": "p", "task_meta": {"source": "weird_plugin"}},
        result={"success": True, "images": []},
        provider={"id": "x"},
        elapsed_sec=0.1,
        machine_id="pc1",
        store=fake_store,
    )
    assert rec["source"] == "unknown"
    assert rec["raw_source"] == "weird_plugin"


# ---------------------------------------------------------------------------
# canvas_save_state defaulting
# ---------------------------------------------------------------------------


def test_canvas_source_defaults_to_unsaved(fake_store, recorder_config):
    recorder_config({"history_recorder_enabled": True})
    rec = history_recorder.record_generation(
        request_body={"prompt": "p", "task_meta": {"source": "canvas", "canvas_node_id": "n1"}},
        result={"success": True, "images": []},
        provider={"id": "x"},
        elapsed_sec=0.1,
        machine_id="pc1",
        store=fake_store,
    )
    assert rec["canvas_save_state"] == "canvas_unsaved"
    assert rec["canvas_node_id"] == "n1"


def test_canvas_source_respects_explicit_saved(fake_store, recorder_config):
    recorder_config({"history_recorder_enabled": True})
    rec = history_recorder.record_generation(
        request_body={
            "prompt": "p",
            "task_meta": {"source": "canvas", "canvas_save_state": "canvas_saved"},
        },
        result={"success": True, "images": []},
        provider={"id": "x"},
        elapsed_sec=0.1,
        machine_id="pc1",
        store=fake_store,
    )
    assert rec["canvas_save_state"] == "canvas_saved"


def test_non_canvas_source_has_null_save_state(fake_store, recorder_config):
    recorder_config({"history_recorder_enabled": True})
    rec = history_recorder.record_generation(
        request_body={"prompt": "p", "task_meta": {"source": "eagle_plugin"}},
        result={"success": True, "images": []},
        provider={"id": "x"},
        elapsed_sec=0.1,
        machine_id="pc1",
        store=fake_store,
    )
    assert rec["canvas_save_state"] is None


# ---------------------------------------------------------------------------
# failure path
# ---------------------------------------------------------------------------


def test_failed_generation_still_records_with_error(fake_store, recorder_config):
    recorder_config({"history_recorder_enabled": True})
    rec = history_recorder.record_generation(
        request_body={"prompt": "p"},
        result={"success": False, "error": "quota exceeded"},
        provider={"id": "x"},
        elapsed_sec=0.5,
        machine_id="pc1",
        store=fake_store,
    )
    assert rec is not None
    assert rec["success"] is False
    assert rec["error_message"] == "quota exceeded"
    assert rec["output_files"] == []
    assert len(fake_store.records) == 1


def test_output_files_extracted_from_success_result(fake_store, recorder_config):
    recorder_config({"history_recorder_enabled": True})
    rec = history_recorder.record_generation(
        request_body={"prompt": "p"},
        result={
            "success": True,
            "images": [
                {"filepath": "/abs/a.png", "mime": "image/png"},
                {"filepath": "/abs/b.png"},
            ],
        },
        provider={"id": "x"},
        elapsed_sec=0.1,
        machine_id="pc1",
        store=fake_store,
    )
    assert rec["output_files"] == ["/abs/a.png", "/abs/b.png"]


# ---------------------------------------------------------------------------
# kill switch
# ---------------------------------------------------------------------------


def test_kill_switch_false_writes_nothing(fake_store, recorder_config):
    recorder_config({"history_recorder_enabled": False})
    rec = history_recorder.record_generation(
        request_body={"prompt": "p"},
        result={"success": True, "images": []},
        provider={"id": "x"},
        elapsed_sec=0.1,
        machine_id="pc1",
        store=fake_store,
    )
    assert rec is None
    assert fake_store.records == []


def test_kill_switch_default_true_when_config_missing(fake_store, recorder_config):
    recorder_config({})  # no key at all
    rec = history_recorder.record_generation(
        request_body={"prompt": "p"},
        result={"success": True, "images": []},
        provider={"id": "x"},
        elapsed_sec=0.1,
        machine_id="pc1",
        store=fake_store,
    )
    assert rec is not None
    assert len(fake_store.records) == 1


# ---------------------------------------------------------------------------
# task_meta pass-through
# ---------------------------------------------------------------------------


def test_eagle_item_ids_from_task_meta(fake_store, recorder_config):
    recorder_config({"history_recorder_enabled": True})
    rec = history_recorder.record_generation(
        request_body={
            "prompt": "p",
            "task_meta": {
                "source": "eagle_plugin",
                "eagle_item_ids": ["ITEM-A", "ITEM-B"],
            },
        },
        result={"success": True, "images": []},
        provider={"id": "x"},
        elapsed_sec=0.1,
        machine_id="pc1",
        store=fake_store,
    )
    assert rec["eagle_item_ids"] == ["ITEM-A", "ITEM-B"]


def test_batch_id_and_script_name_stored(fake_store, recorder_config):
    recorder_config({"history_recorder_enabled": True})
    rec = history_recorder.record_generation(
        request_body={
            "prompt": "p",
            "task_meta": {
                "source": "script",
                "batch_id": "batch-001",
                "script_name": "generate_via_studio.py",
            },
        },
        result={"success": True, "images": []},
        provider={"id": "x"},
        elapsed_sec=0.1,
        machine_id="pc1",
        store=fake_store,
    )
    assert rec["batch_id"] == "batch-001"
    assert rec["script_name"] == "generate_via_studio.py"


def test_schema_version_is_set(fake_store, recorder_config):
    recorder_config({"history_recorder_enabled": True})
    rec = history_recorder.record_generation(
        request_body={"prompt": "p"},
        result={"success": True, "images": []},
        provider={"id": "x"},
        elapsed_sec=0.1,
        machine_id="pc1",
        store=fake_store,
    )
    assert rec["schema_version"] == "1"


def test_id_shape_includes_machine_id(fake_store, recorder_config):
    recorder_config({"history_recorder_enabled": True})
    rec = history_recorder.record_generation(
        request_body={"prompt": "p"},
        result={"success": True, "images": []},
        provider={"id": "x"},
        elapsed_sec=0.1,
        machine_id="pc1",
        store=fake_store,
    )
    assert rec["id"].startswith("pc1-")
    parts = rec["id"].split("-")
    assert len(parts) == 3  # machine_id, ts_ms, rand6
    assert parts[1].isdigit()
    assert len(parts[2]) == 6


# ---------------------------------------------------------------------------
# defensive failure modes
# ---------------------------------------------------------------------------


def test_store_append_exception_is_swallowed(recorder_config):
    recorder_config({"history_recorder_enabled": True})
    raising = _RaisingStore()
    # Must not raise, must return None.
    result = history_recorder.record_generation(
        request_body={"prompt": "p"},
        result={"success": True, "images": []},
        provider={"id": "x"},
        elapsed_sec=0.1,
        machine_id="pc1",
        store=raising,
    )
    assert result is None


def test_real_store_integration_writes_one_line(jsonl_path, recorder_config):
    """Smoke-test against the real HistoryStore to catch interface drift."""
    recorder_config({"history_recorder_enabled": True})
    store = HistoryStore(jsonl_path)
    rec = history_recorder.record_generation(
        request_body={"prompt": "integration"},
        result={"success": True, "images": [{"filepath": "/tmp/out.png"}]},
        provider={"id": "gpt-image", "name": "GPT Image", "model": "gpt-image-1"},
        elapsed_sec=0.42,
        machine_id="pc1",
        store=store,
    )
    assert rec is not None
    import json
    with open(jsonl_path, "r", encoding="utf-8") as f:
        lines = [json.loads(ln) for ln in f if ln.strip()]
    assert len(lines) == 1
    assert lines[0]["prompt"] == "integration"
    assert lines[0]["provider_name"] == "GPT Image"
    assert lines[0]["model"] == "gpt-image-1"
