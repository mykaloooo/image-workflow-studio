import os
import re
import time
import uuid
import base64
import json
from threading import Lock
from typing import Any, Callable, Optional
from urllib.parse import quote

import requests
from flask import Blueprint, jsonify, request


EAGLE_API_BASE = "http://localhost:41595"
GEN_SUBFOLDER_NAME = "gen"


def create_eagle_canvas_import_blueprint(output_folder: str, history_store: Any = None, log_func: Optional[Callable[[str, str], None]] = None) -> Blueprint:
    bp = Blueprint("eagle_canvas_import", __name__, url_prefix="/api/eagle")
    canvas_import_lock = Lock()
    canvas_import_batches: list[dict] = []
    targeted_canvas_import_batches: dict[str, list[dict]] = {}
    active_canvas_lock = Lock()
    active_canvases: dict[str, dict] = {}

    def log(message: str, level: str = "info") -> None:
        if log_func:
            try:
                log_func(message, level)
                return
            except Exception:
                pass
        print(message)

    def eagle_json(method: str, path: str, **kwargs: Any) -> dict:
        resp = requests.request(method, f"{EAGLE_API_BASE}{path}", timeout=kwargs.pop("timeout", 15), **kwargs)
        try:
            data = resp.json()
        except Exception as exc:
            raise RuntimeError(f"Eagle API 返回不是 JSON: HTTP {resp.status_code}") from exc
        if resp.status_code != 200 or data.get("status") != "success":
            raise RuntimeError(data.get("message") or data.get("error") or str(data)[:300])
        return data

    def prune_canvas_import_batches() -> None:
        now = time.time()
        canvas_import_batches[:] = [
            batch for batch in canvas_import_batches
            if now - float(batch.get("createdAt") or 0) < 600
        ]
        for canvas_id in list(targeted_canvas_import_batches.keys()):
            batches = [
                batch for batch in targeted_canvas_import_batches.get(canvas_id, [])
                if now - float(batch.get("createdAt") or 0) < 600
            ]
            if batches:
                targeted_canvas_import_batches[canvas_id] = batches
            else:
                targeted_canvas_import_batches.pop(canvas_id, None)

    def prune_active_canvases() -> None:
        now = time.time()
        for canvas_id, canvas in list(active_canvases.items()):
            if now - float(canvas.get("lastSeen") or 0) > 15:
                active_canvases.pop(canvas_id, None)

    def find_folder_by_id(folders: list, folder_id: str) -> Optional[dict]:
        if not folder_id:
            return None
        for folder in folders or []:
            if folder.get("id") == folder_id:
                return folder
            found = find_folder_by_id(folder.get("children") or [], folder_id)
            if found:
                return found
        return None

    def find_child_folder_by_name(parent_folder: dict, child_name: str) -> Optional[dict]:
        target = str(child_name or "").strip().lower()
        for child in parent_folder.get("children") or []:
            if str(child.get("name") or "").strip().lower() == target:
                return child
        return None

    def is_product_final_folder_name(name: str) -> bool:
        return bool(re.match(r"^P\d+(?![a-zA-Z0-9])", str(name or "").strip()))

    def ensure_gen_subfolder(parent_folder_id: str) -> str:
        folders = eagle_json("GET", "/api/folder/list", timeout=20).get("data") or []
        parent = find_folder_by_id(folders, parent_folder_id)
        if not parent:
            raise ValueError(f"找不到 Eagle 源文件夹: {parent_folder_id}")
        parent_name = str(parent.get("name") or "").strip()
        if parent_name.lower() == GEN_SUBFOLDER_NAME:
            return parent.get("id")
        if is_product_final_folder_name(parent_name):
            raise ValueError(f"源文件夹“{parent_name}”是 P* 成品目录，不写入临时 gen。请从素材父文件夹转画布。")
        existing = find_child_folder_by_name(parent, GEN_SUBFOLDER_NAME)
        if existing and existing.get("id"):
            return existing.get("id")
        created = eagle_json(
            "POST",
            "/api/folder/create",
            json={"folderName": GEN_SUBFOLDER_NAME, "parent": parent.get("id")},
            timeout=20,
        )
        folder_id = (created.get("data") or {}).get("id")
        if not folder_id:
            raise RuntimeError("Eagle 创建 gen 文件夹后没有返回 folderId")
        return folder_id

    def resolve_output_path(image_url: str, filename: str) -> tuple[str, str]:
        raw = str(filename or "").strip()
        if not raw:
            url = str(image_url or "").split("?", 1)[0].replace("\\", "/")
            for prefix in ("/api/images/", "/api/outputs/"):
                if url.startswith(prefix):
                    raw = url[len(prefix):]
                    break
        basename = os.path.basename(raw.replace("\\", "/"))
        if not basename:
            raise ValueError("缺少画布图片文件名")
        root = os.path.abspath(output_folder)
        filepath = os.path.abspath(os.path.join(root, basename))
        if os.path.commonpath([root, filepath]) != root:
            raise ValueError("图片路径不在输出目录内")
        if not os.path.exists(filepath):
            raise FileNotFoundError(f"找不到本地生成图: {basename}")
        return filepath, basename

    def list_eagle_items(folder_id: str) -> list:
        items = []
        limit = 200
        for offset in range(0, 10000, limit):
            data = eagle_json(
                "GET",
                f"/api/item/list?folderId={quote(folder_id)}&limit={limit}&offset={offset}",
                timeout=20,
            ).get("data")
            batch = data if isinstance(data, list) else (data.get("items") if isinstance(data, dict) else [])
            if not isinstance(batch, list):
                batch = []
            items.extend(batch)
            if len(batch) < limit:
                break
        return items

    def find_existing_import(folder_id: str, history_record_id: str, output_filename: str) -> Optional[dict]:
        output_marker = f"Studio输出文件: {output_filename}"
        history_marker = f"Studio历史ID: {history_record_id}" if history_record_id else ""
        for item in list_eagle_items(folder_id):
            annotation = str(item.get("annotation") or item.get("notes") or "")
            if output_marker in annotation and (not history_marker or history_marker in annotation):
                return item
        return None

    def extract_eagle_ids(data: dict) -> list[str]:
        result: list[str] = []
        targets = [data]
        if isinstance(data.get("data"), dict):
            targets.append(data.get("data"))
        elif isinstance(data.get("data"), str) and data.get("data"):
            result.append(str(data.get("data")))
        for target in targets:
            for key in ("id", "itemId"):
                value = target.get(key)
                if value:
                    result.append(str(value))
            for key in ("ids", "itemIds"):
                value = target.get(key)
                if isinstance(value, list):
                    result.extend(str(item) for item in value if item)
            value = target.get("items")
            if isinstance(value, list):
                result.extend(str(item.get("id")) for item in value if isinstance(item, dict) and item.get("id"))
        return list(dict.fromkeys(result))

    def verify_item_in_folder(item_id: str, folder_id: str, retries: int = 2) -> bool:
        for attempt in range(retries + 1):
            try:
                data = eagle_json("GET", f"/api/item/info?id={quote(item_id)}", timeout=10).get("data") or {}
                folders = data.get("folders") if isinstance(data, dict) else []
                if isinstance(folders, list) and folder_id in folders:
                    return True
            except Exception:
                pass
            if attempt < retries:
                time.sleep(0.3)
        return False

    def generation_meta_marker(meta: dict) -> str:
        encoded = base64.b64encode(json.dumps(meta, ensure_ascii=False).encode("utf-8")).decode("ascii")
        return f"[[KAKA_GENERATION_META:{encoded}]]"

    def build_reference_meta(data: dict) -> list:
        refs = data.get("sourceReferenceImages") or data.get("referenceImages") or []
        if not isinstance(refs, list):
            return []
        result = []
        for index, ref in enumerate(refs[:12]):
            if not isinstance(ref, dict):
                continue
            source = ref.get("eagleSource") or ref.get("sourceEagle") or {}
            result.append({
                "index": index + 1,
                "url": ref.get("url") or ref.get("imageUrl") or "",
                "name": ref.get("name") or ref.get("prompt") or "",
                "itemId": source.get("itemId") or source.get("item_id") or ref.get("sourceEagleItemId") or "",
                "folderId": source.get("folderId") or source.get("folder_id") or ref.get("sourceEagleFolderId") or "",
            })
        return result

    def build_generation_meta(data: dict, output_filename: str, history_record_id: str) -> dict:
        return {
            "version": 2,
            "source": "image-workflow-studio",
            "mode": "canvas",
            "prompt": str(data.get("prompt") or "").strip(),
            "requestPrompt": str(data.get("requestPrompt") or data.get("prompt") or "").strip(),
            "providerId": str(data.get("providerId") or data.get("provider_id") or "").strip(),
            "providerName": str(data.get("providerName") or "").strip(),
            "model": str(data.get("model") or "").strip(),
            "aspectRatio": str(data.get("aspectRatio") or data.get("aspect_ratio") or "").strip(),
            "resolution": str(data.get("resolution") or "").strip(),
            "requestField": str(data.get("requestField") or "").strip(),
            "historyRecordId": history_record_id,
            "outputFilename": output_filename,
            "references": build_reference_meta(data),
        }

    def build_annotation(data: dict, output_filename: str, history_record_id: str) -> str:
        lines = ["AI 生成 · Studio 无限画布"]
        source_name = str(data.get("sourceEagleName") or "").strip()
        source_item_id = str(data.get("sourceEagleItemId") or "").strip()
        prompt = str(data.get("prompt") or "").strip()
        request_prompt = str(data.get("requestPrompt") or "").strip()
        provider_name = str(data.get("providerName") or data.get("providerId") or data.get("provider_id") or "").strip()
        model = str(data.get("model") or "").strip()
        aspect_ratio = str(data.get("aspectRatio") or data.get("aspect_ratio") or "").strip()
        resolution = str(data.get("resolution") or "").strip()
        if source_name:
            lines.append(f"源图: {source_name}")
        if source_item_id:
            lines.append(f"源 Eagle Item: {source_item_id}")
        if provider_name or model:
            lines.append(f"模型: {provider_name or '-'} / {model or '-'}")
        if aspect_ratio or resolution:
            lines.append(f"参数: {aspect_ratio or '-'} / {resolution or '-'}")
        if history_record_id:
            lines.append(f"Studio历史ID: {history_record_id}")
        lines.append(f"Studio输出文件: {output_filename}")
        if prompt:
            lines.append("")
            lines.append("【提示词】")
            lines.append(prompt[:3000])
        if request_prompt and request_prompt != prompt:
            lines.append("")
            lines.append("【模型实际提示词】")
            lines.append(request_prompt[:3000])
        refs = build_reference_meta(data)
        if refs:
            lines.append("")
            lines.append(f"参考图: {len(refs)} 张")
            for ref in refs[:6]:
                lines.append(f"- 图{ref.get('index')}: {ref.get('name') or ref.get('itemId') or ref.get('url') or '-'}")
        lines.append(generation_meta_marker(build_generation_meta(data, output_filename, history_record_id)))
        return "\n".join(lines)

    def patch_history(record_id: str, eagle_ids: list[str]) -> None:
        if not record_id or not history_store or not eagle_ids:
            return
        try:
            record = history_store.find_by_id(record_id)
            existing = record.get("eagle_item_ids") if isinstance(record, dict) else []
            merged = list(dict.fromkeys([*(existing if isinstance(existing, list) else []), *eagle_ids]))
            history_store.patch(record_id, {"canvas_save_state": "canvas_saved", "eagle_item_ids": merged})
        except Exception as exc:
            log(f"[eagle] patch history failed: {exc}", "warn")

    @bp.post("/import-canvas-image")
    def import_canvas_image():
        data = request.get_json(silent=True) or {}
        source_folder_id = str(data.get("sourceEagleFolderId") or data.get("sourceFolderId") or "").strip()
        if not source_folder_id:
            for ref in build_reference_meta(data):
                source_folder_id = str(ref.get("folderId") or "").strip()
                if source_folder_id:
                    break
        if not source_folder_id:
            return jsonify({"success": False, "error": "这张图没有来源 Eagle 文件夹，不能自动写回 gen"}), 400
        try:
            filepath, output_filename = resolve_output_path(data.get("imageUrl") or "", data.get("filename") or "")
            target_folder_id = ensure_gen_subfolder(source_folder_id)
            history_record_id = str(data.get("historyRecordId") or "").strip()
            existing = find_existing_import(target_folder_id, history_record_id, output_filename)
            if existing:
                eagle_ids = [str(existing.get("id"))] if existing.get("id") else []
                patch_history(history_record_id, eagle_ids)
                return jsonify({
                    "success": True,
                    "deduplicated": True,
                    "targetFolderId": target_folder_id,
                    "eagleItemIds": eagle_ids,
                    "message": "这张图之前已写回 Eagle，本次未重复导入",
                })

            raw_display_name = str(data.get("displayName") or data.get("sourceEagleName") or os.path.splitext(output_filename)[0]).strip()
            display_name = os.path.basename(raw_display_name.replace("\\", "/")) or os.path.splitext(output_filename)[0]
            annotation = build_annotation(data, output_filename, history_record_id)
            result = eagle_json(
                "POST",
                "/api/item/addFromPath",
                json={"path": filepath, "name": display_name, "annotation": annotation, "folderId": target_folder_id},
                timeout=60,
            )
            eagle_ids = extract_eagle_ids(result)
            if not eagle_ids:
                imported = find_existing_import(target_folder_id, history_record_id, output_filename)
                eagle_ids = [str(imported.get("id"))] if imported and imported.get("id") else []
            if not eagle_ids:
                return jsonify({"success": False, "error": "Eagle 入库成功但没有返回 itemId，无法做去重记录"}), 502
            for eagle_id in eagle_ids:
                if not verify_item_in_folder(eagle_id, target_folder_id):
                    return jsonify({"success": False, "error": f"Eagle 入库后校验失败：{eagle_id} 不在 gen 文件夹"}), 502
            patch_history(history_record_id, eagle_ids)
            return jsonify({
                "success": True,
                "deduplicated": False,
                "targetFolderId": target_folder_id,
                "eagleItemIds": eagle_ids,
                "message": "已写回 Eagle gen 文件夹",
            })
        except FileNotFoundError as exc:
            return jsonify({"success": False, "error": str(exc)}), 404
        except ValueError as exc:
            return jsonify({"success": False, "error": str(exc)}), 400
        except Exception as exc:
            log(f"[eagle] import canvas image failed: {exc}", "warn")
            return jsonify({"success": False, "error": str(exc)}), 502

    @bp.post("/canvas-imports")
    def enqueue_canvas_imports():
        data = request.get_json(silent=True) or {}
        images = data.get("images") or []
        target_canvas_id = str(data.get("targetCanvasId") or data.get("canvasId") or "").strip()
        if not isinstance(images, list) or not images:
            return jsonify({"success": False, "error": "没有可转入画布的图片"}), 400
        safe_images = [image for image in images[:50] if isinstance(image, dict) and image.get("url")]
        if not safe_images:
            return jsonify({"success": False, "error": "没有有效图片 URL"}), 400
        with canvas_import_lock:
            prune_canvas_import_batches()
            batch_id = str(uuid.uuid4())
            batch = {
                "id": batch_id,
                "createdAt": time.time(),
                "images": safe_images,
            }
            if target_canvas_id:
                targeted_canvas_import_batches.setdefault(target_canvas_id, []).append(batch)
            else:
                canvas_import_batches.append(batch)
        return jsonify({"success": True, "batchId": batch_id, "count": len(safe_images)})

    @bp.get("/canvas-imports")
    def consume_canvas_imports():
        canvas_id = str(request.args.get("canvasId") or "").strip()
        with canvas_import_lock:
            prune_canvas_import_batches()
            if canvas_id:
                batches = list(targeted_canvas_import_batches.pop(canvas_id, []))
            else:
                batches = list(canvas_import_batches)
                canvas_import_batches.clear()
        images = []
        for batch in batches:
            for image in batch.get("images") or []:
                if isinstance(image, dict) and image.get("url"):
                    images.append(image)
        return jsonify({"success": True, "images": images, "count": len(images)})

    @bp.post("/canvases/heartbeat")
    def canvas_heartbeat():
        data = request.get_json(silent=True) or {}
        canvas_id = str(data.get("canvasId") or "").strip()
        if not canvas_id:
            return jsonify({"success": False, "error": "缺少 canvasId"}), 400
        now = time.time()
        with active_canvas_lock:
            prune_active_canvases()
            existing = active_canvases.get(canvas_id) or {}
            active_canvases[canvas_id] = {
                "canvasId": canvas_id,
                "projectId": str(data.get("projectId") or "").strip(),
                "projectName": str(data.get("projectName") or "未命名项目").strip() or "未命名项目",
                "isDraft": bool(data.get("isDraft")),
                "nodeCount": int(data.get("nodeCount") or 0),
                "windowName": str(data.get("windowName") or "").strip(),
                "firstSeen": float(existing.get("firstSeen") or now),
                "lastSeen": now,
            }
        return jsonify({"success": True})

    @bp.get("/canvases")
    def list_canvases():
        with active_canvas_lock:
            prune_active_canvases()
            canvases = sorted(active_canvases.values(), key=lambda item: float(item.get("lastSeen") or 0), reverse=True)
        return jsonify({"success": True, "canvases": canvases, "count": len(canvases)})

    return bp
