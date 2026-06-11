import base64
import time
from io import BytesIO

import requests
from PIL import Image

import app as studio_app


def make_png_1x1():
    buf = BytesIO()
    Image.new("RGB", (1, 1), (255, 0, 0)).save(buf, format="PNG")
    return buf.getvalue()


PNG_1X1 = make_png_1x1()


class FakeResponse:
    def __init__(self, status_code, payload):
        self.status_code = status_code
        self._payload = payload
        self.text = str(payload)
        self.content = PNG_1X1

    def json(self):
        return self._payload


def make_async_generator(tmp_path, **kwargs):
    gen = studio_app.ImageGenerator()
    ok = gen.initialize(
        api_key="sk-test",
        api_url="https://subimg.jmlt.asia",
        output_dir=str(tmp_path),
        model=kwargs.get("model", "gpt-image-2"),
        provider_protocol="openai_images_async",
        provider_channel=kwargs.get("provider_channel", "main"),
        poll_interval_ms=kwargs.get("poll_interval_ms", 500),
        poll_timeout_seconds=kwargs.get("poll_timeout_seconds", 30),
        response_format=kwargs.get("response_format", "url"),
    )
    assert ok
    return gen


def patch_recovery(monkeypatch):
    updates = []

    def fake_create(remote_url, **kwargs):
        return {"id": f"rec-{len(updates) + 1}", "remote_url": remote_url, "attempts": 0}

    def fake_update(record_id, **kwargs):
        updates.append((record_id, kwargs))
        return {"id": record_id, **kwargs}

    monkeypatch.setattr(studio_app, "recovery_create", fake_create)
    monkeypatch.setattr(studio_app, "recovery_update", fake_update)
    monkeypatch.setattr(studio_app, "recovery_get", lambda record_id: {"id": record_id, "attempts": 0})
    return updates


def test_async_text_generation_polls_and_downloads_once(monkeypatch, tmp_path):
    gen = make_async_generator(tmp_path)
    patch_recovery(monkeypatch)
    post_calls = []
    get_calls = []

    def fake_post(url, json=None, **kwargs):
        post_calls.append({"url": url, "json": json, "kwargs": kwargs})
        return FakeResponse(
            202,
            {"success": True, "data": {"taskId": "task-1", "status": "running", "pollAfterMs": 1}},
        )

    def fake_get(url, **kwargs):
        get_calls.append({"url": url, "kwargs": kwargs})
        return FakeResponse(
            200,
            {
                "success": True,
                "data": {
                    "taskId": "task-1",
                    "status": "completed",
                    "result": {"data": [{"url": "/api/image-cache/task-1/image-1.png"}]},
                },
            },
        )

    monkeypatch.setattr(requests, "post", fake_post)
    monkeypatch.setattr(requests, "get", fake_get)
    monkeypatch.setattr(time, "sleep", lambda _seconds: None)
    monkeypatch.setattr(gen, "_fetch_image_bytes", lambda url, base_url, timeout=180: (PNG_1X1, 200, None))
    monkeypatch.setattr(
        gen,
        "_save_and_process_image",
        lambda data, target_size=None: {"filename": "out.png", "filepath": str(tmp_path / "out.png"), "url": "/api/images/out.png"},
    )

    result = gen.generate("cat", aspect_ratio="1:1", resolution="1K", reference_images=[], count=1)

    assert result["success"] is True
    assert result["async_task_id"] == "task-1"
    assert len(post_calls) == 1
    assert post_calls[0]["url"] == "https://subimg.jmlt.asia/api/openai/v1/images/generations"
    assert post_calls[0]["json"]["provider"] == "main"
    assert post_calls[0]["json"]["response_format"] == "url"
    assert get_calls[0]["url"] == "https://subimg.jmlt.asia/api/openai/tasks/task-1"


def test_async_text_generation_passes_transparent_png_for_gpt_image_15(monkeypatch, tmp_path):
    gen = make_async_generator(tmp_path, model="gpt-image-1.5")
    patch_recovery(monkeypatch)
    post_calls = []
    b64_png = base64.b64encode(PNG_1X1).decode("ascii")

    def fake_post(url, json=None, **kwargs):
        post_calls.append({"url": url, "json": json, "kwargs": kwargs})
        return FakeResponse(200, {"data": [{"b64_json": b64_png}]})

    monkeypatch.setattr(requests, "post", fake_post)
    monkeypatch.setattr(
        gen,
        "_save_and_process_image",
        lambda data, target_size=None: {"filename": "out.png", "filepath": str(tmp_path / "out.png"), "url": "/api/images/out.png"},
    )

    result = gen.generate(
        "cat",
        aspect_ratio="1:1",
        resolution="1K",
        reference_images=[],
        count=1,
        background="transparent",
        output_format="png",
    )

    assert result["success"] is True
    assert post_calls[0]["json"]["background"] == "transparent"
    assert post_calls[0]["json"]["output_format"] == "png"


def test_async_failed_task_does_not_resubmit(monkeypatch, tmp_path):
    gen = make_async_generator(tmp_path)
    patch_recovery(monkeypatch)
    post_calls = []

    def fake_post(url, json=None, **kwargs):
        post_calls.append(url)
        return FakeResponse(
            202,
            {"success": True, "data": {"taskId": "task-fail", "status": "running", "pollAfterMs": 1}},
        )

    def fake_get(url, **kwargs):
        return FakeResponse(
            200,
            {
                "success": True,
                "data": {
                    "taskId": "task-fail",
                    "status": "failed",
                    "error": {"message": "upstream failed"},
                },
            },
        )

    monkeypatch.setattr(requests, "post", fake_post)
    monkeypatch.setattr(requests, "get", fake_get)
    monkeypatch.setattr(time, "sleep", lambda _seconds: None)
    monkeypatch.setattr(gen, "_fetch_image_bytes", lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("download should not run")))

    result = gen.generate("cat", aspect_ratio="1:1", resolution="1K", reference_images=[], count=1)

    assert result["success"] is False
    assert result["stage"] == "poll_async_task"
    assert result["async_task_id"] == "task-fail"
    assert len(post_calls) == 1


def test_async_edit_uses_multipart_and_accepts_b64_result(monkeypatch, tmp_path):
    gen = make_async_generator(tmp_path, response_format="b64_json")
    patch_recovery(monkeypatch)
    post_calls = []
    b64_png = base64.b64encode(PNG_1X1).decode("ascii")
    ref_image = "data:image/png;base64," + b64_png

    def fake_post(url, data=None, files=None, **kwargs):
        post_calls.append({"url": url, "data": data, "files": files, "kwargs": kwargs})
        return FakeResponse(
            202,
            {
                "success": True,
                "data": {
                    "taskId": "task-edit",
                    "status": "completed",
                    "result": {"data": [{"b64_json": b64_png}]},
                },
            },
        )

    monkeypatch.setattr(requests, "post", fake_post)
    monkeypatch.setattr(requests, "get", lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("poll should not run")))
    monkeypatch.setattr(
        gen,
        "_save_and_process_image",
        lambda data, target_size=None: {"filename": "edit.png", "filepath": str(tmp_path / "edit.png"), "url": "/api/images/edit.png"},
    )

    result = gen.generate("edit it", aspect_ratio="1:1", resolution="1K", reference_images=[ref_image], count=1)

    assert result["success"] is True
    assert result["async_task_id"] == "task-edit"
    assert len(post_calls) == 1
    assert post_calls[0]["url"] == "https://subimg.jmlt.asia/api/openai/v1/images/edits"
    assert post_calls[0]["data"]["provider"] == "main"
    assert post_calls[0]["data"]["response_format"] == "b64_json"
    assert len(post_calls[0]["files"]) == 1


def test_async_edit_passes_transparent_png_for_gpt_image_15(monkeypatch, tmp_path):
    gen = make_async_generator(tmp_path, model="gpt-image-1.5", response_format="b64_json")
    patch_recovery(monkeypatch)
    post_calls = []
    b64_png = base64.b64encode(PNG_1X1).decode("ascii")
    ref_image = "data:image/png;base64," + b64_png

    def fake_post(url, data=None, files=None, **kwargs):
        post_calls.append({"url": url, "data": data, "files": files, "kwargs": kwargs})
        return FakeResponse(200, {"data": [{"b64_json": b64_png}]})

    monkeypatch.setattr(requests, "post", fake_post)
    monkeypatch.setattr(
        gen,
        "_save_and_process_image",
        lambda data, target_size=None: {"filename": "edit.png", "filepath": str(tmp_path / "edit.png"), "url": "/api/images/edit.png"},
    )

    result = gen.generate(
        "edit it",
        aspect_ratio="1:1",
        resolution="1K",
        reference_images=[ref_image],
        count=1,
        background="transparent",
        output_format="png",
    )

    assert result["success"] is True
    assert post_calls[0]["data"]["background"] == "transparent"
    assert post_calls[0]["data"]["output_format"] == "png"
    assert len(post_calls[0]["files"]) == 1


def test_async_edit_retries_standard_path_on_405_with_transparent_png(monkeypatch, tmp_path):
    gen = make_async_generator(tmp_path, model="gpt-image-1.5", response_format="b64_json")
    patch_recovery(monkeypatch)
    post_calls = []
    b64_png = base64.b64encode(PNG_1X1).decode("ascii")
    ref_image = "data:image/png;base64," + b64_png

    def fake_post(url, data=None, files=None, **kwargs):
        post_calls.append({"url": url, "data": data, "files": files, "kwargs": kwargs})
        if url.endswith("/api/openai/v1/images/edits"):
            return FakeResponse(405, {"error": "method not allowed"})
        return FakeResponse(200, {"data": [{"b64_json": b64_png}]})

    monkeypatch.setattr(requests, "post", fake_post)
    monkeypatch.setattr(
        gen,
        "_save_and_process_image",
        lambda data, target_size=None: {"filename": "edit.png", "filepath": str(tmp_path / "edit.png"), "url": "/api/images/edit.png"},
    )

    result = gen.generate(
        "extract the lamp, transparent background",
        aspect_ratio="1:1",
        resolution="2K",
        reference_images=[ref_image],
        count=1,
        background="transparent",
        output_format="png",
    )

    assert result["success"] is True
    assert [call["url"] for call in post_calls] == [
        "https://subimg.jmlt.asia/api/openai/v1/images/edits",
        "https://subimg.jmlt.asia/v1/images/edits",
    ]
    assert post_calls[1]["data"]["provider"] == "main"
    assert post_calls[1]["data"]["size"] == "1024x1024"
    assert post_calls[1]["data"]["background"] == "transparent"
    assert post_calls[1]["data"]["output_format"] == "png"
    assert len(post_calls[1]["files"]) == 1


def test_async_edit_retries_channel_on_no_compatible_accounts(monkeypatch, tmp_path):
    gen = make_async_generator(tmp_path, model="gpt-image-1.5", response_format="b64_json")
    patch_recovery(monkeypatch)
    post_calls = []
    b64_png = base64.b64encode(PNG_1X1).decode("ascii")
    ref_image = "data:image/png;base64," + b64_png

    def fake_post(url, data=None, files=None, **kwargs):
        post_calls.append({"url": url, "data": dict(data or {}), "files": files, "kwargs": kwargs})
        if url.endswith("/api/openai/v1/images/edits"):
            return FakeResponse(405, {"error": "method not allowed"})
        if data.get("provider") == "main":
            return FakeResponse(503, {"error": {"message": "No available compatible accounts", "type": "api_error"}})
        return FakeResponse(200, {"data": [{"b64_json": b64_png}]})

    monkeypatch.setattr(requests, "post", fake_post)
    monkeypatch.setattr(
        gen,
        "_save_and_process_image",
        lambda data, target_size=None: {"filename": "edit.png", "filepath": str(tmp_path / "edit.png"), "url": "/api/images/edit.png"},
    )

    result = gen.generate(
        "extract the lamp, transparent background",
        aspect_ratio="1:1",
        resolution="1024x1024",
        reference_images=[ref_image],
        count=1,
        background="transparent",
        output_format="png",
    )

    assert result["success"] is True
    assert [call["url"] for call in post_calls] == [
        "https://subimg.jmlt.asia/api/openai/v1/images/edits",
        "https://subimg.jmlt.asia/v1/images/edits",
        "https://subimg.jmlt.asia/v1/images/edits",
    ]
    assert [call["data"]["provider"] for call in post_calls] == ["main", "main", "backup"]
    assert post_calls[2]["data"]["background"] == "transparent"
    assert post_calls[2]["data"]["output_format"] == "png"
