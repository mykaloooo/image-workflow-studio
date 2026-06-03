"""Chenyu instance API and ComfyUI API helpers.

The Chenyu API controls GPU instances. Once an instance is running, the
returned WebUI URL exposes the normal ComfyUI HTTP API.
"""

from __future__ import annotations

import json
import mimetypes
import os
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen


CHENYU_API_BASE_URL = "https://www.chenyu.cn/api/open/v2"
DEFAULT_STARTUP_STATUSES = {1, 24}
DEFAULT_RUNNING_STATUS = 2
DEFAULT_STOPPED_STATUSES = {4, 22, 23}


class ChenyuApiError(RuntimeError):
    """Raised when the Chenyu API returns a non-success result."""


class ComfyApiError(RuntimeError):
    """Raised when ComfyUI returns an error or an unexpected payload."""


def _json_loads(data: bytes) -> dict[str, Any]:
    if not data:
        return {}
    return json.loads(data.decode("utf-8"))


def _json_request(
    method: str,
    url: str,
    *,
    headers: dict[str, str] | None = None,
    params: dict[str, Any] | None = None,
    body: dict[str, Any] | None = None,
    timeout: int = 120,
    retries: int = 2,
) -> dict[str, Any]:
    if params:
        url = f"{url}?{urlencode(params)}"
    data = None
    request_headers = dict(headers or {})
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        request_headers.setdefault("Content-Type", "application/json")
    last_error: Exception | None = None
    for attempt in range(retries + 1):
        request = Request(url, data=data, headers=request_headers, method=method.upper())
        try:
            with urlopen(request, timeout=timeout) as response:
                return _json_loads(response.read())
        except HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"{method.upper()} {url} failed: HTTP {exc.code} {detail}") from exc
        except (TimeoutError, URLError, OSError) as exc:
            last_error = exc
            if attempt >= retries:
                break
            time.sleep(2 * (attempt + 1))
    raise RuntimeError(f"{method.upper()} {url} failed after {retries + 1} attempts: {last_error}") from last_error


def _download(url: str, output_path: Path, *, timeout: int = 300) -> None:
    request = Request(url, method="GET")
    with urlopen(request, timeout=timeout) as response, output_path.open("wb") as output:
        while True:
            chunk = response.read(1024 * 1024)
            if not chunk:
                break
            output.write(chunk)


def _encode_multipart(
    fields: dict[str, str],
    files: dict[str, tuple[Path, str] | Path],
) -> tuple[bytes, str]:
    boundary = f"----codex-chenyu-{uuid.uuid4().hex}"
    chunks: list[bytes] = []

    def add(text: str) -> None:
        chunks.append(text.encode("utf-8"))

    for name, value in fields.items():
        add(f"--{boundary}\r\n")
        add(f'Content-Disposition: form-data; name="{name}"\r\n\r\n')
        add(f"{value}\r\n")

    for name, file_value in files.items():
        if isinstance(file_value, tuple):
            file_path, filename = file_value
        else:
            file_path = file_value
            filename = file_path.name
        content_type = mimetypes.guess_type(filename)[0] or "application/octet-stream"
        add(f"--{boundary}\r\n")
        add(
            f'Content-Disposition: form-data; name="{name}"; '
            f'filename="{filename}"\r\n'
        )
        add(f"Content-Type: {content_type}\r\n\r\n")
        chunks.append(file_path.read_bytes())
        add("\r\n")

    add(f"--{boundary}--\r\n")
    return b"".join(chunks), boundary


@dataclass(frozen=True)
class ChenyuInstanceService:
    title: str
    url: str
    port_type: str | None = None
    protocol: str | None = None


class ChenyuClient:
    """Small wrapper around Chenyu open API v2."""

    def __init__(
        self,
        api_key: str | None = None,
        *,
        base_url: str = CHENYU_API_BASE_URL,
        timeout: int = 120,
    ) -> None:
        self.api_key = api_key or os.environ.get("CHENYU_API_KEY")
        if not self.api_key:
            raise ChenyuApiError("CHENYU_API_KEY is not set")
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout

    @property
    def headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }

    def get(self, path: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        return self._check(_json_request(
            "GET",
            self.base_url + path,
            headers=self.headers,
            params=params,
            timeout=self.timeout,
        ))

    def post(self, path: str, body: dict[str, Any]) -> dict[str, Any]:
        return self._check(_json_request(
            "POST",
            self.base_url + path,
            headers=self.headers,
            body=body,
            timeout=self.timeout,
        ))

    def _check(self, payload: dict[str, Any]) -> dict[str, Any]:
        if payload.get("code") != 0:
            raise ChenyuApiError(payload.get("msg") or json.dumps(payload, ensure_ascii=False))
        return payload

    def list_instances(self, *, page: int = 1, page_size: int = 20) -> list[dict[str, Any]]:
        payload = self.get("/instance/list", {"page": page, "page_size": page_size})
        return payload.get("data", {}).get("instance_list", [])

    def instance_info(self, instance_uuid: str) -> dict[str, Any]:
        payload = self.get("/instance/info", {"instance_uuid": instance_uuid})
        return payload.get("data", {})

    def startup(
        self,
        instance_uuid: str,
        *,
        gpu_uuid: str | None = None,
        gpu_nums: int | None = None,
    ) -> None:
        body: dict[str, Any] = {"instance_uuid": instance_uuid}
        if gpu_uuid:
            body["gpu_uuid"] = gpu_uuid
        if gpu_nums:
            body["gpu_nums"] = gpu_nums
        self.post("/instance/startup", body)

    def shutdown(self, instance_uuid: str) -> None:
        self.post("/instance/shutdown", {"instance_uuid": instance_uuid})

    def set_idle_close(self, instance_uuid: str, minutes: int) -> None:
        self.post(
            "/instance/set_idle_close",
            {"instance_uuid": instance_uuid, "idle_period_minutes": minutes},
        )

    def set_shutdown_timer(self, instance_uuid: str, shutdown_time: int, *, enable: bool = True) -> None:
        self.post(
            "/instance/shutdown_timer",
            {"instance_uuid": instance_uuid, "shutdown_time": shutdown_time, "enable": enable},
        )

    def workflow_market_list(
        self,
        *,
        keyword: str | None = None,
        tag: str | None = None,
        sort: str = "latest",
        page: int = 1,
        page_size: int = 20,
    ) -> dict[str, Any]:
        params: dict[str, Any] = {
            "sort": sort,
            "page": page,
            "page_size": page_size,
        }
        if keyword:
            params["keyword"] = keyword
        if tag:
            params["tag"] = tag
        payload = self.get("/workflow/market/list", params)
        return payload.get("data", {})

    def workflow_market_info(self, workflow_id: str) -> dict[str, Any]:
        payload = self.get("/workflow/market/info", {"workflow_id": workflow_id})
        return payload.get("data", {})

    def workflow_run_submit(
        self,
        workflow_id: str,
        *,
        revision_id: str | None = None,
        inputs: dict[str, Any] | None = None,
        idempotency_key: str | None = None,
        accept_external_cost_risk: bool = True,
        contains_real_person_material: bool | None = None,
    ) -> dict[str, Any]:
        body: dict[str, Any] = {
            "workflow_id": workflow_id,
            "inputs": dict(inputs or {}),
            "accept_external_cost_risk": accept_external_cost_risk,
            "idempotency_key": idempotency_key or f"codex-{uuid.uuid4().hex}",
        }
        if revision_id:
            body["revision_id"] = revision_id
        if contains_real_person_material is not None:
            body["inputs"]["contains_real_person_material"] = contains_real_person_material
        payload = self.post("/workflow/run/submit", body)
        return payload.get("data", {})

    def workflow_run_info(self, run_order_id: str) -> dict[str, Any]:
        payload = self.get("/workflow/run/info", {"run_order_id": run_order_id})
        return payload.get("data", {})

    def workflow_run_execution(self, run_order_id: str) -> dict[str, Any]:
        payload = self.get("/workflow/run/execution", {"run_order_id": run_order_id})
        return payload.get("data", {})

    def workflow_run_list(
        self,
        *,
        workflow_id: str | None = None,
        status: str | None = None,
        page: int = 1,
        page_size: int = 20,
    ) -> dict[str, Any]:
        params: dict[str, Any] = {
            "page": page,
            "page_size": page_size,
        }
        if workflow_id:
            params["workflow_id"] = workflow_id
        if status:
            params["status"] = status
        payload = self.get("/workflow/run/list", params)
        return payload.get("data", {})

    def wait_for_status(
        self,
        instance_uuid: str,
        target_statuses: set[int],
        *,
        timeout_seconds: int = 900,
        poll_seconds: int = 5,
        on_poll: Callable[[dict[str, Any]], None] | None = None,
    ) -> dict[str, Any]:
        deadline = time.monotonic() + timeout_seconds
        last_info: dict[str, Any] = {}
        while time.monotonic() < deadline:
            last_info = self.instance_info(instance_uuid)
            if on_poll:
                on_poll(last_info)
            if int(last_info.get("status", -1)) in target_statuses:
                return last_info
            time.sleep(poll_seconds)
        raise TimeoutError(f"Instance {instance_uuid} did not reach {target_statuses}: {last_info}")


def service_maps(instance_info: dict[str, Any]) -> list[ChenyuInstanceService]:
    services = []
    for item in instance_info.get("server_map") or []:
        services.append(ChenyuInstanceService(
            title=str(item.get("title") or ""),
            url=str(item.get("url") or ""),
            port_type=item.get("port_type"),
            protocol=item.get("protocol"),
        ))
    return services


def find_service_url(instance_info: dict[str, Any], title_keyword: str = "WebUI") -> str:
    keyword = title_keyword.lower()
    for service in service_maps(instance_info):
        if service.url and keyword in service.title.lower():
            return service.url.rstrip("/")
    for url in instance_info.get("server_url") or []:
        if url:
            return str(url).rstrip("/")
    raise ChenyuApiError(f"No service URL found for {title_keyword!r}")


class ComfyClient:
    """Small wrapper around a running ComfyUI HTTP endpoint."""

    def __init__(self, base_url: str, *, timeout: int = 120) -> None:
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout

    def system_stats(self) -> dict[str, Any]:
        return _json_request("GET", self.base_url + "/system_stats", timeout=self.timeout)

    def upload_image(self, image_path: Path, *, name: str | None = None) -> str:
        upload_name = name or image_path.name
        body, boundary = _encode_multipart(
            {"type": "input", "overwrite": "true"},
            {"image": (image_path, upload_name)},
        )
        request = Request(
            self.base_url + "/upload/image",
            data=body,
            headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
            method="POST",
        )
        with urlopen(request, timeout=self.timeout) as response:
            payload = _json_loads(response.read())
        returned_name = payload.get("name")
        if not returned_name:
            raise ComfyApiError(f"Unexpected upload response: {payload}")
        if name and returned_name != upload_name:
            return str(returned_name)
        return str(returned_name)

    def queue_prompt(self, prompt: dict[str, Any], *, client_id: str | None = None) -> str:
        payload = _json_request(
            "POST",
            self.base_url + "/prompt",
            body={"prompt": prompt, "client_id": client_id or uuid.uuid4().hex},
            timeout=self.timeout,
        )
        prompt_id = payload.get("prompt_id")
        if not prompt_id:
            raise ComfyApiError(f"Unexpected prompt response: {payload}")
        return str(prompt_id)

    def history(self, prompt_id: str) -> dict[str, Any]:
        return _json_request("GET", self.base_url + f"/history/{prompt_id}", timeout=self.timeout)

    def wait_for_prompt(
        self,
        prompt_id: str,
        *,
        timeout_seconds: int = 1800,
        poll_seconds: int = 5,
        on_poll: Callable[[int], None] | None = None,
    ) -> dict[str, Any]:
        deadline = time.monotonic() + timeout_seconds
        while time.monotonic() < deadline:
            payload = self.history(prompt_id)
            if prompt_id in payload:
                result = payload[prompt_id]
                status = result.get("status", {})
                if status.get("status_str") == "success":
                    return result
                raise ComfyApiError(f"Prompt failed: {json.dumps(status, ensure_ascii=False)}")
            if on_poll:
                on_poll(int(timeout_seconds - max(0, deadline - time.monotonic())))
            time.sleep(poll_seconds)
        raise TimeoutError(f"ComfyUI prompt timed out: {prompt_id}")

    def download_image(self, image_meta: dict[str, Any], output_path: Path) -> None:
        output_path.parent.mkdir(parents=True, exist_ok=True)
        url = self.base_url + "/view?" + urlencode({
            "filename": image_meta["filename"],
            "subfolder": image_meta.get("subfolder", ""),
            "type": image_meta.get("type", "output"),
        })
        _download(url, output_path)


def first_output_image(history_result: dict[str, Any]) -> dict[str, Any]:
    for node in (history_result.get("outputs") or {}).values():
        images = node.get("images") or []
        if images:
            return images[0]
    raise ComfyApiError("No image output found in ComfyUI history")


def nomos_4x_prompt(input_image_name: str, *, prefix: str = "codex_nomos4x") -> dict[str, Any]:
    return {
        "1": {"class_type": "LoadImage", "inputs": {"image": input_image_name}},
        "2": {
            "class_type": "UpscaleModelLoader",
            "inputs": {"model_name": "4xNomos8kSCHAT-L.pth"},
        },
        "3": {
            "class_type": "ImageUpscaleWithModel",
            "inputs": {"upscale_model": ["2", 0], "image": ["1", 0]},
        },
        "4": {
            "class_type": "SaveImage",
            "inputs": {"filename_prefix": prefix, "images": ["3", 0]},
        },
    }
