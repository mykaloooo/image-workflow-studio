"""
图片工作流后端 API
基于 Google Gemini Official API
"""

import builtins
from collections import deque
from flask import Flask, request, jsonify, send_from_directory, send_file
from flask_cors import CORS
import os
import copy
import base64
from datetime import datetime
from PIL import Image, ImageOps, ImageChops
from io import BytesIO
import traceback
import json
import math
import zipfile
import shutil
import socket
import re
import time
import uuid
import subprocess
import shlex
from threading import Lock, Thread
import requests  # 用于下载图片

# 生图历史子系统 (Phase 1: generation-history-unified-panel)
# history_recorder 会懒加载 app 的 push_runtime_log / load_system_config，所以可以直接 import。
from history_store import HistoryStore
from history_api import bp as history_bp
import history_recorder
from eagle_canvas_import import create_eagle_canvas_import_blueprint
from integrations.chenyu_comfy import CHENYU_API_BASE_URL, ChenyuApiError, ChenyuClient
from utils.subprocess_helpers import run_silent  # 跨平台 subprocess 封装（Windows 自动隐藏窗口，见 .windsurf/rules.md）

# Google Gemini SDK
from google import genai
from google.genai import types

# OpenAI SDK (兼容模式)
try:
    from openai import OpenAI

    HAS_OPENAI = True
except ImportError:
    HAS_OPENAI = False

app = Flask(__name__)
CORS(app)

RUNTIME_LOG_MAX = 500
RUNTIME_LOG_MAX_CHARS = 1200
runtime_logs = deque(maxlen=RUNTIME_LOG_MAX)
runtime_log_lock = Lock()
runtime_log_counter = 0

try:
    IDLE_SHUTDOWN_SECONDS = int(os.environ.get("STUDIO_IDLE_SHUTDOWN_SECONDS", "0") or 0)
except ValueError:
    IDLE_SHUTDOWN_SECONDS = 0
last_request_at = time.time()
idle_shutdown_lock = Lock()


@app.before_request
def touch_idle_shutdown_timer():
    global last_request_at
    if IDLE_SHUTDOWN_SECONDS > 0:
        with idle_shutdown_lock:
            last_request_at = time.time()


def start_idle_shutdown_watcher():
    if IDLE_SHUTDOWN_SECONDS <= 0:
        return

    def watch_idle():
        while True:
            time.sleep(min(60, max(5, IDLE_SHUTDOWN_SECONDS // 4)))
            with idle_shutdown_lock:
                idle_for = time.time() - last_request_at
            if idle_for >= IDLE_SHUTDOWN_SECONDS:
                print(f"空闲 {int(idle_for)} 秒，自动退出 Studio 后端")
                os._exit(0)

    Thread(target=watch_idle, daemon=True).start()

def _sanitize_runtime_log_text(message):
    text = str(message or "").strip()
    if not text:
        return ""
    original_len = len(text)
    if "data:image" in text:
        text = re.sub(r"data:image/[^,;\s]+;base64,[A-Za-z0-9+/=\r\n]+", lambda m: m.group(0)[:64] + f"...[data-uri {len(m.group(0))} chars]", text)
    if len(text) > RUNTIME_LOG_MAX_CHARS:
        text = f"{text[:RUNTIME_LOG_MAX_CHARS]}...[truncated {original_len} chars]"
    return text

def push_runtime_log(message, level="info"):
    global runtime_log_counter
    text = _sanitize_runtime_log_text(message)
    if not text:
        return
    with runtime_log_lock:
        runtime_log_counter += 1
        runtime_logs.append(
            {
                "id": runtime_log_counter,
                "time": datetime.now().strftime("%H:%M:%S"),
                "message": text,
                "level": level,
            }
        )

def print(*args, **kwargs):
    level = kwargs.pop("level", "info")
    sep = kwargs.get("sep", " ")
    end = kwargs.get("end", "\n")
    message = sep.join(str(arg) for arg in args)
    if end and end != "\n":
        message = f"{message}{end}"
    safe_message = _sanitize_runtime_log_text(message)
    push_runtime_log(safe_message, level=level)
    return builtins.print(safe_message, **kwargs)

# 配置
OUTPUT_FOLDER = os.path.join(os.path.dirname(__file__), "outputs")
os.makedirs(OUTPUT_FOLDER, exist_ok=True)

FRONTEND_DIR = os.path.join(os.path.dirname(__file__), "..", "frontend", "dist")

# 系统配置文件路径
CONFIG_FILE = os.path.join(os.path.dirname(__file__), "system_config.json")
RECOVERY_FILE = os.path.join(os.path.dirname(__file__), "generation_recovery.json")
RECOVERY_PATROL_INTERVAL_SECONDS = 60
RECOVERY_EAGLE_IMPORT_DELAY_SECONDS = 120
RECOVERY_REMOTE_CLEANUP_INTERVAL_SECONDS = 300
RECOVERY_REMOTE_DELETE_GRACE_SECONDS = 3600
RECOVERY_REMOTE_MAX_BYTES = 3 * 1024 * 1024 * 1024
RECOVERY_REMOTE_TARGET_BYTES = int(2.5 * 1024 * 1024 * 1024)
RECOVERY_REMOTE_HOST = "root@108.61.180.83"
RECOVERY_REMOTE_IMAGE_DIR = "/opt/chatgpt2api/data/images"
RECOVERY_REMOTE_IMAGE_URL_PREFIX = "http://108.61.180.83:8006/images/"
recovery_lock = Lock()
recovery_patrol_started = False
last_remote_cleanup_at = 0


def recovery_now():
    return datetime.now().isoformat(timespec="seconds")


def recovery_read_unlocked():
    if not os.path.exists(RECOVERY_FILE):
        return []
    try:
        with open(RECOVERY_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, list) else []
    except Exception:
        return []


def recovery_write_unlocked(records):
    tmp_path = f"{RECOVERY_FILE}.tmp"
    with open(tmp_path, "w", encoding="utf-8") as f:
        json.dump(records, f, ensure_ascii=False, indent=2)
    os.replace(tmp_path, RECOVERY_FILE)


def recovery_create(remote_url, *, prompt="", model="", size="", quality="", task_meta=None, status="remote_ready"):
    record = {
        "id": uuid.uuid4().hex,
        "status": status,
        "remote_url": remote_url,
        "prompt": prompt,
        "model": model,
        "size": size,
        "quality": quality,
        "task_meta": task_meta if isinstance(task_meta, dict) else {},
        "created_at": recovery_now(),
        "updated_at": recovery_now(),
        "attempts": 0,
    }
    with recovery_lock:
        records = recovery_read_unlocked()
        records.append(record)
        recovery_write_unlocked(records)
    return record


def recovery_update(record_id, **updates):
    if not record_id:
        return None
    with recovery_lock:
        records = recovery_read_unlocked()
        found = None
        for record in records:
            if record.get("id") == record_id:
                record.update(updates)
                record["updated_at"] = recovery_now()
                found = record
                break
        recovery_write_unlocked(records)
    return found


def recovery_list(statuses=None):
    with recovery_lock:
        records = recovery_read_unlocked()
    if statuses:
        wanted = set(statuses)
        records = [record for record in records if record.get("status") in wanted]
    return records


def recovery_get(record_id):
    if not record_id:
        return None
    with recovery_lock:
        records = recovery_read_unlocked()
    for record in records:
        if record.get("id") == record_id:
            return record
    return None


def recovery_mark_eagle_imported(record_id, eagle_ids=None, eagle_data=None):
    updates = {
        "status": "eagle_imported",
        "eagle_ids": eagle_ids or [],
        "eagle_data": eagle_data or {},
        "eagle_imported_at": recovery_now(),
    }
    return recovery_update(record_id, **updates)


def recovery_download_record(record):
    record_id = record.get("id")
    remote_url = str(record.get("remote_url") or "").strip()
    if not record_id or not remote_url:
        return None
    attempts = int(record.get("attempts") or 0) + 1
    recovery_update(record_id, attempts=attempts, last_checked_at=recovery_now())
    try:
        if remote_url.startswith("data:"):
            comma = remote_url.find(",")
            if comma < 0:
                recovery_update(record_id, status="download_abandoned", last_error="invalid data URI")
                return None
            header = remote_url[5:comma]
            body = remote_url[comma + 1:]
            if "base64" not in header.lower():
                recovery_update(record_id, status="download_abandoned", last_error="unsupported data URI")
                return None
            content = base64.b64decode(body)
        else:
            resp = requests.get(remote_url, timeout=180)
            if resp.status_code != 200:
                recovery_update(
                    record_id,
                    status="download_failed",
                    last_error=f"HTTP {resp.status_code}",
                )
                return None
            content = resp.content
        img_result = generator._save_and_process_image(
            content,
            target_size=record.get("size"),
        )
        width = None
        height = None
        try:
            _img = Image.open(BytesIO(content))
            width, height = _img.width, _img.height
        except Exception:
            pass
        recovery_update(
            record_id,
            status="downloaded",
            local_path=img_result.get("filepath"),
            local_url=img_result.get("url"),
            downloaded_at=recovery_now(),
            width=width,
            height=height,
            last_error="",
        )
        src = "data URI" if remote_url.startswith("data:") else "远端图片"
        print(f"[Recovery] 已补拉{src}: {remote_url}")
        return img_result
    except Exception as e:
        recovery_update(
            record_id,
            status="download_failed",
            last_error=str(e),
        )
        print(f"[Recovery] 补拉失败: {remote_url} | {e}", level="error")
        return None


def recovery_import_to_eagle(record):
    record_id = record.get("id")
    task_meta = record.get("task_meta") if isinstance(record.get("task_meta"), dict) else {}
    if not record_id or not task_meta.get("auto_import_to_eagle"):
        return False
    local_path = record.get("local_path")
    if not local_path or not os.path.exists(local_path):
        recovery_update(record_id, status="download_failed", last_error="local_path missing")
        return False

    downloaded_at = record.get("downloaded_at") or record.get("updated_at") or ""
    try:
        downloaded_ts = datetime.fromisoformat(downloaded_at).timestamp()
    except Exception:
        downloaded_ts = 0
    if time.time() - downloaded_ts < RECOVERY_EAGLE_IMPORT_DELAY_SECONDS:
        return False

    display_name = task_meta.get("display_name") or os.path.basename(local_path)
    annotation = task_meta.get("annotation") or f"AI 生成 · prompt: {record.get('prompt') or ''}"
    folder_id = task_meta.get("folder_id")
    item = {
        "path": local_path,
        "name": display_name,
        "annotation": annotation,
    }
    if folder_id:
        item["folders"] = [folder_id]
    body = {"items": [item]}
    if folder_id:
        body["folderId"] = folder_id

    try:
        resp = requests.post(
            "http://localhost:41595/api/item/addFromPaths",
            json=body,
            timeout=30,
        )
        data = resp.json()
        if resp.status_code != 200 or data.get("status") != "success":
            recovery_update(
                record_id,
                status="eagle_import_failed",
                last_error=data.get("message") or str(data)[:300],
            )
            return False
        eagle_data = data.get("data") if isinstance(data.get("data"), dict) else data
        eagle_ids = []
        if isinstance(data.get("data"), dict):
            for key in ("id", "ids"):
                value = data["data"].get(key)
                if isinstance(value, list):
                    eagle_ids.extend(value)
                elif value:
                    eagle_ids.append(value)
        recovery_mark_eagle_imported(record_id, eagle_ids=eagle_ids, eagle_data=eagle_data)
        print(f"[Recovery] 已自动导入 Eagle: {display_name}")
        return True
    except Exception as e:
        recovery_update(
            record_id,
            status="eagle_import_failed",
            last_error=str(e),
        )
        return False


def recovery_remote_image_path(remote_url):
    url = str(remote_url or "").strip()
    if not url.startswith(RECOVERY_REMOTE_IMAGE_URL_PREFIX):
        return None
    relative = url[len(RECOVERY_REMOTE_IMAGE_URL_PREFIX):].lstrip("/")
    if not relative or ".." in relative.replace("\\", "/").split("/"):
        return None
    return f"{RECOVERY_REMOTE_IMAGE_DIR.rstrip('/')}/{relative}"


def recovery_run_remote(command, timeout=20):
    try:
        result = run_silent(
            ["ssh", RECOVERY_REMOTE_HOST, command],
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        if result.returncode != 0:
            return None, (result.stderr or result.stdout or "").strip()
        return (result.stdout or "").strip(), ""
    except Exception as e:
        return None, str(e)


def recovery_remote_dir_size():
    cmd = f"du -sb {shlex.quote(RECOVERY_REMOTE_IMAGE_DIR)} 2>/dev/null | cut -f1"
    output, error = recovery_run_remote(cmd, timeout=20)
    if error or not output:
        return None, error or "empty du output"
    try:
        return int(output.splitlines()[0].strip()), ""
    except Exception as e:
        return None, str(e)


def recovery_delete_remote_file(record):
    remote_path = recovery_remote_image_path(record.get("remote_url"))
    if not remote_path:
        return 0
    quoted = shlex.quote(remote_path)
    cmd = f"size=$(stat -c%s {quoted} 2>/dev/null || echo 0); rm -f -- {quoted}; echo $size"
    output, error = recovery_run_remote(cmd, timeout=20)
    if error:
        recovery_update(record.get("id"), last_cleanup_error=error)
        return 0
    try:
        deleted_bytes = int((output or "0").splitlines()[-1].strip())
    except Exception:
        deleted_bytes = 0
    recovery_update(
        record.get("id"),
        remote_deleted=True,
        remote_deleted_at=recovery_now(),
        remote_deleted_bytes=deleted_bytes,
    )
    return deleted_bytes


def recovery_cleanup_remote_if_needed(force=False):
    global last_remote_cleanup_at
    now = time.time()
    if not force and now - last_remote_cleanup_at < RECOVERY_REMOTE_CLEANUP_INTERVAL_SECONDS:
        return {"skipped": "cooldown"}
    last_remote_cleanup_at = now

    total_size, error = recovery_remote_dir_size()
    if error:
        return {"success": False, "error": error}
    if total_size is None or total_size <= RECOVERY_REMOTE_MAX_BYTES:
        return {"success": True, "remote_bytes": total_size or 0, "deleted": 0}

    eligible = []
    for record in recovery_list(["eagle_imported"]):
        if record.get("remote_deleted"):
            continue
        remote_path = recovery_remote_image_path(record.get("remote_url"))
        if not remote_path:
            continue
        imported_at = record.get("eagle_imported_at") or record.get("updated_at") or ""
        try:
            imported_ts = datetime.fromisoformat(imported_at).timestamp()
        except Exception:
            imported_ts = 0
        if now - imported_ts < RECOVERY_REMOTE_DELETE_GRACE_SECONDS:
            continue
        eligible.append((imported_ts, record))

    eligible.sort(key=lambda item: item[0])
    deleted = 0
    deleted_bytes = 0
    remaining = total_size
    for _, record in eligible:
        if remaining <= RECOVERY_REMOTE_TARGET_BYTES:
            break
        size = recovery_delete_remote_file(record)
        if size > 0:
            deleted += 1
            deleted_bytes += size
            remaining -= size

    return {
        "success": True,
        "remote_bytes_before": total_size,
        "remote_bytes_after_estimated": remaining,
        "deleted": deleted,
        "deleted_bytes": deleted_bytes,
        "eligible": len(eligible),
    }


def recovery_patrol_once():
    summary = {"downloaded": 0, "imported": 0, "checked": 0}
    records = recovery_list(["remote_ready", "download_failed", "downloaded", "eagle_import_failed"])
    for record in records:
        summary["checked"] += 1
        current = record
        if record.get("status") in {"remote_ready", "download_failed"}:
            img_result = recovery_download_record(record)
            if img_result:
                summary["downloaded"] += 1
                current = recovery_get(record.get("id")) or record
        if current.get("status") in {"downloaded", "eagle_import_failed"}:
            if recovery_import_to_eagle(current):
                summary["imported"] += 1
    summary["remote_cleanup"] = recovery_cleanup_remote_if_needed()
    return summary


def start_recovery_patrol():
    global recovery_patrol_started
    if recovery_patrol_started:
        return
    recovery_patrol_started = True

    def patrol_loop():
        while True:
            time.sleep(RECOVERY_PATROL_INTERVAL_SECONDS)
            try:
                recovery_patrol_once()
            except Exception as e:
                print(f"[Recovery] 巡逻任务异常: {e}", level="error")

    Thread(target=patrol_loop, daemon=True).start()

# ========== 默认配置（可在系统设置中修改） ==========
DEFAULT_CONFIG = {
    # 供应商统一管理列表
    "providers": [
        {
            "id": "default_image",
            "name": "suxi_015",
            "type": "image",
            "api_key": "",
            "api_url": "https://new.suxi.ai",
            "model": "gemini-3.1-flash-image-preview",
            "models": ["gemini-3.1-flash-image-preview"],
        },
        {
            "id": "oreapi_013",
            "name": "oreapi_013",
            "type": "image",
            "api_key": "",
            "api_url": "https://oreapi.com",
            "model": "gpt-image-2",
            "models": ["gpt-image-2", "dall-e-3"],
        },
        {
            "id": "ggboom_gpt",
            "name": "ggboom",
            "type": "image",
            "api_key": "",
            "api_url": "https://www.ggboom.online",
            "model": "gpt-image-2",
            "models": ["gpt-image-2", "dall-e-3"],
        },
        {
            "id": "duou_gpt",
            "name": "duou",
            "type": "image",
            "api_key": "",
            "api_url": "https://api.duou.ai",
            "model": "gpt-image-2",
            "models": ["gpt-image-2", "dall-e-3"],
        },
        {
            "id": "default_chat",
            "name": "默认对话配置",
            "type": "chat",
            "api_key": "",
            "api_url": "http://127.0.0.1:8045",
            "model": "gemini-3-flash",
            "models": ["gemini-3-flash"],
        },
        {
            "id": "default_video",
            "name": "默认视频配置",
            "type": "video",
            "api_key": "",
            "api_url": "",
            "model": "",
            "models": [],
        }
    ],
    "active_image_provider_id": "default_image",
    "active_chat_provider_id": "default_chat",
    "active_video_provider_id": "default_video",

    # 兼容旧配置字段（与 active_ 供应商保持同步）
    "gemini_api_key": "",
    "gemini_api_url": "https://new.suxi.ai",
    "gemini_model": "gemini-3.1-flash-image-preview",
    "chat_api_key": "",
    "chat_api_url": "http://127.0.0.1:8045",
    "chat_model": "gemini-3-flash",
    "video_api_key": "",
    "video_api_url": "",
    "video_model": "",
    "chenyu_api_key": "",
    "chenyu_api_base_url": CHENYU_API_BASE_URL,
    "proxy_url": "socks5://127.0.0.1:10808",
    "output_dir": "",
}
# ===================================================

def normalize_models(raw_models, fallback_model=""):
    models = []
    source = raw_models
    if isinstance(source, str):
        source = re.split(r"[\n,]+", source)
    for item in source or []:
        model = str(item or "").strip()
        if model and model not in models:
            models.append(model)
    fallback = str(fallback_model or "").strip()
    if fallback and fallback not in models:
        models.insert(0, fallback)
    return models

def normalize_provider(provider):
    normalized = dict(provider or {})
    normalized["api_url"] = str(
        normalized.get("api_url") or normalized.get("apiUrl") or ""
    ).strip()
    normalized["model"] = str(normalized.get("model") or "").strip()
    normalized["models"] = normalize_models(
        normalized.get("models"), normalized.get("model", "")
    )
    if not normalized["model"] and normalized["models"]:
        normalized["model"] = normalized["models"][0]
    return normalized

def normalize_providers(providers):
    return [normalize_provider(provider) for provider in providers or []]

def get_active_provider(config, provider_type):
    active_id = config.get(f"active_{provider_type}_provider_id")
    for provider in config.get("providers", []):
        if provider.get("id") == active_id and provider.get("type") == provider_type:
            return provider
    return None

def get_provider_by_id(config, provider_id, provider_type=None):
    provider_id = str(provider_id or "").strip()
    if not provider_id:
        return None
    for provider in config.get("providers", []):
        if provider.get("id") != provider_id:
            continue
        if provider_type and provider.get("type") != provider_type:
            continue
        return provider
    return None

def upgrade_config(config):
    """升级旧配置到统一且带类型的 providers 列表"""
    new_providers = []

    def add_from_list(cat, prefix):
        for p in config.get(f"{cat}_providers", []):
            new_providers.append({
                "id": p.get("id"),
                "name": p.get("name"),
                "type": cat,
                "api_key": p.get("api_key", ""),
                "api_url": p.get("api_url", ""),
                "model": p.get("model", ""),
                "models": normalize_models(p.get("models"), p.get("model", "")),
            })

    # 从之前三个独立列表迁移
    add_from_list("image", "gemini")
    add_from_list("chat", "chat")
    add_from_list("video", "video")

    if new_providers:
        config["providers"] = new_providers
        for cat in ["image", "chat", "video"]:
            if f"{cat}_providers" in config:
                del config[f"{cat}_providers"]
    else:
        # 没有三个独立列表，可能是更老的版本
        def create_provider(pid, name, ptype, prefix):
            return {
                "id": pid,
                "name": name,
                "type": ptype,
                "api_key": config.get(f"{prefix}_api_key", ""),
                "api_url": config.get(f"{prefix}_api_url", ""),
                "model": config.get(f"{prefix}_model", ""),
                "models": normalize_models(None, config.get(f"{prefix}_model", "")),
            }

        config["providers"] = [
            create_provider("default_image", "默认图片配置", "image", "gemini"),
            create_provider("default_chat", "默认对话配置", "chat", "chat"),
            create_provider("default_video", "默认视频配置", "video", "video")
        ]
        config["active_image_provider_id"] = "default_image"
        config["active_chat_provider_id"] = "default_chat"
        config["active_video_provider_id"] = "default_video"

        # 移除 v2 遗留
        if "active_provider_id" in config:
            del config["active_provider_id"]

    return config

# ========== 配置防护：写前备份、schema 校验、load 异常告警 ==========
# 防止 system_config.json 被误操作砍掉一大半 providers（之前 BOM 事件就是因为静默 fallback）

CONFIG_STATS_FILE = os.path.join(os.path.dirname(__file__), '.config-stats.json')
CONFIG_AUTO_BAK_KEEP = 10  # 自动备份保留份数

def _read_config_stats():
    if not os.path.exists(CONFIG_STATS_FILE):
        return {}
    try:
        with open(CONFIG_STATS_FILE, 'r', encoding='utf-8-sig') as f:
            return json.load(f) or {}
    except Exception:
        return {}

def _write_config_stats(stats):
    try:
        with open(CONFIG_STATS_FILE, 'w', encoding='utf-8') as f:
            json.dump(stats, f, ensure_ascii=False, indent=2)
    except Exception as e:
        print(f"[config-stats] 写入失败但继续: {e}")

def _auto_backup_config_file():
    """写前自动备份，保留最近 CONFIG_AUTO_BAK_KEEP 份"""
    if not os.path.exists(CONFIG_FILE):
        return
    try:
        ts = time.strftime('%Y%m%d-%H%M%S')
        bak = f"{CONFIG_FILE}.bak-auto-{ts}"
        shutil.copy2(CONFIG_FILE, bak)
        # 清理：只保留最近 N 份 auto 备份
        bak_dir = os.path.dirname(CONFIG_FILE) or '.'
        auto_baks = sorted([
            os.path.join(bak_dir, fn) for fn in os.listdir(bak_dir)
            if fn.startswith('system_config.json.bak-auto-')
        ])
        for old in auto_baks[:-CONFIG_AUTO_BAK_KEEP]:
            try: os.remove(old)
            except Exception: pass
    except Exception as e:
        print(f"[_auto_backup_config_file] 备份失败但继续: {e}")

def _validate_config_or_raise(cfg):
    """写前 schema 校验。拒绝把 image providers 砍到历史最大值的一半以下。"""
    providers = cfg.get("providers", [])
    if not isinstance(providers, list):
        raise ValueError(f"providers 必须是数组，当前是 {type(providers).__name__}")

    image_count = sum(1 for p in providers if p.get("type") == "image")
    default_image_count = sum(1 for p in DEFAULT_CONFIG.get("providers", []) if p.get("type") == "image")
    stats = _read_config_stats()
    historical_max = max(int(stats.get('max_image_providers', 0)), default_image_count)

    # 红线：image providers < 历史峰值的一半 → 极可能是误操作（比如 BOM fallback 后 save）
    if historical_max > 0 and image_count * 2 < historical_max:
        raise ValueError(
            f"image providers 从历史最大 {historical_max} 砍到 {image_count}，跌幅 >50%，已拒绝写入。"
            f"如确认本意要这么做，请先删除 backend/.config-stats.json 再保存。"
        )

def _update_config_stats_after_save(cfg):
    providers = cfg.get("providers", [])
    image_count = sum(1 for p in providers if p.get("type") == "image")
    stats = _read_config_stats()
    stats['max_image_providers'] = max(int(stats.get('max_image_providers', 0)), image_count)
    stats['last_image_providers'] = image_count
    stats['last_updated'] = time.strftime('%Y-%m-%d %H:%M:%S')
    _write_config_stats(stats)

# ========== 加载/保存 ==========

def _canonicalize_jp_provider_urls(config):
    """Keep JP image providers off the flaky 100.67 route."""
    replacements = {
        "http://100.67.104.25:8017": "http://108.61.180.83:8017",
        "http://100.67.104.25:9080": "http://108.61.180.83:9080",
    }
    for provider in config.get("providers", []) or []:
        if provider.get("id") in {"chat2api_japan_plus", "cpa_japan", "cpa_japan_chat"}:
            api_url = str(provider.get("api_url") or "").rstrip("/")
            if api_url in replacements:
                provider["api_url"] = replacements[api_url]
    return config

def load_system_config():
    """加载系统配置（合并默认值）"""
    config = copy.deepcopy(DEFAULT_CONFIG)
    loaded_from_disk = False
    if os.path.exists(CONFIG_FILE):
        try:
            # 用 utf-8-sig 容忍偶发的 UTF-8 BOM（PowerShell Set-Content/Out-File 常会写入 BOM，
            # 普通 utf-8 解析会抛 Unexpected UTF-8 BOM 让整个 providers 回退到 DEFAULT_CONFIG）
            with open(CONFIG_FILE, "r", encoding="utf-8-sig") as f:
                saved_config = json.load(f)
                # 合并保存的配置（覆盖默认值）
                for key, value in saved_config.items():
                    if value is not None:  # 只覆盖非 None 值（允许空字符串，比如 API URL）
                        config[key] = value

                # 处理兼容性：如果没有统一的 providers 且每个 provider 有 type
                if "providers" not in saved_config or (len(saved_config["providers"]) > 0 and "type" not in saved_config["providers"][0]):
                    config = upgrade_config(config)
                loaded_from_disk = True
        except Exception as e:
            # CRITICAL：fallback 到 DEFAULT 是危险状态，必须 LOUD，否则用户根本察觉不到
            print("=" * 72)
            print(f"!!! [CRITICAL] system_config.json 解析失败，已回退到 DEFAULT_CONFIG")
            print(f"!!! 错误类型: {type(e).__name__}")
            print(f"!!! 错误内容: {e}")
            print(f"!!! 影响: 内存中 providers 暂时变成 DEFAULT 列表（约 {len(DEFAULT_CONFIG.get('providers', []))} 个）")
            print(f"!!! 排查: 1) 检查文件是否带 BOM (file 命令或 xxd 看头 3 字节)")
            print(f"!!!       2) 用 python -c \"import json; json.load(open(r'{CONFIG_FILE}'))\" 复现")
            print(f"!!!       3) 从 backend/system_config.json.bak-* 恢复")
            print("=" * 72)

    config["providers"] = normalize_providers(config.get("providers", []))
    config = _canonicalize_jp_provider_urls(config)

    # load 完后健康度自检：image providers 数量明显低于历史峰值时 LOUD 一次
    if loaded_from_disk:
        image_count = sum(1 for p in config.get("providers", []) if p.get("type") == "image")
        stats = _read_config_stats()
        hist_max = int(stats.get('max_image_providers', 0))
        if hist_max > 0 and image_count * 2 < hist_max:
            print("=" * 72)
            print(f"!!! [WARN] image providers 当前 {image_count} 个 < 历史最大 {hist_max} 个的一半")
            print(f"!!! 可能 system_config.json 已被覆盖。如非本意请从 backend/system_config.json.bak-* 恢复。")
            print("=" * 72)

    # 将活跃提供商的值同步到根级别，供后续直接 get("gemini_api_key") 使用
    for cat, prefix in [("image", "gemini"), ("chat", "chat"), ("video", "video")]:
        provider = get_active_provider(config, cat)
        if provider:
            config[f"{prefix}_api_key"] = provider.get("api_key", "")
            config[f"{prefix}_api_url"] = provider.get("api_url", "")
            config[f"{prefix}_model"] = provider.get("model", "")

    return config

def save_system_config(config):
    """保存系统配置（带写前备份 + schema 校验）"""
    try:
        config = copy.deepcopy(config)
        config["providers"] = normalize_providers(config.get("providers", []))
        config = _canonicalize_jp_provider_urls(config)

        # 防线 1：schema 校验（拒绝把 providers 砍掉一半以上）
        try:
            _validate_config_or_raise(config)
        except ValueError as ve:
            print("=" * 72)
            print(f"!!! [REJECT] 拒绝保存 system_config.json: {ve}")
            print("=" * 72)
            return False

        # 防线 2：写前自动备份
        _auto_backup_config_file()

        with open(CONFIG_FILE, "w", encoding="utf-8") as f:
            json.dump(config, f, ensure_ascii=False, indent=2)

        # 防线 3：保存成功后更新历史峰值（让校验器学到本次的健康数量）
        _update_config_stats_after_save(config)
        return True
    except Exception as e:
        print(f"保存配置失败: {e}")
        return False


# ================== 生图历史子系统初始化 ==================
# Requirements 5, 6, 22, 25：从 system_config.json 读配置，缺省自动兜底。
def _init_history_subsystem():
    try:
        cfg = load_system_config()
    except Exception as exc:
        print(f"[history] 读取 system_config 失败，使用默认值: {exc}", level="warn")
        cfg = {}

    # Requirement 6.2：machine_id 未配置时使用主机名小写兜底并打印警告
    raw_machine_id = cfg.get("machine_id")
    if isinstance(raw_machine_id, str) and raw_machine_id.strip():
        machine_id = raw_machine_id.strip()
    else:
        machine_id = socket.gethostname().lower()
        print(
            f"[history] system_config.machine_id 未配置，使用主机名回退: {machine_id}",
            level="warn",
        )

    # Requirement 22.3：peer_machines 必须带 http:// 或 https:// 前缀，否则跳过
    raw_peers = cfg.get("peer_machines") or []
    peer_machines: list[dict] = []
    if isinstance(raw_peers, list):
        for entry in raw_peers:
            if not isinstance(entry, dict):
                continue
            base_url = str(entry.get("base_url") or "").strip()
            peer_id = str(entry.get("machine_id") or "").strip()
            if not base_url or not peer_id:
                continue
            if not (base_url.startswith("http://") or base_url.startswith("https://")):
                print(
                    f"[history] peer_machines[{peer_id}].base_url 协议不合法，已跳过: {base_url}",
                    level="warn",
                )
                continue
            peer_machines.append({"machine_id": peer_id, "base_url": base_url})

    # Requirement 5.2 / 25.1：history_store_path 默认 outputs/generation_history.jsonl
    raw_path = cfg.get("history_store_path")
    if isinstance(raw_path, str) and raw_path.strip():
        store_path = raw_path.strip()
        if not os.path.isabs(store_path):
            store_path = os.path.join(os.path.dirname(__file__), store_path)
    else:
        store_path = os.path.join(OUTPUT_FOLDER, "generation_history.jsonl")

    # Requirement 25.1：max_mb 默认 50
    raw_max_mb = cfg.get("history_store_max_mb", 50)
    try:
        max_mb = int(raw_max_mb)
    except (TypeError, ValueError):
        max_mb = 50

    store = HistoryStore(path=store_path, max_mb=max_mb)

    # 注册 Blueprint 并将运行时依赖附在 blueprint 对象上（history_api 内部 defensively 读取）
    app.register_blueprint(history_bp)
    history_bp.store = store
    history_bp.machine_id = machine_id
    history_bp.peer_machines = peer_machines
    history_bp.history_store_path = store.path
    history_bp.history_store_max_mb = store.max_mb

    app.register_blueprint(
        create_eagle_canvas_import_blueprint(
            OUTPUT_FOLDER,
            history_store=store,
            log_func=print,
        )
    )
    app.config["MACHINE_ID"] = machine_id

    # Requirement 25.2：启动日志打印实际生效的 machine_id / peer_machines
    peer_desc = (
        ", ".join(f"{p['machine_id']}={p['base_url']}" for p in peer_machines)
        or "(none)"
    )
    print(
        f"[history] 初始化完成 machine_id={machine_id} peers={peer_desc} "
        f"store={store.path} max_mb={max_mb}",
        level="info",
    )

    return machine_id, store, peer_machines


_machine_id, _history_store, _peer_machines = _init_history_subsystem()
# ================== 生图历史子系统初始化结束 ==================


@app.route("/")
def index():
    """服务前端主页面"""
    index_path = os.path.join(FRONTEND_DIR, "index.html")
    if os.path.exists(index_path):
        response = send_file(index_path)
        response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
        response.headers["Pragma"] = "no-cache"
        response.headers["Expires"] = "0"
        return response
    return (
        """
    <html>
    <head><title>图片工作流工作室</title></head>
    <body style="font-family: Arial; padding: 40px; text-align: center;">
        <h1>🎨 图片工作流工作室</h1>
        <p>前端尚未构建，请先运行:</p>
        <pre style="background: #f4f4f4; padding: 20px; display: inline-block; text-align: left;">
 cd frontend
 npm install
 npm run build
        </pre>
        <p>然后重启此服务</p>
    </body>
    </html>
    """,
        200,
        {"Content-Type": "text/html; charset=utf-8"},
    )

@app.route("/<path:filename>")
def serve_static(filename):
    """服务前端静态文件"""
    file_path = os.path.join(FRONTEND_DIR, filename)
    if os.path.exists(file_path) and os.path.isfile(file_path):
        response = send_file(file_path)
        response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
        response.headers["Pragma"] = "no-cache"
        response.headers["Expires"] = "0"
        return response
    # 对于 SPA，所有路由都返回 index.html
    index_path = os.path.join(FRONTEND_DIR, "index.html")
    if os.path.exists(index_path):
        response = send_file(index_path)
        response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
        response.headers["Pragma"] = "no-cache"
        response.headers["Expires"] = "0"
        return response
    return "Not Found", 404

class ImageGenerator:
    """图片/视频生成器"""

    def __init__(self):
        self.client = None
        self.openai_client = None  # 图片用的 OpenAI 客户端
        self.video_client = None  # 视频用的 OpenAI 客户端 (新增)
        self.use_openai = False
        self.use_openai_images = False  # 真正的 OpenAI Images API (gpt-image-2 等)
        self.use_gemini_native_http = False  # 第三方 Gemini 原生协议 (SuXi.ai 等)
        self.use_chat_image = False  # Chat-based 图像生成 (gpt-5.4-mini 等多模态模型走 chat completions)
        self.model = "gemini-3-pro-image-preview"
        self.video_model = ""  # 视频模型 (新增)
        self.output_folder = OUTPUT_FOLDER
        self.last_error = None

    def initialize(
        self,
        api_key,
        api_url=None,
        proxy_url=None,
        output_dir=None,
        model=None,
        video_api_key=None,
        video_api_url=None,
        video_model=None,
    ):
        """初始化客户端 (支持图片和视频双引擎)"""
        self.last_error = None
        self.use_openai = False
        self.use_openai_images = False
        self.use_gemini_native_http = False
        self.use_chat_image = False
        self.api_url = api_url

        # 保存视频配置
        self.video_model = video_model or "sora-1.0-turbo"

        try:
            # 1. 设置输出目录
            if output_dir and os.path.isabs(output_dir):
                self.output_folder = output_dir
                os.makedirs(self.output_folder, exist_ok=True)
                print(f"使用自定义输出目录: {self.output_folder}")
            else:
                self.output_folder = OUTPUT_FOLDER
                print(f"使用默认输出目录: {self.output_folder}")

            # 2. 初始化图片引擎 (Gemini/OpenAI)
            if model:
                self.model = model
                print(f"使用图片模型: {self.model}")

            is_local_proxy = api_url and (
                "127.0.0.1" in api_url or "localhost" in api_url or ":8045" in api_url
            )
            is_official = not api_url or "googleapis.com" in api_url
            normalized_model = (model or "").lower()
            is_openai_images = self._is_openai_images_model_name(normalized_model)
            # Chat-based 图像生成：gpt-5.x / gpt-4o / gpt-4.1 等多模态模型，通过 chat completions 端点出图
            is_chat_image = bool(normalized_model) and not is_openai_images and (
                normalized_model.startswith("gpt-5")
                or normalized_model.startswith("gpt-4o")
                or normalized_model.startswith("gpt-4.1")
            )

            if api_key and is_openai_images:
                # OpenAI Images API 模式 (gpt-image-2, dall-e-3 等)
                print(f"初始化图片引擎: OpenAI Images API 模式 (模型: {self.model})...")
                self.use_openai_images = True
                self.use_openai = False
                self.use_gemini_native_http = False
                self.api_key = api_key
                self.api_url = (api_url or "https://api.openai.com").rstrip("/")

                # 清除代理环境变量（第三方网关不需要）
                if not is_official:
                    os.environ.pop("HTTP_PROXY", None)
                    os.environ.pop("HTTPS_PROXY", None)

            elif api_key and is_official:
                # Google 原生模式 (官方)
                print("初始化图片引擎: Google 原生模式 (官方)...")
                self.use_openai = False
                self.use_gemini_native_http = False

                # 设置代理
                if proxy_url:
                    os.environ["HTTP_PROXY"] = proxy_url
                    os.environ["HTTPS_PROXY"] = proxy_url
                else:
                    os.environ.pop("HTTP_PROXY", None)
                    os.environ.pop("HTTPS_PROXY", None)

                if api_url:
                    from google.genai import client as genai_client

                    self.client = genai.Client(
                        api_key=api_key,
                        http_options=genai_client.HttpOptions(baseUrl=api_url),
                    )
                else:
                    self.client = genai.Client(api_key=api_key)

            elif api_key and is_local_proxy:
                # 本地代理模式 (保留 Antigravity hack)
                print(f"初始化图片引擎: 本地代理模式 (API: {api_url})...")
                self.use_openai = True
                self.use_gemini_native_http = False
                self.api_key = api_key
                self.api_url = api_url

            elif api_key and is_chat_image:
                # Chat-based 图像生成模式（gpt-5.4-mini / gpt-4o 等多模态模型）
                # 通过 /v1/chat/completions 端点，解析 message.images[].image_url.url 拿 base64
                print(f"初始化图片引擎: Chat-based 图像生成模式 (模型: {self.model}, API: {api_url})...")
                self.use_chat_image = True
                self.use_gemini_native_http = False
                self.use_openai = False
                self.api_key = api_key
                self.api_url = (api_url or "").rstrip("/")
                os.environ.pop("HTTP_PROXY", None)
                os.environ.pop("HTTPS_PROXY", None)

            elif api_key:
                # 第三方通用网关 (SuXi, oreapi, 等)，使用 Bearer 鉴权和原生 JSON
                print(f"初始化图片引擎: 第三方通用网关模式 (API: {api_url})...")
                self.use_gemini_native_http = True
                self.use_openai = False
                self.api_key = api_key
                self.api_url = api_url

                # 清除代理环境变量，第三方网关不需要代理
                os.environ.pop("HTTP_PROXY", None)
                os.environ.pop("HTTPS_PROXY", None)

            # 3. 初始化视频引擎 (OpenAI 兼容模式)
            if video_api_key:
                if not HAS_OPENAI:
                    print("警告: 未安装 openai 库，无法初始化视频引擎")
                else:
                    print("初始化视频引擎: OpenAI 兼容模式...")
                    v_base_url = video_api_url or "https://allapi.store/v1"
                    v_base_url = v_base_url.rstrip("/")
                    # 智能补全 /v1，如果用户没填且不是本地地址
                    if not v_base_url.endswith("/v1") and "allapi" in v_base_url:
                        v_base_url = f"{v_base_url}/v1"

                    self.video_client = OpenAI(
                        api_key=video_api_key, base_url=v_base_url
                    )
                    # 修正默认模型为 sora-2-all
                    self.video_model = video_model or "sora-2-all"
                    print(
                        f"视频引擎就绪 (URL: {v_base_url}, Model: {self.video_model})"
                    )
            else:
                print("视频 API Key 未配置，视频生成功能不可用")

            return True
        except Exception as e:
            error_msg = str(e)
            print(f"初始化失败: {error_msg}")
            self.last_error = error_msg
            return False

    def generate_video(
        self, prompt, model=None, duration=None, ratio=None, quality=None
    ):
        """生成视频 (使用 /v1/video/create 异步接口 + 轮询)"""
        import time

        # 加载配置
        config = load_system_config()
        video_api_key = config.get("video_api_key")
        video_api_url = config.get("video_api_url", "https://allapi.store")

        if not video_api_key:
            raise Exception("视频引擎未初始化，请在设置中配置视频 API Key")

        target_model = model or config.get("video_model") or "sora-2-all"

        # 参数处理
        video_duration = 10
        if duration:
            video_duration = int(duration.replace("s", ""))

        aspect_ratio = ratio or "16:9"
        video_quality = quality or "720p"

        # 根据比例和清晰度计算尺寸
        size_map = {
            "16:9": {"720p": "1280x720", "1080p": "1920x1080"},
            "9:16": {"720p": "720x1280", "1080p": "1080x1920"},
            "1:1": {"720p": "720x720", "1080p": "1080x1080"},
            "4:3": {"720p": "960x720", "1080p": "1440x1080"},
            "3:4": {"720p": "720x960", "1080p": "1080x1440"},
            "21:9": {"720p": "1680x720", "1080p": "2520x1080"},
        }
        video_size = size_map.get(aspect_ratio, {}).get(video_quality, "1280x720")

        print(f"🎬 开始生成视频: {target_model}")
        print(f"📝 提示词: {prompt}")
        print(f"⚙️ 参数: 时长={video_duration}s, 比例={aspect_ratio}, 尺寸={video_size}")

        try:
            # 构建 API URL
            base_url = video_api_url.rstrip("/")
            if base_url.endswith("/v1"):
                create_url = f"{base_url}/video/create"
                status_url_base = f"{base_url}/videos"  # 注意：状态查询用 /videos
            else:
                create_url = f"{base_url}/v1/video/create"
                status_url_base = f"{base_url}/v1/videos"  # 注意：状态查询用 /videos

            headers = {
                "Authorization": f"Bearer {video_api_key}",
                "Content-Type": "application/json",
            }

            # 创建任务
            payload = {
                "model": target_model,
                "prompt": prompt,
                "duration": video_duration,
                "size": video_size,
            }

            print(f"🔗 请求 URL: {create_url}")
            print(f"📦 请求参数: {json.dumps(payload, ensure_ascii=False)}")

            response = requests.post(
                create_url, headers=headers, json=payload, timeout=60
            )

            if response.status_code != 200:
                raise Exception(
                    f"API 返回错误 ({response.status_code}): {response.text[:500]}"
                )

            result = response.json()
            task_id = result.get("id")
            print(f"📋 任务已创建: {task_id}")

            if not task_id:
                raise Exception(f"未获取到任务 ID: {result}")

            # 轮询查询状态
            max_wait = 600  # 最长等待 10 分钟
            poll_interval = 5  # 每 5 秒查询一次
            elapsed = 0

            while elapsed < max_wait:
                time.sleep(poll_interval)
                elapsed += poll_interval

                status_url = f"{status_url_base}/{task_id}"
                status_resp = requests.get(status_url, headers=headers, timeout=30)

                if status_resp.status_code != 200:
                    print(f"⚠️ 查询状态失败: {status_resp.status_code}")
                    continue

                status_data = status_resp.json()
                status = status_data.get("status", "")
                progress = status_data.get("progress", 0)

                print(f"⏳ 状态: {status}, 进度: {progress}%")

                if status == "completed" or status == "succeeded":
                    # 获取视频 URL
                    video_url = (
                        status_data.get("url")
                        or status_data.get("video_url")
                        or status_data.get("output")
                        or status_data.get("data", {}).get("url")
                    )

                    if not video_url:
                        raise Exception(f"任务完成但未找到视频 URL: {status_data}")

                    print(f"🔗 视频链接: {video_url}")

                    # 下载视频
                    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
                    filename = f"video_{timestamp}.mp4"
                    filepath = os.path.join(self.output_folder, filename)

                    print(f"⬇️ 正在下载视频...")
                    v_resp = requests.get(video_url, stream=True, timeout=120)
                    if v_resp.status_code == 200:
                        with open(filepath, "wb") as f:
                            for chunk in v_resp.iter_content(chunk_size=8192):
                                f.write(chunk)
                        print(f"✅ 视频已保存: {filename}")

                        return {
                            "success": True,
                            "url": f"/api/images/{filename}",
                            "filename": filename,
                            "filepath": filepath,
                            "remote_url": video_url,
                        }
                    else:
                        raise Exception(f"视频下载失败: {v_resp.status_code}")

                elif status == "failed" or status == "error":
                    error_msg = (
                        status_data.get("error")
                        or status_data.get("message")
                        or "未知错误"
                    )
                    raise Exception(f"视频生成失败: {error_msg}")

            raise Exception(f"视频生成超时 ({max_wait}秒)")

        except Exception as e:
            error_detail = traceback.format_exc()
            print(f"视频生成失败: {error_detail}")
            return {"success": False, "error": str(e), "detail": error_detail[:500]}

    def _open_image_data(self, image_data):
        return ImageOps.exif_transpose(Image.open(BytesIO(image_data)))

    def _fetch_image_bytes(self, url, base_url, timeout=180):
        """统一下载图片字节，支持三种形态：
        1) data:image/png;base64,xxx  —— 部分网关（如 doce.77code.fun）会把整张图塞进 url 字段
        2) /path/xxx 相对路径          —— 拼到 base_url 后再请求
        3) https://... 绝对 URL         —— 直接请求
        返回 (bytes_or_None, status_code, error_or_None)
        """
        import requests as _req_local
        try:
            if url.startswith("data:"):
                comma = url.find(",")
                if comma < 0:
                    return None, 0, "data URI 缺少逗号分隔符"
                header = url[5:comma]
                body = url[comma + 1:]
                if "base64" in header.lower():
                    return base64.b64decode(body), 200, None
                # 极少见的非 base64 data URI，按 utf-8 字节兜底
                return body.encode("utf-8", errors="ignore"), 200, None
            if url.startswith("/"):
                url = _req_local.compat.urljoin(f"{base_url}/", url)
            resp = _req_local.get(url, timeout=timeout)
            if resp.status_code == 200:
                return resp.content, 200, None
            return None, resp.status_code, f"HTTP {resp.status_code}"
        except Exception as exc:
            return None, 0, str(exc)

    def compress_image(self, image_data, quality=95):
        """压缩图片（v2优化：默认95%质量，平衡大小和清晰度）"""
        try:
            img = self._open_image_data(image_data)

            # 转换为RGB
            if img.mode == "RGBA":
                img = img.convert("RGB")

            # 压缩到指定质量
            output = BytesIO()
            img.save(output, format="JPEG", quality=quality, optimize=True)
            output.seek(0)

            return output.read()
        except Exception as e:
            print(f"压缩失败: {str(e)}")
            return image_data

    def create_thumbnail(self, image_data, max_size=(200, 200)):
        """创建缩略图"""
        try:
            img = self._open_image_data(image_data)

            # 转换为RGB
            if img.mode == "RGBA":
                img = img.convert("RGB")

            # 创建缩略图（保持宽高比）
            img.thumbnail(max_size, Image.Resampling.LANCZOS)

            # 转换为 JPEG
            output = BytesIO()
            img.save(output, format="JPEG", quality=85, optimize=True)
            output.seek(0)

            return output.read()
        except Exception as e:
            print(f"创建缩略图失败: {str(e)}")
            return None

    def _compress_reference_image(self, image_data, max_size=1024, quality=80):
        """压缩参考图用于 API 发送（减少 payload 大小）"""
        try:
            img = self._open_image_data(image_data)
            # 缩放到 max_size 以内
            if max(img.size) > max_size:
                img.thumbnail((max_size, max_size), Image.Resampling.LANCZOS)
            if img.mode == "RGBA":
                img = img.convert("RGB")
            output = BytesIO()
            img.save(output, format="JPEG", quality=quality, optimize=True)
            output.seek(0)
            return output.read()
        except Exception as e:
            print(f"[参考图压缩] 失败，使用原图: {e}")
            return image_data

    def _parse_size_dimensions(self, size_value):
        match = re.match(r"^(\d{2,5})x(\d{2,5})$", str(size_value or "").strip().lower())
        if not match:
            return None
        width = int(match.group(1))
        height = int(match.group(2))
        if width <= 0 or height <= 0:
            return None
        return width, height

    def _coerce_image_to_size(self, data_buffer, target_size=None):
        target = self._parse_size_dimensions(target_size)
        if not target:
            return data_buffer

        target_width, target_height = target
        try:
            img = self._open_image_data(data_buffer)
            if img.width == target_width and img.height == target_height:
                return data_buffer

            original_width, original_height = img.width, img.height
            if img.mode not in ("RGB", "RGBA"):
                img = img.convert("RGB")

            source_ratio = img.width / max(1, img.height)
            target_ratio = target_width / max(1, target_height)
            if source_ratio > target_ratio:
                crop_width = max(1, int(round(img.height * target_ratio)))
                left = max(0, (img.width - crop_width) // 2)
                img = img.crop((left, 0, left + crop_width, img.height))
            elif source_ratio < target_ratio:
                crop_height = max(1, int(round(img.width / target_ratio)))
                top = max(0, (img.height - crop_height) // 2)
                img = img.crop((0, top, img.width, top + crop_height))

            img = img.resize((target_width, target_height), Image.LANCZOS)
            output = BytesIO()
            img.save(output, format="PNG")
            print(f"[输出尺寸修正] {original_width}x{original_height} -> {target_width}x{target_height}")
            return output.getvalue()
        except Exception as e:
            print(f"[输出尺寸修正] 失败，保留原图: {e}")
            return data_buffer

    def _save_and_process_image(self, data_buffer, target_size=None):
        if os.environ.get("STUDIO_FORCE_OUTPUT_SIZE") == "1":
            data_buffer = self._coerce_image_to_size(data_buffer, target_size)
        """内部方法：保存、压缩、生成缩略图并返回结果结构"""
        # 保存到本地
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S_%f")
        filename = f"generated_{timestamp}.png"
        filepath = os.path.join(self.output_folder, filename)

        with open(filepath, "wb") as f:
            f.write(data_buffer)

        # 创建缩略图
        thumbnail_data = self.create_thumbnail(data_buffer)
        thumbnail_base64 = None
        if thumbnail_data:
            thumbnail_base64 = base64.b64encode(thumbnail_data).decode("utf-8")

        return {
            "filename": filename,
            "filepath": filepath,
            "url": f"/api/images/{filename}",
            "thumbnail": f"data:image/jpeg;base64,{thumbnail_base64}"
            if thumbnail_base64
            else None,
        }

    def _build_tile_axis(self, total_size, max_tile_edge, overlap, min_count=1):
        total_size = max(1, int(round(float(total_size or 0))))
        max_tile_edge = max(16, int(round(float(max_tile_edge or 0))))
        overlap = max(0, int(round(float(overlap or 0))))

        if total_size <= max_tile_edge and int(min_count or 1) <= 1:
            return {"count": 1, "tile_size": total_size, "step": total_size, "starts": [0], "overlap": 0}

        count = max(1, int(min_count or 1))
        while True:
            tile_size = int(math.ceil((total_size + (count - 1) * overlap) / count))
            if tile_size <= max_tile_edge:
                step = max(1, tile_size - overlap)
                starts = [min(idx * step, max(0, total_size - tile_size)) for idx in range(count)]
                return {
                    "count": count,
                    "tile_size": tile_size,
                    "step": step,
                    "starts": starts,
                    "overlap": overlap,
                }
            count += 1

    def _build_tile_plan(self, total_width, total_height, max_tile_edge=3840, overlap=256, max_tile_pixels=None):
        max_tile_pixels = max(1, int(round(float(max_tile_pixels or self._OPENAI_MAX_PIXELS))))
        min_cols = 1
        min_rows = 1
        while True:
            axis_x = self._build_tile_axis(total_width, max_tile_edge, overlap, min_count=min_cols)
            axis_y = self._build_tile_axis(total_height, max_tile_edge, overlap, min_count=min_rows)
            if axis_x["tile_size"] * axis_y["tile_size"] <= max_tile_pixels:
                break
            if axis_x["tile_size"] >= axis_y["tile_size"]:
                min_cols = axis_x["count"] + 1
            else:
                min_rows = axis_y["count"] + 1

        tiles = []
        index = 0
        for row, top in enumerate(axis_y["starts"], start=1):
            for col, left in enumerate(axis_x["starts"], start=1):
                index += 1
                tiles.append({
                    "index": index,
                    "row": row,
                    "col": col,
                    "left": int(left),
                    "top": int(top),
                    "width": int(axis_x["tile_size"]),
                    "height": int(axis_y["tile_size"]),
                    "right": int(min(total_width, left + axis_x["tile_size"])),
                    "bottom": int(min(total_height, top + axis_y["tile_size"])),
                })

        return {
            "width": int(total_width),
            "height": int(total_height),
            "cols": axis_x["count"],
            "rows": axis_y["count"],
            "tile_width": axis_x["tile_size"],
            "tile_height": axis_y["tile_size"],
            "overlap": max(0, int(overlap)),
            "tiles": tiles,
        }

    def _fit_source_canvas(self, source_image, target_width, target_height):
        img = ImageOps.exif_transpose(source_image)
        if img.mode not in ("RGB", "RGBA"):
            img = img.convert("RGB")

        target_ratio = float(target_width) / max(1.0, float(target_height))
        source_ratio = float(img.width) / max(1.0, float(img.height))
        if source_ratio > target_ratio:
            crop_width = max(1, int(round(img.height * target_ratio)))
            left = max(0, (img.width - crop_width) // 2)
            img = img.crop((left, 0, left + crop_width, img.height))
        elif source_ratio < target_ratio:
            crop_height = max(1, int(round(img.width / target_ratio)))
            top = max(0, (img.height - crop_height) // 2)
            img = img.crop((0, top, img.width, top + crop_height))
        return img

    def _image_to_data_uri(self, image_obj):
        buf = BytesIO()
        image_obj.save(buf, format="PNG")
        return f"data:image/png;base64,{base64.b64encode(buf.getvalue()).decode('utf-8')}"

    def _load_tile_reference_bytes(self, image_ref):
        src = str(image_ref or "").strip()
        if not src:
            return None
        if src.startswith(("http://", "https://")):
            resp = requests.get(src, timeout=60)
            if resp.status_code == 200 and resp.content:
                return resp.content
            return None
        try:
            return self._load_reference_image_bytes(src)
        except Exception:
            return None

    def _reference_to_data_uri(self, image_ref):
        raw = self._load_tile_reference_bytes(image_ref)
        if not raw:
            return None
        try:
            return self._image_to_data_uri(self._open_image_data(raw))
        except Exception:
            return None

    def _infer_tile_edge_from_resolution(self, resolution=None, size=None, fallback=3840):
        def _from_text(value):
            text = str(value or "").strip().lower()
            if not text:
                return None
            dims = self._parse_size_dimensions(text)
            if dims:
                return max(int(dims[0]), int(dims[1]))
            if text in {"1k", "720p"}:
                return 1024
            if text in {"2k", "1080p"}:
                return 2048
            if text in {"4k"}:
                return 3840
            return None

        for candidate in (size, resolution):
            inferred = _from_text(candidate)
            if inferred:
                return inferred
        return int(fallback or 3840)

    def _resolve_tile_target_dimensions(self, tile_workflow, source_image):
        tile_workflow = tile_workflow if isinstance(tile_workflow, dict) else {}
        target_unit = str(tile_workflow.get("targetUnit") or tile_workflow.get("unit") or "px").strip().lower()
        dpi = float(tile_workflow.get("dpi") or 300)
        width_input = float(tile_workflow.get("width") or tile_workflow.get("targetWidth") or 0)
        height_input = float(tile_workflow.get("height") or tile_workflow.get("targetHeight") or 0)

        if target_unit in {"cm", "centimeter", "centimeters"}:
            target_width = int(round(width_input * dpi / 2.54))
            target_height = int(round(height_input * dpi / 2.54))
        elif target_unit in {"mm", "millimeter", "millimeters"}:
            target_width = int(round(width_input * dpi / 25.4))
            target_height = int(round(height_input * dpi / 25.4))
        else:
            target_width = int(round(width_input))
            target_height = int(round(height_input))
            dpi = float(tile_workflow.get("dpi") or dpi)

        lock_aspect_ratio = bool(tile_workflow.get("lockAspectRatio") or tile_workflow.get("lockAspect"))
        fixed_axis = str(tile_workflow.get("fixedAxis") or tile_workflow.get("lockAxis") or "width").strip().lower()
        if fixed_axis not in {"width", "height"}:
            fixed_axis = "width"

        source_ratio = None
        if source_image and getattr(source_image, "width", 0) > 0 and getattr(source_image, "height", 0) > 0:
            source_ratio = float(source_image.width) / max(1.0, float(source_image.height))

        if source_ratio:
            if target_width <= 0 and target_height > 0:
                target_width = int(round(target_height * source_ratio))
            elif target_height <= 0 and target_width > 0:
                target_height = int(round(target_width / source_ratio))
            elif lock_aspect_ratio:
                if fixed_axis == "height" and target_height > 0:
                    target_width = int(round(target_height * source_ratio))
                elif target_width > 0:
                    target_height = int(round(target_width / source_ratio))

        return {
            "target_width": int(target_width),
            "target_height": int(target_height),
            "dpi": float(dpi),
            "lock_aspect_ratio": lock_aspect_ratio,
            "fixed_axis": fixed_axis,
            "source_ratio": source_ratio,
        }

    def _build_tile_stage_targets(self, source_width, source_height, target_width, target_height, max_stages=4):
        source_width = max(1, int(round(float(source_width or 0))))
        source_height = max(1, int(round(float(source_height or 0))))
        target_width = max(1, int(round(float(target_width or 0))))
        target_height = max(1, int(round(float(target_height or 0))))
        scale = max(target_width / max(1, source_width), target_height / max(1, source_height))
        if scale <= 2.0:
            return [(target_width, target_height)]

        stage_count = max(2, min(int(max_stages or 4), int(math.ceil(math.log(scale, 2)))))
        stage_targets = []
        for index in range(1, stage_count):
            stage_scale = scale ** (index / stage_count)
            stage_width = max(source_width + 1, int(round(source_width * stage_scale)))
            stage_height = max(source_height + 1, int(round(source_height * stage_scale)))
            stage_width = min(stage_width, target_width)
            stage_height = min(stage_height, target_height)
            if stage_targets and stage_targets[-1] == (stage_width, stage_height):
                continue
            stage_targets.append((stage_width, stage_height))
        if not stage_targets or stage_targets[-1] != (target_width, target_height):
            stage_targets.append((target_width, target_height))
        return stage_targets

    def _build_tile_prompt(self, base_prompt, tile, total_tiles, target_width, target_height, stage_index=1, stage_total=1, rows_total=None, cols_total=None):
        base_prompt = str(base_prompt or "").strip()
        stage_index = max(1, int(stage_index or 1))
        stage_total = max(1, int(stage_total or 1))
        rows_total = max(1, int(rows_total or tile.get("rows_total") or tile.get("row") or 1))
        cols_total = max(1, int(cols_total or tile.get("cols_total") or tile.get("col") or 1))
        if stage_total <= 1:
            stage_hint = "当前只做一轮重绘：直接按最终成品要求生成。"
        elif stage_index == 1:
            stage_hint = "当前是第一轮：优先建立大结构、色块、透视和材质基调，细节可以略保守。"
        elif stage_index >= stage_total:
            stage_hint = "当前是最后一轮：在上一轮基础上补足高频细节、边缘和纹理，保持一致性。"
        else:
            stage_hint = "当前是中间轮：延续上一轮结果，逐步增强细节和清晰度，不要改主体布局。"

        return (
            f"{base_prompt}\n\n"
            f"切块重绘说明：这是大幅面最终图的第 {tile['index']}/{total_tiles} 块。\n"
            f"本轮阶段：第 {stage_index}/{stage_total} 轮。\n"
            f"总画布尺寸：{target_width}x{target_height}px。\n"
            f"当前块位置：第 {tile['row']}/{rows_total} 行，第 {tile['col']}/{cols_total} 列。\n"
            f"当前块输出尺寸：{tile['width']}x{tile['height']}px。\n"
            f"{stage_hint}\n"
            f"放大目标：这是高保真超分重绘，不是普通复制或缩小预览；请把当前块补成更高清的打印级局部，补足线条、纹理、笔触、纸感和材质细节，尽量保持原图颜色和细节，不要改色，不要现代化处理，不要增删内容。\n"
            f"连续性要求：保持上下左右块边缘连续，延续原图或上一轮结果的结构、透视、光影、材质和主体轮廓；不要在边缘重新发明内容。"
        )

    def _cleanup_paths(self, paths):
        for file_path in paths or []:
            if not file_path:
                continue
            try:
                if os.path.exists(file_path):
                    os.remove(file_path)
            except Exception as exc:
                print(f"[Tile Workflow] intermediate cleanup failed: {exc}")

    def _generate_tile_workflow_v2(
        self,
        prompt,
        reference_images,
        tile_workflow,
        aspect_ratio="1:1",
        resolution="2K",
        size=None,
        quality=None,
        task_meta=None,
    ):
        tile_workflow = tile_workflow if isinstance(tile_workflow, dict) else {}
        reference_images = [ref for ref in (reference_images or []) if ref]
        if not reference_images:
            return {"success": False, "error": "切块重绘需要至少 1 张参考图"}

        source_reference_index = int(tile_workflow.get("sourceReferenceIndex") or 0)
        source_reference_index = max(0, min(source_reference_index, len(reference_images) - 1))

        source_bytes = self._load_tile_reference_bytes(reference_images[source_reference_index])
        if not source_bytes:
            return {"success": False, "error": "无法读取切块重绘的主参考图"}

        source_image = self._open_image_data(source_bytes)

        try:
            target_info = self._resolve_tile_target_dimensions(tile_workflow, source_image)
            target_width = int(target_info["target_width"])
            target_height = int(target_info["target_height"])
            dpi = float(target_info["dpi"])
        except (TypeError, ValueError):
            return {"success": False, "error": "切块重绘参数无效，无法解析目标尺寸"}

        if target_width <= 0 or target_height <= 0:
            return {"success": False, "error": "切块重绘目标尺寸必须大于 0"}

        max_tile_edge = int(round(float(tile_workflow.get("maxTileEdge") or tile_workflow.get("tileMaxEdge") or 0)))
        if max_tile_edge <= 0:
            max_tile_edge = self._infer_tile_edge_from_resolution(resolution=resolution, size=size, fallback=3840)
        max_tile_pixels = int(round(float(tile_workflow.get("maxTilePixels") or self._OPENAI_MAX_PIXELS)))
        overlap = int(round(float(tile_workflow.get("overlap") or tile_workflow.get("overlapPx") or 256)))
        auto_stitch = bool(tile_workflow.get("autoStitch", True))
        batch_id = str((task_meta or {}).get("batch_id") or tile_workflow.get("batchId") or uuid.uuid4().hex[:10])
        output_prefix = str(tile_workflow.get("outputPrefix") or f"tile_{batch_id}").strip().replace(" ", "_")

        fitted_source = self._fit_source_canvas(source_image, target_width, target_height)
        stage_targets = self._build_tile_stage_targets(
            fitted_source.width,
            fitted_source.height,
            target_width,
            target_height,
        )
        stage_total = len(stage_targets)
        print(
            f"[Tile Workflow] batch={batch_id} target={target_width}x{target_height} "
            f"stages={stage_total} auto_stitch={auto_stitch} max_edge={max_tile_edge}"
        )
        push_runtime_log(
            f"[切块重绘] batch={batch_id} 目标={target_width}x{target_height}px "
            f"阶段={stage_total} 自动拼接={'是' if auto_stitch else '否'} 单块上限={max_tile_edge}px",
            level="info",
        )

        final_tiles = []
        final_plan = None
        final_manifest = None
        final_stitched_image = None
        current_source_image = source_image
        stage_summaries = []
        total_tile_generations = 0
        first_tile_prompt = None

        for stage_index, (stage_target_width, stage_target_height) in enumerate(stage_targets, start=1):
            stage_is_final = stage_index == stage_total
            stage_source = self._fit_source_canvas(current_source_image, stage_target_width, stage_target_height)
            plan = self._build_tile_plan(
                stage_target_width,
                stage_target_height,
                max_tile_edge=max_tile_edge,
                overlap=overlap,
                max_tile_pixels=max_tile_pixels,
            )
            print(
                f"[Tile Workflow] stage={stage_index}/{stage_total} batch={batch_id} "
                f"target={stage_target_width}x{stage_target_height} tiles={len(plan['tiles'])}"
            )
            push_runtime_log(
                f"[切块重绘] batch={batch_id} 阶段 {stage_index}/{stage_total} "
                f"目标={stage_target_width}x{stage_target_height}px 切块={len(plan['tiles'])}",
                level="info",
            )
            total_tile_generations += len(plan["tiles"])

            stage_tiles = []
            stage_cleanup_paths = []

            for tile in plan["tiles"]:
                push_runtime_log(
                    f"[切块重绘] batch={batch_id} 阶段 {stage_index}/{stage_total} "
                    f"第 {tile['index']}/{len(plan['tiles'])} 块 行={tile['row']} 列={tile['col']} "
                    f"尺寸={tile['width']}x{tile['height']}px",
                    level="info",
                )
                source_left = max(0, min(int(round(tile["left"] / max(1, stage_target_width) * stage_source.width)), max(0, stage_source.width - 1)))
                source_top = max(0, min(int(round(tile["top"] / max(1, stage_target_height) * stage_source.height)), max(0, stage_source.height - 1)))
                source_right = max(
                    source_left + 1,
                    min(stage_source.width, int(round((tile["left"] + tile["width"]) / max(1, stage_target_width) * stage_source.width)))
                )
                source_bottom = max(
                    source_top + 1,
                    min(stage_source.height, int(round((tile["top"] + tile["height"]) / max(1, stage_target_height) * stage_source.height)))
                )
                tile_crop = stage_source.crop((source_left, source_top, source_right, source_bottom))
                if tile_crop.size != (tile["width"], tile["height"]):
                    tile_crop = tile_crop.resize((tile["width"], tile["height"]), Image.Resampling.LANCZOS)

                tile_reference = self._image_to_data_uri(tile_crop)
                stage_tile_meta = copy.deepcopy(task_meta or {})
                stage_tile_meta.update({
                    "batch_id": batch_id,
                    "tile_stage": stage_index,
                    "tile_stage_total": stage_total,
                    "tile_index": tile["index"],
                    "tile_row": tile["row"],
                    "tile_col": tile["col"],
                    "tile_total": len(plan["tiles"]),
                    "tile_output_width": tile["width"],
                    "tile_output_height": tile["height"],
                    "tile_target_width": stage_target_width,
                    "tile_target_height": stage_target_height,
                })

                stage_tile_prompt = self._build_tile_prompt(
                    prompt,
                    {**tile, "rows_total": plan["rows"], "cols_total": plan["cols"]},
                    len(plan["tiles"]),
                    stage_target_width,
                    stage_target_height,
                    stage_index=stage_index,
                    stage_total=stage_total,
                    rows_total=plan["rows"],
                    cols_total=plan["cols"],
                )
                if first_tile_prompt is None:
                    first_tile_prompt = stage_tile_prompt
                tile_refs = [tile_reference]
                tile_size = f"{tile['width']}x{tile['height']}"
                tile_result = self.generate(
                    prompt=stage_tile_prompt,
                    aspect_ratio=aspect_ratio,
                    resolution=resolution,
                    reference_images=tile_refs,
                    count=1,
                    size=tile_size,
                    quality=quality,
                    task_meta=stage_tile_meta,
                )
                if not tile_result.get("success"):
                    push_runtime_log(
                        f"[切块重绘] batch={batch_id} 阶段 {stage_index}/{stage_total} "
                        f"第 {tile['index']}/{len(plan['tiles'])} 块失败: {tile_result.get('error') or '未知错误'}",
                        level="error",
                    )
                    tile_result["batch_id"] = batch_id
                    tile_result["tile_plan"] = plan
                    tile_result["stage_index"] = stage_index
                    tile_result["stage_total"] = stage_total
                    return tile_result

                image_result = tile_result.get("images", [])[0]
                if not isinstance(image_result, dict):
                    return {"success": False, "error": f"切块重绘第 {tile['index']} 块输出格式异常"}

                filename = (
                    f"{output_prefix}_r{tile['row']:02d}c{tile['col']:02d}_{tile['index']:03d}.png"
                    if stage_is_final
                    else f"{output_prefix}_s{stage_index:02d}_r{tile['row']:02d}c{tile['col']:02d}_{tile['index']:03d}.png"
                )
                old_path = image_result.get("filepath")
                new_path = os.path.join(self.output_folder, filename)
                try:
                    if old_path and os.path.abspath(old_path) != os.path.abspath(new_path) and os.path.exists(old_path):
                        os.replace(old_path, new_path)
                    else:
                        new_path = old_path or new_path
                    image_result.update({
                        "filename": filename,
                        "filepath": new_path,
                        "url": f"/api/images/{filename}",
                        "tile_index": tile["index"],
                        "tile_row": tile["row"],
                        "tile_col": tile["col"],
                        "width": tile["width"],
                        "height": tile["height"],
                        "left": tile["left"],
                        "top": tile["top"],
                        "tile_width": tile["width"],
                        "tile_height": tile["height"],
                        "tile_left": tile["left"],
                        "tile_top": tile["top"],
                        "tile_stage": stage_index,
                        "tile_stage_total": stage_total,
                    })
                except Exception as rename_exc:
                    print(f"[Tile Workflow] 重命名失败: {rename_exc}")

                stage_tiles.append(image_result)
                if not stage_is_final and image_result.get("filepath"):
                    stage_cleanup_paths.append(image_result["filepath"])
                push_runtime_log(
                    f"[切块重绘] batch={batch_id} 阶段 {stage_index}/{stage_total} "
                    f"第 {tile['index']}/{len(plan['tiles'])} 块完成: {image_result.get('filename') or '未命名'}",
                    level="ok",
                )

            stitched_bytes = None
            if auto_stitch or not stage_is_final:
                try:
                    stitched_bytes = self._stitch_tile_outputs(stage_tiles, stage_target_width, stage_target_height, overlap)
                except Exception as stitch_exc:
                    if not stage_is_final:
                        return {"success": False, "error": f"切块重绘第 {stage_index} 轮拼接失败: {stitch_exc}"}
                    print(f"[Tile Workflow] 自动拼接失败: {stitch_exc}")

            stage_summaries.append({
                "stage_index": stage_index,
                "width": stage_target_width,
                "height": stage_target_height,
                "tiles": len(stage_tiles),
                "rows": plan["rows"],
                "cols": plan["cols"],
            })

            if stage_is_final:
                final_tiles = stage_tiles
                final_plan = plan
                manifest = {
                    "batch_id": batch_id,
                    "source_width": source_image.width,
                    "source_height": source_image.height,
                    "fitted_source_width": fitted_source.width,
                    "fitted_source_height": fitted_source.height,
                    "target_width": target_width,
                    "target_height": target_height,
                    "dpi": dpi,
                    "max_tile_edge": max_tile_edge,
                    "max_tile_pixels": max_tile_pixels,
                    "overlap": overlap,
                    "stage_count": stage_total,
                    "stage_targets": stage_summaries,
                    "source_to_target_scale": round(
                        max(
                            target_width / max(1, source_image.width),
                            target_height / max(1, source_image.height),
                        ),
                        4,
                    ),
                    "total_tile_generations": total_tile_generations,
                    "first_tile_prompt": first_tile_prompt,
                    "prompt_policy": [
                        "每块都会附加块序号、阶段、总画布、行列和块尺寸。",
                        "要求高保真超分重绘，保留颜色、构图、主体、透视和笔触。",
                        "要求上下左右边缘连续，不在边缘重新发明内容。",
                    ],
                    "rows": plan["rows"],
                    "cols": plan["cols"],
                    "tile_width": plan["tile_width"],
                    "tile_height": plan["tile_height"],
                    "tiles": [
                        {
                            "index": tile["index"],
                            "row": tile["row"],
                            "col": tile["col"],
                            "left": tile["left"],
                            "top": tile["top"],
                            "width": tile["width"],
                            "height": tile["height"],
                            "filename": stage_tiles[tile["index"] - 1].get("filename"),
                            "stage_index": stage_index,
                        }
                        for tile in plan["tiles"]
                    ],
                }

                manifest_filename = f"{output_prefix}_manifest.json"
                manifest_path = os.path.join(self.output_folder, manifest_filename)
                try:
                    with open(manifest_path, "w", encoding="utf-8") as f:
                        json.dump(manifest, f, ensure_ascii=False, indent=2)
                except Exception as manifest_exc:
                    print(f"[Tile Workflow] manifest 写入失败: {manifest_exc}")
                    manifest_path = None

                if auto_stitch and stitched_bytes:
                    try:
                        stitched_filename = f"{output_prefix}_stitched.png"
                        final_stitched_image = self._save_named_bytes(stitched_bytes, stitched_filename)
                    except Exception as stitch_exc:
                        print(f"[Tile Workflow] 自动拼接失败: {stitch_exc}")

                final_manifest = manifest
                result = {
                    "success": True,
                    "images": final_tiles,
                    "count": len(final_tiles),
                    "batch_id": batch_id,
                    "tile_plan": final_plan,
                    "tile_manifest": final_manifest,
                    "manifest_file": manifest_path,
                    "stage_count": stage_total,
                    "stage_targets": stage_summaries,
                    "total_tile_generations": total_tile_generations,
                    "prompt_preview": first_tile_prompt,
                }
                if final_stitched_image:
                    result["stitched_image"] = final_stitched_image
                push_runtime_log(
                    f"[切块重绘] batch={batch_id} 完成: 最终={target_width}x{target_height}px "
                    f"切块={plan['rows']}x{plan['cols']} 总块数={len(final_tiles)} "
                    f"拼接={'有' if final_stitched_image else '无'}",
                    level="ok",
                )
                return result

            self._cleanup_paths(stage_cleanup_paths)
            if stitched_bytes:
                current_source_image = self._open_image_data(stitched_bytes)

        return {"success": False, "error": "切块重绘未能生成任何结果"}

    def _make_edge_ramp(self, length, reverse=False, horizontal=True):
        length = max(1, int(length))
        values = [int(round(i * 255 / max(1, length - 1))) for i in range(length)]
        if reverse:
            values.reverse()
        strip = Image.new("L", (length, 1)) if horizontal else Image.new("L", (1, length))
        strip.putdata(values)
        return strip

    def _make_tile_blend_mask(self, width, height, overlap_left=0, overlap_right=0, overlap_top=0, overlap_bottom=0):
        width = max(1, int(width))
        height = max(1, int(height))
        overlap_left = max(0, min(int(overlap_left or 0), width))
        overlap_right = max(0, min(int(overlap_right or 0), width))
        overlap_top = max(0, min(int(overlap_top or 0), height))
        overlap_bottom = max(0, min(int(overlap_bottom or 0), height))

        hmask = Image.new("L", (width, 1), 255)
        if overlap_left > 0:
            hmask.paste(self._make_edge_ramp(overlap_left, reverse=False, horizontal=True), (0, 0))
        if overlap_right > 0:
            hmask.paste(self._make_edge_ramp(overlap_right, reverse=True, horizontal=True), (width - overlap_right, 0))
        hmask = hmask.resize((width, height), Image.Resampling.NEAREST)

        vmask = Image.new("L", (1, height), 255)
        if overlap_top > 0:
            vmask.paste(self._make_edge_ramp(overlap_top, reverse=False, horizontal=False), (0, 0))
        if overlap_bottom > 0:
            vmask.paste(self._make_edge_ramp(overlap_bottom, reverse=True, horizontal=False), (0, height - overlap_bottom))
        vmask = vmask.resize((width, height), Image.Resampling.NEAREST)

        return ImageChops.multiply(hmask, vmask)

    def _stitch_tile_outputs(self, tiles, target_width, target_height, overlap):
        canvas = Image.new("RGBA", (int(target_width), int(target_height)), (0, 0, 0, 0))
        for tile in tiles:
            filepath = tile.get("filepath")
            if not filepath or not os.path.exists(filepath):
                continue
            with Image.open(filepath) as opened:
                img = ImageOps.exif_transpose(opened)
                if img.mode != "RGBA":
                    img = img.convert("RGBA")
                expected = (int(tile.get("width") or tile.get("tile_width") or img.width), int(tile.get("height") or tile.get("tile_height") or img.height))
                if img.size != expected:
                    img = img.resize(expected, Image.Resampling.LANCZOS)

                left = int(tile.get("left") or tile.get("tile_left") or 0)
                top = int(tile.get("top") or tile.get("tile_top") or 0)
                tile_left = overlap if left > 0 else 0
                tile_right = overlap if left + expected[0] < int(target_width) else 0
                tile_top = overlap if top > 0 else 0
                tile_bottom = overlap if top + expected[1] < int(target_height) else 0
                mask = self._make_tile_blend_mask(expected[0], expected[1], tile_left, tile_right, tile_top, tile_bottom)
                canvas.paste(img, (left, top), mask)

        output = BytesIO()
        canvas.save(output, format="PNG")
        return output.getvalue()

    def _save_named_bytes(self, data_buffer, filename):
        os.makedirs(self.output_folder, exist_ok=True)
        filepath = os.path.join(self.output_folder, filename)
        with open(filepath, "wb") as f:
            f.write(data_buffer)
        return {
            "filename": filename,
            "filepath": filepath,
            "url": f"/api/images/{filename}",
        }

    def generate_tile_workflow(
        self,
        prompt,
        reference_images,
        tile_workflow,
        aspect_ratio="1:1",
        resolution="2K",
        size=None,
        quality=None,
        task_meta=None,
    ):
        return self._generate_tile_workflow_v2(
            prompt=prompt,
            reference_images=reference_images,
            tile_workflow=tile_workflow,
            aspect_ratio=aspect_ratio,
            resolution=resolution,
            size=size,
            quality=quality,
            task_meta=task_meta,
        )
        tile_workflow = tile_workflow if isinstance(tile_workflow, dict) else {}
        reference_images = [ref for ref in (reference_images or []) if ref]
        if not reference_images:
            return {"success": False, "error": "切块重绘需要至少 1 张参考图"}

        try:
            target_unit = str(tile_workflow.get("targetUnit") or tile_workflow.get("unit") or "px").strip().lower()
            dpi = float(tile_workflow.get("dpi") or 300)
            if target_unit in {"cm", "centimeter", "centimeters"}:
                target_width = int(round(float(tile_workflow.get("width") or tile_workflow.get("targetWidth") or 0) * dpi / 2.54))
                target_height = int(round(float(tile_workflow.get("height") or tile_workflow.get("targetHeight") or 0) * dpi / 2.54))
            elif target_unit in {"mm", "millimeter", "millimeters"}:
                target_width = int(round(float(tile_workflow.get("width") or tile_workflow.get("targetWidth") or 0) * dpi / 25.4))
                target_height = int(round(float(tile_workflow.get("height") or tile_workflow.get("targetHeight") or 0) * dpi / 25.4))
            else:
                target_width = int(round(float(tile_workflow.get("width") or tile_workflow.get("targetWidth") or 0)))
                target_height = int(round(float(tile_workflow.get("height") or tile_workflow.get("targetHeight") or 0)))
                dpi = float(tile_workflow.get("dpi") or dpi)
        except (TypeError, ValueError):
            return {"success": False, "error": "切块重绘参数无效，无法解析目标尺寸"}

        if target_width <= 0 or target_height <= 0:
            return {"success": False, "error": "切块重绘目标尺寸必须大于 0"}

        max_tile_edge = int(round(float(tile_workflow.get("maxTileEdge") or tile_workflow.get("tileMaxEdge") or 3840)))
        max_tile_pixels = int(round(float(tile_workflow.get("maxTilePixels") or self._OPENAI_MAX_PIXELS)))
        overlap = int(round(float(tile_workflow.get("overlap") or tile_workflow.get("overlapPx") or 256)))
        auto_stitch = bool(tile_workflow.get("autoStitch"))
        batch_id = str((task_meta or {}).get("batch_id") or tile_workflow.get("batchId") or uuid.uuid4().hex[:10])
        output_prefix = str(tile_workflow.get("outputPrefix") or f"tile_{batch_id}").strip().replace(" ", "_")
        source_reference_index = int(tile_workflow.get("sourceReferenceIndex") or 0)
        source_reference_index = max(0, min(source_reference_index, len(reference_images) - 1))

        source_bytes = self._load_tile_reference_bytes(reference_images[source_reference_index])
        if not source_bytes:
            return {"success": False, "error": "无法读取切块重绘的主参考图"}

        source_image = self._open_image_data(source_bytes)
        fitted_source = self._fit_source_canvas(source_image, target_width, target_height)
        plan = self._build_tile_plan(
            target_width,
            target_height,
            max_tile_edge=max_tile_edge,
            overlap=overlap,
            max_tile_pixels=max_tile_pixels,
        )
        uploadable_references = [self._reference_to_data_uri(ref) or ref for ref in reference_images]

        print(f"[Tile Workflow] batch={batch_id} target={target_width}x{target_height} tiles={len(plan['tiles'])} auto_stitch={auto_stitch}")

        tiles = []
        for tile in plan["tiles"]:
            source_left = max(0, min(int(round(tile["left"] / max(1, target_width) * fitted_source.width)), max(0, fitted_source.width - 1)))
            source_top = max(0, min(int(round(tile["top"] / max(1, target_height) * fitted_source.height)), max(0, fitted_source.height - 1)))
            source_right = max(source_left + 1, min(fitted_source.width, int(round((tile["left"] + tile["width"]) / max(1, target_width) * fitted_source.width))))
            source_bottom = max(source_top + 1, min(fitted_source.height, int(round((tile["top"] + tile["height"]) / max(1, target_height) * fitted_source.height))))
            tile_crop = fitted_source.crop((source_left, source_top, source_right, source_bottom))
            if tile_crop.size != (tile["width"], tile["height"]):
                tile_crop = tile_crop.resize((tile["width"], tile["height"]), Image.Resampling.LANCZOS)
            tile_reference = self._image_to_data_uri(tile_crop)
            tile_prompt = (
                f"{prompt}\n\n"
                f"切块重绘说明：这是大幅面最终图的第 {tile['index']}/{len(plan['tiles'])} 块。\n"
                f"总画布尺寸：{target_width}x{target_height}px。\n"
                f"当前块位置：第 {tile['row']}/{plan['rows']} 行，第 {tile['col']}/{plan['cols']} 列。\n"
                f"当前块输出尺寸：{tile['width']}x{tile['height']}px。\n"
                f"要求：保持与上下左右块边缘连续，延续原图的结构、透视、光影、材质和主体轮廓，不要在边缘重新发明内容。"
            )

            tile_task_meta = copy.deepcopy(task_meta or {})
            tile_task_meta.update({
                "batch_id": batch_id,
                "tile_index": tile["index"],
                "tile_row": tile["row"],
                "tile_col": tile["col"],
                "tile_total": len(plan["tiles"]),
                "tile_output_width": tile["width"],
                "tile_output_height": tile["height"],
            })

            tile_refs = [tile_reference, *uploadable_references]
            tile_size = f"{tile['width']}x{tile['height']}"
            tile_result = self.generate(
                prompt=tile_prompt,
                aspect_ratio=aspect_ratio,
                resolution=resolution,
                reference_images=tile_refs,
                count=1,
                size=tile_size,
                quality=quality,
                task_meta=tile_task_meta,
            )
            if not tile_result.get("success"):
                tile_result["batch_id"] = batch_id
                tile_result["tile_plan"] = plan
                return tile_result

            image_result = tile_result.get("images", [])[0]
            if not isinstance(image_result, dict):
                return {"success": False, "error": f"切块重绘第 {tile['index']} 块输出格式异常"}

            filename = f"{output_prefix}_r{tile['row']:02d}c{tile['col']:02d}_{tile['index']:03d}.png"
            old_path = image_result.get("filepath")
            new_path = os.path.join(self.output_folder, filename)
            try:
                if old_path and os.path.abspath(old_path) != os.path.abspath(new_path) and os.path.exists(old_path):
                    os.replace(old_path, new_path)
                else:
                    new_path = old_path or new_path
                image_result.update({
                    "filename": filename,
                    "filepath": new_path,
                    "url": f"/api/images/{filename}",
                    "tile_index": tile["index"],
                    "tile_row": tile["row"],
                    "tile_col": tile["col"],
                    "width": tile["width"],
                    "height": tile["height"],
                    "left": tile["left"],
                    "top": tile["top"],
                    "tile_width": tile["width"],
                    "tile_height": tile["height"],
                    "tile_left": tile["left"],
                    "tile_top": tile["top"],
                })
            except Exception as rename_exc:
                print(f"[Tile Workflow] 重命名失败: {rename_exc}")

            tiles.append(image_result)

        manifest = {
            "batch_id": batch_id,
            "source_width": source_image.width,
            "source_height": source_image.height,
            "fitted_source_width": fitted_source.width,
            "fitted_source_height": fitted_source.height,
            "target_width": target_width,
            "target_height": target_height,
            "dpi": dpi,
            "max_tile_edge": max_tile_edge,
            "max_tile_pixels": max_tile_pixels,
            "overlap": overlap,
            "rows": plan["rows"],
            "cols": plan["cols"],
            "tile_width": plan["tile_width"],
            "tile_height": plan["tile_height"],
            "tiles": [
                {
                    "index": tile["index"],
                    "row": tile["row"],
                    "col": tile["col"],
                    "left": tile["left"],
                    "top": tile["top"],
                    "width": tile["width"],
                    "height": tile["height"],
                    "filename": tiles[tile["index"] - 1].get("filename"),
                }
                for tile in plan["tiles"]
            ],
        }

        manifest_filename = f"{output_prefix}_manifest.json"
        manifest_path = os.path.join(self.output_folder, manifest_filename)
        try:
            with open(manifest_path, "w", encoding="utf-8") as f:
                json.dump(manifest, f, ensure_ascii=False, indent=2)
        except Exception as manifest_exc:
            print(f"[Tile Workflow] manifest 写入失败: {manifest_exc}")
            manifest_path = None

        stitched_image = None
        if auto_stitch:
            try:
                stitched_bytes = self._stitch_tile_outputs(tiles, target_width, target_height, overlap)
                stitched_filename = f"{output_prefix}_stitched.png"
                stitched_image = self._save_named_bytes(stitched_bytes, stitched_filename)
            except Exception as stitch_exc:
                print(f"[Tile Workflow] 自动拼接失败: {stitch_exc}")

        result = {
            "success": True,
            "images": tiles,
            "count": len(tiles),
            "batch_id": batch_id,
            "tile_plan": plan,
            "tile_manifest": manifest,
            "manifest_file": manifest_path,
        }
        if stitched_image:
            result["stitched_image"] = stitched_image
        return result

    def generate(
        self,
        prompt,
        aspect_ratio="1:1",
        resolution="2K",
        reference_images=None,
        count=1,
        size=None,
        quality=None,
        task_meta=None,
    ):
        """生成图片"""
        try:
            if self.use_openai_images:
                # OpenAI Images API (gpt-image-2, dall-e-3 等)
                print(f"[OpenAI Images] 模型: {self.model}, 比例: {aspect_ratio}, 分辨率: {resolution}, size: {size}, quality: {quality}")
                return self._generate_openai_images(
                    prompt, aspect_ratio, resolution, reference_images, count, size=size, quality=quality, task_meta=task_meta
                )
            elif self.use_gemini_native_http:
                # 第三方 Gemini 原生协议 (SuXi.ai 等)
                print(f"[Gemini Native HTTP] 模型: {self.model}, 比例: {aspect_ratio}, 分辨率: {resolution}")
                return self._generate_gemini_native_http(
                    prompt, aspect_ratio, resolution, reference_images
                )
            elif self.use_chat_image:
                # Chat-based 图像生成 (gpt-5.4-mini 等多模态模型)
                print(f"[Chat Image] 模型: {self.model}, 比例: {aspect_ratio}, 分辨率: {resolution}, size: {size}")
                return self._generate_chat_completions_image(
                    prompt, aspect_ratio, resolution, reference_images, size=size
                )
            elif self.use_openai:
                # OpenAI 模式：优先使用 Images API（不支持参考图）
                if reference_images:
                    print("[OpenAI模式] 检测到参考图，使用 Chat API（图生图）")
                    return self._generate_openai(
                        prompt, aspect_ratio, resolution, reference_images
                    )
                else:
                    print(f"[OpenAI模式] 使用 Images API 生成 {count} 张图片")
                    return self._generate_openai_images_api(
                        prompt, aspect_ratio, resolution, count
                    )
            else:
                return self._generate_google(
                    prompt, aspect_ratio, resolution, reference_images
                )
        except Exception as e:
            error_detail = traceback.format_exc()
            print(f"生成失败: {error_detail}")
            return {"success": False, "error": str(e), "detail": error_detail[:500]}

    # ========== OpenAI Images API (gpt-image-2 等) ==========

    # 宽高比 → 像素尺寸映射
    _OPENAI_SIZE_MAP = {
        "1:1":  "1024x1024",
        "3:2":  "1536x1024",
        "2:3":  "1024x1536",
        "16:9": "1536x1024",
        "9:16": "1024x1536",
        "4:3":  "1536x1024",
        "3:4":  "1024x1536",
        "1:4":  "1024x1536",   # 最接近的竖版
        "1:8":  "1024x1536",   # 最接近的竖版
    }
    _OPENAI_RESOLUTION_SIZE_MAP = {
        "1k": {"1:1": "1024x1024", "3:2": "1536x1024", "2:3": "1024x1536", "16:9": "1536x864", "9:16": "864x1536", "4:3": "1536x1152", "3:4": "1152x1536"},
        "2k": {"1:1": "2048x2048", "3:2": "2048x1360", "2:3": "1360x2048", "16:9": "2048x1152", "9:16": "1152x2048", "4:3": "2048x1536", "3:4": "1536x2048"},
        "4k": {"1:1": "2880x2880", "3:2": "3520x2336", "2:3": "2336x3520", "16:9": "3840x2160", "9:16": "2160x3840", "4:3": "3328x2480", "3:4": "2480x3328"},
    }
    # 分辨率 → quality 映射
    _OPENAI_QUALITY_MAP = {
        "1K": "low",
        "2K": "medium",
        "4K": "high",
        "low": "low",
        "medium": "medium",
        "high": "high",
    }
    _OPENAI_MAX_EDGE = 3840
    _OPENAI_MAX_PIXELS = 3840 * 2160
    _OPENAI_MIN_PIXELS = 655360

    @staticmethod
    def _is_openai_images_model_name(model_name):
        normalized_model = str(model_name or "").strip().lower()
        return bool(normalized_model) and (
            normalized_model.startswith("gpt-image")
            or normalized_model.startswith("dall-e")
            or normalized_model.startswith("codex-image")
            or normalized_model.startswith("codex-gpt-image")
        )

    def _round_openai_dimension(self, value):
        return max(16, int(round(float(value or 0) / 16.0)) * 16)

    def _floor_openai_dimension(self, value):
        return max(16, int(float(value or 0) // 16) * 16)

    def _ceil_openai_dimension(self, value):
        import math
        return max(16, int(math.ceil(float(value or 0) / 16.0)) * 16)

    def _clamp_openai_dimensions(self, width, height):
        next_width = self._round_openai_dimension(width)
        next_height = self._round_openai_dimension(height)
        scale = 1.0

        if max(next_width, next_height) > self._OPENAI_MAX_EDGE:
            scale = min(scale, self._OPENAI_MAX_EDGE / max(next_width, next_height))
        if next_width * next_height > self._OPENAI_MAX_PIXELS:
            scale = min(scale, (self._OPENAI_MAX_PIXELS / max(1, next_width * next_height)) ** 0.5)
        if scale < 1:
            next_width = self._floor_openai_dimension(next_width * scale)
            next_height = self._floor_openai_dimension(next_height * scale)

        if next_width * next_height < self._OPENAI_MIN_PIXELS:
            grow = (self._OPENAI_MIN_PIXELS / max(1, next_width * next_height)) ** 0.5
            next_width = self._ceil_openai_dimension(next_width * grow)
            next_height = self._ceil_openai_dimension(next_height * grow)

        while next_width * next_height < self._OPENAI_MIN_PIXELS:
            grow = (self._OPENAI_MIN_PIXELS / max(1, next_width * next_height)) ** 0.5
            next_width = self._ceil_openai_dimension(next_width * grow)
            next_height = self._ceil_openai_dimension(next_height * grow)

        while max(next_width, next_height) > self._OPENAI_MAX_EDGE or next_width * next_height > self._OPENAI_MAX_PIXELS:
            shrink = min(
                self._OPENAI_MAX_EDGE / max(next_width, next_height),
                (self._OPENAI_MAX_PIXELS / max(1, next_width * next_height)) ** 0.5,
                0.999,
            )
            next_width = self._floor_openai_dimension(next_width * shrink)
            next_height = self._floor_openai_dimension(next_height * shrink)

        return next_width, next_height

    def _load_reference_image_bytes(self, image_data):
        raw_bytes = None
        if image_data.startswith("/api/images/"):
            filename = image_data.replace("/api/images/", "")
            filepath = os.path.join(self.output_folder, filename)
            if os.path.exists(filepath):
                with open(filepath, "rb") as f:
                    raw_bytes = f.read()
        elif image_data.startswith("data:image"):
            b64_part = image_data.split(",", 1)[1] if "," in image_data else image_data
            raw_bytes = base64.b64decode(b64_part)
        else:
            raw_bytes = base64.b64decode(image_data)
        return raw_bytes

    def _normalize_openai_size(self, size_value, reference_images=None, aspect_ratio=None):
        text = str(size_value or "").strip().lower()
        if not text:
            return None

        resolution_map = self._OPENAI_RESOLUTION_SIZE_MAP.get(text)
        if resolution_map:
            ratio_key = str(aspect_ratio or "").strip()
            return resolution_map.get(ratio_key) or resolution_map.get("1:1")

        direct_match = re.match(r"^(\d{2,5})x(\d{2,5})$", text)
        if direct_match:
            width = int(direct_match.group(1))
            height = int(direct_match.group(2))
            width, height = self._clamp_openai_dimensions(width, height)
            return f"{width}x{height}"

        if text == "original:max" and reference_images:
            raw_bytes = self._load_reference_image_bytes(reference_images[0])
            if raw_bytes:
                img = self._open_image_data(raw_bytes)
                src_width, src_height = img.size
                if src_width > 0 and src_height > 0:
                    ratio = src_width / src_height
                    # 像素上限贴顶：w*h = MAX_PIXELS, w = h * ratio
                    max_height = (self._OPENAI_MAX_PIXELS / ratio) ** 0.5
                    max_width = max_height * ratio
                    # 再卡长边上限
                    longest = max(max_width, max_height)
                    if longest > self._OPENAI_MAX_EDGE:
                        shrink = self._OPENAI_MAX_EDGE / longest
                        max_width *= shrink
                        max_height *= shrink
                    width, height = self._clamp_openai_dimensions(max_width, max_height)
                    return f"{width}x{height}"

        original_match = re.match(r"^original:(\d{2,5})$", text)
        if original_match and reference_images:
            raw_bytes = self._load_reference_image_bytes(reference_images[0])
            if raw_bytes:
                img = self._open_image_data(raw_bytes)
                src_width, src_height = img.size
                if src_width > 0 and src_height > 0:
                    long_edge = max(16, int(original_match.group(1)))
                    scale = long_edge / max(src_width, src_height)
                    width, height = self._clamp_openai_dimensions(src_width * scale, src_height * scale)
                    return f"{width}x{height}"

        # 倍数语义：original:scale<N>（N 为浮点，1 / 1.25 / 1.5 / 1.75 / 2）。
        # 按"每张参考图各自的实际尺寸 × N"计算目标像素，再交给 _clamp_openai_dimensions
        # 卡到 OpenAI 的合规区间（长边 ≤3840，总像素 ≤8.29M，≥655K）。
        scale_match = re.match(r"^original:scale([\d.]+)$", text)
        if scale_match and reference_images:
            raw_bytes = self._load_reference_image_bytes(reference_images[0])
            if raw_bytes:
                img = self._open_image_data(raw_bytes)
                src_width, src_height = img.size
                if src_width > 0 and src_height > 0:
                    try:
                        scale = float(scale_match.group(1))
                    except ValueError:
                        scale = 1.0
                    scale = max(0.1, min(8.0, scale))
                    width, height = self._clamp_openai_dimensions(src_width * scale, src_height * scale)
                    return f"{width}x{height}"

        return None

    def _downshift_openai_size(self, size_value):
        dims = self._parse_size_dimensions(size_value)
        if not dims:
            return None
        width, height = dims
        long_edge = max(width, height)
        if long_edge <= 1024:
            return None
        ratio = width / height
        target_long_edge = 2048 if long_edge > 2048 else 1024
        if width >= height:
            next_width = target_long_edge
            next_height = target_long_edge / ratio
        else:
            next_height = target_long_edge
            next_width = target_long_edge * ratio
        next_width, next_height = self._clamp_openai_dimensions(next_width, next_height)
        fallback = f"{next_width}x{next_height}"
        if fallback == str(size_value or "").strip().lower():
            return None
        return fallback

    def _resolve_openai_quality(self, resolution, quality=None, size=None):
        normalized_quality = str(quality or "").strip().lower()
        if normalized_quality in {"low", "medium", "high"}:
            return normalized_quality

        # 从 size / resolution 的长边推导 quality：
        # 长边 ≥ 2048 → high；≥ 1280 → medium；否则 low
        def _quality_from_long_edge(long_edge):
            if long_edge >= 2048:
                return "high"
            if long_edge >= 1280:
                return "medium"
            return "low"

        for candidate in (size, resolution):
            if not candidate:
                continue
            text = str(candidate).strip().lower()
            m = re.match(r"^(\d+)x(\d+)$", text)
            if m:
                return _quality_from_long_edge(max(int(m.group(1)), int(m.group(2))))
            if text == "original:max":
                return "high"
            m2 = re.match(r"^original:(\d+)$", text)
            if m2:
                return _quality_from_long_edge(int(m2.group(1)))
            # original:scale<N> 推 quality：N≥1 默认 high；0.5≤N<1 medium；其余 low。
            # 这里用倍数粗估，反正最终 size 已被 _clamp_openai_dimensions 卡过，不会越界。
            m3 = re.match(r"^original:scale([\d.]+)$", text)
            if m3:
                try:
                    scale = float(m3.group(1))
                except ValueError:
                    scale = 1.0
                if scale >= 1.0:
                    return "high"
                if scale >= 0.5:
                    return "medium"
                return "low"

        mapped = self._OPENAI_QUALITY_MAP.get(str(resolution or "").strip())
        return mapped if mapped in {"low", "medium", "high"} else None

    # 已知"健康伙伴对"——单账号池的两个 image provider 互为 fallback。
    # 一边偶发账号抖动时，自动切到另一边重试。
    _IMAGE_FALLBACK_PAIRS = {
        "cpa_japan": "chat2api_japan_plus",
        "chat2api_japan_plus": "cpa_japan",
    }

    def _find_image_fallback_provider(self, api_url=None):
        """根据当前 self.api_url 反查 system_config，返回一个可作为 fallback 的 image provider。

        优先选已声明伙伴对；否则随便挑一个 type=image 且 base_url 与 self 不同的有效 provider。
        没有合适候选返回 None。
        """
        try:
            cfg = load_system_config()
        except Exception as ex:
            print(f"[OpenAI Images] fallback 查找失败（读 config 异常）: {ex}")
            return None

        providers = cfg.get("providers", []) or []
        cur_url = (api_url or getattr(self, "api_url", "") or "").rstrip("/")
        # 反查当前 provider id（按 base_url 匹配）
        current = next(
            (p for p in providers
             if p.get("type") == "image"
             and (p.get("api_url") or "").rstrip("/") == cur_url),
            None,
        )
        current_model = (current or {}).get("model") or getattr(self, "model", "")
        if not self._is_openai_images_model_name(current_model):
            return None

        candidates = [
            p for p in providers
            if p.get("type") == "image"
            and (p.get("api_url") or "").rstrip("/") != cur_url
            and p.get("api_key")
            and self._is_openai_images_model_name(p.get("model"))
        ]
        if not candidates:
            return None

        preferred_ids = [
            "packyapi_slb",
            "packyapi",
            "doce_77code",
            "cpa_japan",
            "chat2api_japan_plus",
            "cpa_us",
            "chat2api_us_plus",
            "cpa_japan_chat",
            "cpa_us_chat",
            "doce_chat_mini",
            "default_image",
        ]

        if current:
            preferred_id = self._IMAGE_FALLBACK_PAIRS.get(current.get("id"))
            if preferred_id:
                preferred = next((p for p in candidates if p.get("id") == preferred_id), None)
                if preferred:
                    return preferred

        for preferred_id in preferred_ids:
            preferred = next((p for p in candidates if p.get("id") == preferred_id), None)
            if preferred:
                return preferred

        return candidates[0]

    def _generate_openai_images(self, prompt, aspect_ratio, resolution, reference_images, count=1, size=None, quality=None, task_meta=None):
        """OpenAI Images API (gpt-image-2, dall-e-3 等)"""
        import requests as req_lib
        import time as _time

        base_url = self.api_url.rstrip("/")
        resolved_size = (
            self._normalize_openai_size(size, reference_images, aspect_ratio)
            or self._normalize_openai_size(resolution, reference_images, aspect_ratio)
            or self._OPENAI_SIZE_MAP.get(aspect_ratio, "1024x1024")
        )
        resolved_quality = self._resolve_openai_quality(resolution, quality, size=size)

        print(f"[OpenAI Images] URL: {base_url}/v1/images/generations")
        print(f"[OpenAI Images] size={resolved_size}, quality={resolved_quality or 'default'} (from size={size}, resolution={resolution}, quality={quality}), n={count}")

        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }

        # 如果有参考图，尝试用 /v1/images/edits（图生图）
        if reference_images:
            return self._generate_openai_images_edit(
                prompt, reference_images, resolved_size, resolved_quality, headers, base_url, task_meta=task_meta
            )

        # 文生图：/v1/images/generations
        # GPT image 模型始终返回 b64，不需要 response_format
        payload = {
            "model": self.model,
            "prompt": prompt,
            "n": min(count, 10),  # GPT image 模型支持 1-10
            "size": resolved_size,
        }
        if resolved_quality:
            payload["quality"] = resolved_quality
        # 非官方 OpenAI 网关（chat2api Plus / cpa_japan / codex.kakahome.top 等）全部走 URL 返回模式，
        # 避免大图 b64 响应体超时；api.openai.com 官方 API 对未知参数严格会 400，跳过。
        if "api.openai.com" not in base_url:
            payload["response_format"] = "url"

        # —— 重试链设计 ——
        # attempt 1: 当前 provider, 原 size/quality, 立即发
        # attempt 2: fallback provider（若存在）, 原 size/quality, 退避 5s 后发 ← 解决"账号偶发抖动"
        # attempt 3: fallback provider, 降档 size/quality, 退避 30s 后发 ← 兜底
        # 没有 fallback provider 时，退化成 当前 provider 单次 + 降档一次（兼容老行为）
        fallback_provider = self._find_image_fallback_provider()
        fallback_url = (fallback_provider.get("api_url") or "").rstrip("/") if fallback_provider else None
        fallback_key = fallback_provider.get("api_key") if fallback_provider else None
        fallback_model = fallback_provider.get("model") if fallback_provider else None
        fallback_id = fallback_provider.get("id") if fallback_provider else None

        retry_attempts = [
            {"size": resolved_size, "quality": resolved_quality, "use_fallback": False, "delay": 0},
        ]
        if fallback_provider:
            # Plan A：保持原尺寸，切到伙伴 provider，退避 5s
            retry_attempts.append({
                "size": resolved_size, "quality": resolved_quality,
                "use_fallback": True, "delay": 5,
            })

        downshift_size = self._downshift_openai_size(resolved_size)
        if downshift_size:
            downshift_quality = "medium" if resolved_quality == "high" else resolved_quality
            # Plan B：降档兜底；如果有伙伴就在伙伴上降档，否则在当前 provider 降档（保留老逻辑）
            retry_attempts.append({
                "size": downshift_size, "quality": downshift_quality,
                "use_fallback": bool(fallback_provider),
                "delay": 30 if fallback_provider else 0,
            })

        if fallback_provider:
            print(f"[OpenAI Images] 已加载 fallback provider: id={fallback_id} url={fallback_url} model={fallback_model}")
        else:
            print(f"[OpenAI Images] 未找到 fallback provider，仅本地降档兜底")

        start = _time.time()
        try:
            resp = None
            elapsed = 0
            last_error = None
            for attempt_index, attempt in enumerate(retry_attempts, start=1):
                attempt_size = attempt["size"]
                attempt_quality = attempt["quality"]
                use_fallback = attempt["use_fallback"]
                delay_before = attempt["delay"]

                # 失败后退避，避免立刻打回去再撞同一波抖动
                if attempt_index > 1 and delay_before > 0:
                    print(f"[OpenAI Images] 退避 {delay_before}s 后重试…")
                    _time.sleep(delay_before)

                # 选用本次 attempt 的 provider 配置
                if use_fallback and fallback_provider:
                    active_url = fallback_url
                    active_key = fallback_key
                    active_model = fallback_model or self.model
                    active_pid = fallback_id or "fallback"
                else:
                    active_url = base_url
                    active_key = self.api_key
                    active_model = self.model
                    active_pid = "current"

                request_headers = {
                    "Authorization": f"Bearer {active_key}",
                    "Content-Type": "application/json",
                }
                payload["size"] = attempt_size
                payload["model"] = active_model
                if attempt_quality:
                    payload["quality"] = attempt_quality
                else:
                    payload.pop("quality", None)

                if attempt_index > 1:
                    print(f"[OpenAI Images] 重试 #{attempt_index}: provider={active_pid} url={active_url} model={active_model} size={attempt_size} quality={attempt_quality or 'default'}")

                attempt_start = _time.time()
                try:
                    resp = req_lib.post(
                        f"{active_url}/v1/images/generations",
                        json=payload,
                        headers=request_headers,
                        timeout=900,
                    )
                    elapsed = round(_time.time() - attempt_start, 1)
                except req_lib.exceptions.RequestException as req_err:
                    elapsed = round(_time.time() - attempt_start, 1)
                    last_error = req_err
                    print(f"[OpenAI Images] 请求异常 ({elapsed}s, provider={active_pid}): {req_err}")
                    if attempt_index < len(retry_attempts):
                        continue
                    raise

                if resp.status_code != 200:
                    error_text = resp.text[:300]
                    if attempt_index < len(retry_attempts) and resp.status_code in {400, 408, 422, 429, 500, 502, 503, 504}:
                        print(f"[OpenAI Images] HTTP {resp.status_code} (provider={active_pid})，准备退避重试: {error_text}")
                        continue
                    print(f"[OpenAI Images] HTTP {resp.status_code} (provider={active_pid}): {error_text}")
                    return {"success": False, "error": f"HTTP {resp.status_code}: {error_text}"}

                # 成功——把当前生效的 provider 配置回写到局部变量，供后续逻辑（图保存等）使用正确 base_url
                resolved_size = attempt_size
                resolved_quality = attempt_quality
                if use_fallback and fallback_provider:
                    base_url = active_url  # 后续 _fetch_image_bytes 用 base_url 拼相对路径，必须切到生效的那个
                    headers = request_headers
                break

            if resp is None:
                raise last_error or RuntimeError("OpenAI Images request did not return a response")

            data = resp.json()
            images = []
            remote_urls = []
            recovery_ids = []
            for item in data.get("data", []):
                b64_str = item.get("b64_json")
                if b64_str:
                    img_bytes = base64.b64decode(b64_str)
                    try:
                        _chk = Image.open(BytesIO(img_bytes))
                        print(f"[OpenAI Images] 返回图尺寸: {_chk.width}x{_chk.height}, target={resolved_size}")
                    except Exception:
                        pass
                    img_result = self._save_and_process_image(img_bytes, target_size=resolved_size)
                    images.append(img_result)
                    print(f"[OpenAI Images] 图片提取成功 ({len(img_bytes)//1024}KB)")

            if not images:
                # 尝试从 URL 下载（兼容 https URL / 相对路径 / data:image base64 三种）
                for item in data.get("data", []):
                    url = str(item.get("url") or "").strip()
                    if url:
                        record = None
                        try:
                            # data URI 太长不适合作 key/日志，截短作为 remote_url 标识
                            url_for_log = url if not url.startswith("data:") else url[:64] + f"...({len(url)}B)"
                            remote_urls.append(url_for_log)
                            record = recovery_create(
                                url_for_log,
                                prompt=prompt,
                                model=self.model,
                                size=resolved_size,
                                quality=resolved_quality or "",
                                task_meta=task_meta,
                                status="downloading",
                            )
                            recovery_ids.append(record["id"])
                            img_bytes, status, err = self._fetch_image_bytes(url, base_url, timeout=180)
                            if status == 200 and img_bytes:
                                _width = None
                                _height = None
                                try:
                                    _chk = Image.open(BytesIO(img_bytes))
                                    _width, _height = _chk.width, _chk.height
                                    print(f"[OpenAI Images] 返回图尺寸: {_width}x{_height}, target={resolved_size}")
                                except Exception:
                                    pass
                                img_result = self._save_and_process_image(img_bytes, target_size=resolved_size)
                                img_result["recovery_id"] = record["id"]
                                img_result["remote_url"] = url_for_log
                                images.append(img_result)
                                recovery_update(
                                    record["id"],
                                    status="downloaded",
                                    local_path=img_result.get("filepath"),
                                    local_url=img_result.get("url"),
                                    downloaded_at=recovery_now(),
                                    width=_width,
                                    height=_height,
                                )
                                src = "data URI" if url.startswith("data:") else "URL"
                                print(f"[OpenAI Images] 从 {src} 下载成功 ({len(img_bytes)//1024}KB)")
                            else:
                                recovery_update(
                                    record["id"],
                                    status="download_failed",
                                    last_error=err or f"HTTP {status}",
                                    attempts=int(record.get("attempts") or 0) + 1,
                                )
                                print(f"[OpenAI Images] URL/data 下载失败: {err}")
                        except Exception as dl_err:
                            if record:
                                recovery_update(
                                    record["id"],
                                    status="download_failed",
                                    last_error=str(dl_err),
                                    attempts=int(record.get("attempts") or 0) + 1,
                                )
                            print(f"[OpenAI Images] URL 下载异常: {dl_err}")

            if not images:
                return {
                    "success": False,
                    "stage": "download_result",
                    "remote_urls": remote_urls,
                    "recovery_ids": recovery_ids,
                    "error": f"响应中无图片: {str(data)[:200]}",
                }

            print(f"[OpenAI Images] 成功生成 {len(images)} 张图片, 耗时 {elapsed}s")
            return {"success": True, "images": images, "count": len(images), "recovery_ids": recovery_ids}

        except Exception as e:
            elapsed = round(_time.time() - start, 1)
            error_detail = traceback.format_exc()
            print(f"[OpenAI Images] 生成失败 ({elapsed}s): {error_detail}")
            raise e

    def _generate_openai_images_edit(self, prompt, reference_images, size, quality, headers, base_url, task_meta=None):
        """OpenAI 图生图 (gpt-image-2 /v1/images/edits)"""
        import requests as req_lib
        import time as _time

        def _extract_raw_bytes(img_data):
            src = str(img_data or "").strip()
            if not src:
                return None
            if src.startswith("/api/images/"):
                filename = src.replace("/api/images/", "")
                filepath = os.path.join(self.output_folder, filename)
                if os.path.exists(filepath):
                    with open(filepath, "rb") as f:
                        return f.read()
                return None
            if src.startswith("data:image"):
                b64_part = src.split(",", 1)[1] if "," in src else src
                return base64.b64decode(b64_part)
            return base64.b64decode(src)

        def _prepare_reference_upload(img_data, ref_index):
            raw_bytes = _extract_raw_bytes(img_data)
            if not raw_bytes:
                return None

            _raw_img = Image.open(BytesIO(raw_bytes))
            _stored_w, _stored_h = _raw_img.width, _raw_img.height
            img = ImageOps.exif_transpose(_raw_img)
            _orig_w, _orig_h = img.width, img.height
            if (_stored_w, _stored_h) != (_orig_w, _orig_h):
                print(f"[OpenAI Images Edit] 参考图{ref_index} EXIF 转正: {_stored_w}x{_stored_h} -> {_orig_w}x{_orig_h}")
            if img.mode not in ("RGB", "RGBA"):
                img = img.convert("RGB")

            _MAX_LONG_EDGE = 4096
            _long = max(img.width, img.height)
            if _long > _MAX_LONG_EDGE:
                _scale = _MAX_LONG_EDGE / _long
                _nw = max(16, int(round(img.width * _scale)))
                _nh = max(16, int(round(img.height * _scale)))
                img = img.resize((_nw, _nh), Image.LANCZOS)
                print(f"[OpenAI Images Edit] 参考图{ref_index} 等比缩放(长边>{_MAX_LONG_EDGE}): {_orig_w}x{_orig_h} -> {img.width}x{img.height}")
            else:
                print(f"[OpenAI Images Edit] 参考图{ref_index} 原比例上传: {img.width}x{img.height}, target size={size}")

            _UPLOAD_LIMIT = 10 * 1024 * 1024
            _rgb = img.convert("RGB") if img.mode == "RGBA" else img
            _jpg_buf = BytesIO()
            _rgb.save(_jpg_buf, format="JPEG", quality=92)
            upload_bytes = _jpg_buf.getvalue()
            if len(upload_bytes) > _UPLOAD_LIMIT:
                _scale = 0.85
                _nw = max(16, int(img.width * _scale))
                _nh = max(16, int(img.height * _scale))
                img = img.resize((_nw, _nh), Image.LANCZOS)
                _rgb = img.convert("RGB") if img.mode == "RGBA" else img
                _jpg_buf = BytesIO()
                _rgb.save(_jpg_buf, format="JPEG", quality=92)
                upload_bytes = _jpg_buf.getvalue()
                print(f"[OpenAI Images Edit] 参考图{ref_index} 超限缩图: -> {img.width}x{img.height}, JPEG={len(upload_bytes)//1024}KB")
            else:
                print(f"[OpenAI Images Edit] 参考图{ref_index} 上传: {img.width}x{img.height}, JPEG={len(upload_bytes)//1024}KB")

            return {
                "filename": f"reference-{ref_index}.jpg",
                "upload_bytes": upload_bytes,
            }

        print(f"[OpenAI Images Edit] 检测到 {len(reference_images)} 张参考图，使用图生图模式")

        start = _time.time()
        try:
            reference_uploads = []
            for ref_index, img_data in enumerate(reference_images, start=1):
                upload_info = _prepare_reference_upload(img_data, ref_index)
                if not upload_info:
                    return {"success": False, "error": f"无法解析第 {ref_index} 张参考图"}
                reference_uploads.append(upload_info)

            if len(reference_uploads) > 1:
                print(f"[OpenAI Images Edit] 上传 {len(reference_uploads)} 张参考图到 edits 接口")

            is_tile_workflow_request = isinstance(task_meta, dict) and (
                task_meta.get("tile_stage") is not None
                or task_meta.get("tile_total") is not None
            )
            fallback_provider = None if is_tile_workflow_request else self._find_image_fallback_provider(base_url)
            fallback_url = (fallback_provider.get("api_url") or "").rstrip("/") if fallback_provider else None
            fallback_key = fallback_provider.get("api_key") if fallback_provider else None
            fallback_model = fallback_provider.get("model") if fallback_provider else None
            fallback_id = fallback_provider.get("id") if fallback_provider else None

            retry_attempts = [{"size": size, "quality": quality, "use_fallback": False, "delay": 0}]
            if fallback_provider:
                retry_attempts.append({"size": size, "quality": quality, "use_fallback": True, "delay": 5})

            downshift_size = self._downshift_openai_size(size)
            if downshift_size:
                retry_attempts.append({
                    "size": downshift_size,
                    "quality": "medium" if quality == "high" else quality,
                    "use_fallback": bool(fallback_provider),
                    "delay": 30 if fallback_provider else 0,
                })

            if is_tile_workflow_request:
                print("[OpenAI Images Edit] tile workflow request; provider fallback disabled for tile consistency")
            elif fallback_provider:
                print(f"[OpenAI Images Edit] loaded fallback provider: id={fallback_id} url={fallback_url} model={fallback_model}")
            else:
                print("[OpenAI Images Edit] no fallback provider found; using local downshift retry only")

            resp = None
            elapsed = 0
            last_error = None
            attempt_errors = []
            current_key = getattr(self, "api_key", None) or headers.get("Authorization", "").replace("Bearer ", "", 1).strip()

            for attempt_index, attempt in enumerate(retry_attempts, start=1):
                attempt_size = attempt["size"]
                attempt_quality = attempt["quality"]
                use_fallback = attempt["use_fallback"]
                delay_before = attempt["delay"]

                if attempt_index > 1 and delay_before > 0:
                    print(f"[OpenAI Images Edit] retry after {delay_before}s backoff")
                    _time.sleep(delay_before)

                if use_fallback and fallback_provider:
                    active_url = fallback_url
                    active_key = fallback_key
                    active_model = fallback_model or self.model
                    active_pid = fallback_id or "fallback"
                else:
                    active_url = base_url
                    active_key = current_key
                    active_model = self.model
                    active_pid = "current"

                form_data = {
                    "model": active_model,
                    "prompt": prompt,
                    "size": attempt_size,
                }
                if attempt_quality:
                    form_data["quality"] = attempt_quality
                if "api.openai.com" not in active_url:
                    form_data["response_format"] = "url"

                edit_headers = {"Authorization": f"Bearer {active_key}"}
                files = [
                    ("image", (item["filename"], item["upload_bytes"], "image/jpeg"))
                    for item in reference_uploads
                ]

                label = "retry" if attempt_index > 1 else "attempt"
                print(f"[OpenAI Images Edit] {label} #{attempt_index}: provider={active_pid} url={active_url} model={active_model} size={attempt_size} quality={attempt_quality or 'default'}")

                attempt_start = _time.time()
                try:
                    resp = req_lib.post(
                        f"{active_url}/v1/images/edits",
                        data=form_data,
                        files=files,
                        headers=edit_headers,
                        timeout=900,
                    )
                    elapsed = round(_time.time() - attempt_start, 1)
                except req_lib.exceptions.RequestException as req_err:
                    elapsed = round(_time.time() - attempt_start, 1)
                    last_error = req_err
                    attempt_errors.append(f"{active_pid} request error ({elapsed}s): {req_err}")
                    print(f"[OpenAI Images Edit] request error ({elapsed}s, provider={active_pid}): {req_err}")
                    if attempt_index < len(retry_attempts):
                        continue
                    raise

                if resp.status_code != 200:
                    error_text = resp.text[:300]
                    attempt_errors.append(f"{active_pid} HTTP {resp.status_code}: {error_text}")
                    if attempt_index < len(retry_attempts) and resp.status_code in {400, 408, 422, 429, 500, 502, 503, 504}:
                        print(f"[OpenAI Images Edit] HTTP {resp.status_code} (provider={active_pid}), retrying: {error_text}")
                        continue
                    print(f"[OpenAI Images Edit] HTTP {resp.status_code} (provider={active_pid}): {error_text}")
                    if attempt_errors:
                        return {"success": False, "error": f"图生图失败；尝试链路: {' | '.join(attempt_errors)}"}
                    return {"success": False, "error": f"图生图失败 HTTP {resp.status_code}: {error_text}"}

                base_url = active_url
                size = attempt_size
                quality = attempt_quality
                if use_fallback and fallback_provider:
                    headers = edit_headers
                break

            if resp is None:
                raise last_error or RuntimeError("OpenAI Images Edit request did not return a response")

            data = resp.json()
            images = []
            remote_urls = []
            recovery_ids = []
            for item in data.get("data", []):
                b64_str = item.get("b64_json")
                if b64_str:
                    img_bytes = base64.b64decode(b64_str)
                    _chk = Image.open(BytesIO(img_bytes))
                    print(f"[OpenAI Images Edit] 返回图尺寸: {_chk.width}x{_chk.height}")
                    img_result = self._save_and_process_image(img_bytes, target_size=size)
                    images.append(img_result)
                    continue

                url = str(item.get("url") or "").strip()
                if url:
                    url_for_log = url if not url.startswith("data:") else url[:64] + f"...({len(url)}B)"
                    remote_urls.append(url_for_log)
                    record = recovery_create(
                        url_for_log,
                        prompt=prompt,
                        model=self.model,
                        size=size,
                        quality=quality or "",
                        task_meta=task_meta,
                        status="downloading",
                    )
                    recovery_ids.append(record["id"])
                    img_bytes, status, err = self._fetch_image_bytes(url, base_url, timeout=180)
                    if status != 200 or not img_bytes:
                        recovery_update(
                            record["id"],
                            status="download_failed",
                            last_error=err or f"HTTP {status}",
                            attempts=int(record.get("attempts") or 0) + 1,
                        )
                        print(f"[OpenAI Images Edit] URL/data 下载失败: {err}")
                        continue
                    _chk = Image.open(BytesIO(img_bytes))
                    src = "data URI" if url.startswith("data:") else "URL"
                    print(f"[OpenAI Images Edit] {src} 返回图尺寸: {_chk.width}x{_chk.height} ({len(img_bytes)//1024}KB)")
                    img_result = self._save_and_process_image(img_bytes, target_size=size)
                    img_result["recovery_id"] = record["id"]
                    img_result["remote_url"] = url_for_log
                    images.append(img_result)
                    recovery_update(
                        record["id"],
                        status="downloaded",
                        local_path=img_result.get("filepath"),
                        local_url=img_result.get("url"),
                        downloaded_at=recovery_now(),
                        width=_chk.width,
                        height=_chk.height,
                    )

            if not images:
                return {
                    "success": False,
                    "stage": "download_result",
                    "remote_urls": remote_urls,
                    "recovery_ids": recovery_ids,
                    "error": f"图生图响应中无图片: {str(data)[:200]}",
                }

            print(f"[OpenAI Images Edit] 成功生成 {len(images)} 张, 耗时 {elapsed}s")
            return {"success": True, "images": images, "count": len(images), "recovery_ids": recovery_ids}

        except Exception as e:
            elapsed = round(_time.time() - start, 1)
            error_detail = traceback.format_exc()
            print(f"[OpenAI Images Edit] ?? ({elapsed}s): {error_detail}")
            raise e

    def _generate_gemini_native_http(self, prompt, aspect_ratio, resolution, reference_images):
        """第三方 Gemini 原生协议 (SuXi.ai 等): Bearer auth + imageConfig"""
        import requests as req_lib
        from requests.adapters import HTTPAdapter
        from urllib3.util.retry import Retry
        import time as _time

        # 1. 构建请求 parts
        parts = []

        # 添加参考图（压缩后发送，减少 payload）
        if reference_images:
            for idx, img_data in enumerate(reference_images):
                try:
                    raw_bytes = None
                    if img_data.startswith("/api/images/"):
                        filename = img_data.replace("/api/images/", "")
                        filepath = os.path.join(self.output_folder, filename)
                        if os.path.exists(filepath):
                            with open(filepath, "rb") as f:
                                raw_bytes = f.read()
                    elif img_data.startswith("data:image"):
                        b64_part = img_data.split(",")[1] if "," in img_data else img_data
                        raw_bytes = base64.b64decode(b64_part)
                    else:
                        raw_bytes = base64.b64decode(img_data)

                    if raw_bytes:
                        compressed = self._compress_reference_image(raw_bytes)
                        b64_str = base64.b64encode(compressed).decode("utf-8")
                        parts.append({
                            "inlineData": {"mimeType": "image/jpeg", "data": b64_str}
                        })
                        print(f"[Gemini Native HTTP] 参考图 {idx+1} 已添加 (压缩后 {len(compressed)//1024}KB)")
                except Exception as e:
                    print(f"[Gemini Native HTTP] 参考图 {idx+1} 处理出错: {e}")

        # 添加文本提示词
        parts.append({"text": prompt})

        # 2. 构建请求
        base_url = self.api_url.rstrip("/")
        url = f"{base_url}/v1beta/models/{self.model}:generateContent"
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }
        payload = {
            "contents": [{"parts": parts}],
            "generationConfig": {
                "responseModalities": ["TEXT", "IMAGE"],
                "imageConfig": {
                    "imageSize": resolution,
                    "aspectRatio": aspect_ratio,
                },
            },
        }

        print(f"[Gemini Native HTTP] URL: {url}, imageSize: {resolution}, aspectRatio: {aspect_ratio}")
        print(f"[Gemini Native HTTP] 参考图数量: {len(parts)-1}, 总 parts: {len(parts)}")

        # 3. 发送请求（带重试）
        max_retries = 3
        last_error = None
        for attempt in range(1, max_retries + 1):
            try:
                session = req_lib.Session()
                retry_strategy = Retry(total=0)  # 由外层循环控制重试
                adapter = HTTPAdapter(max_retries=retry_strategy)
                session.mount("https://", adapter)
                session.mount("http://", adapter)

                response = session.post(url, json=payload, headers=headers, timeout=600)
                if response.status_code >= 400:
                    body_text = ""
                    try:
                        body_text = response.text or ""
                    except Exception:
                        pass
                    snippet = body_text[:2000]
                    print(f"[Gemini Native HTTP] HTTP {response.status_code} body: {snippet}")
                    raise req_lib.HTTPError(
                        f"HTTP {response.status_code} {response.reason} | body: {snippet}",
                        response=response,
                    )
                result = response.json()
                break
            except (req_lib.exceptions.ConnectionError, req_lib.exceptions.SSLError) as e:
                last_error = e
                if attempt < max_retries:
                    wait = 3 * attempt
                    print(f"[Gemini Native HTTP] 连接失败 (尝试 {attempt}/{max_retries}), {wait}秒后重试: {e}")
                    _time.sleep(wait)
                else:
                    print(f"[Gemini Native HTTP] 连接失败，已重试 {max_retries} 次")
                    raise last_error

        # 4. 提取图片
        candidates = result.get("candidates", [])
        if not candidates:
            raise Exception("Gemini 返回无候选结果")

        images = []
        resp_parts = candidates[0].get("content", {}).get("parts", [])
        for part in resp_parts:
            inline_data = part.get("inlineData")
            if inline_data and inline_data.get("mimeType", "").startswith("image/"):
                b64_str = inline_data.get("data")
                if b64_str:
                    img_bytes = base64.b64decode(b64_str)
                    img_result = self._save_and_process_image(img_bytes)
                    images.append(img_result)
                    print(f"[Gemini Native HTTP] 图片提取成功: {img_result.get('width')}x{img_result.get('height')}")

        if not images:
            for part in resp_parts:
                if "text" in part:
                    print(f"[Gemini Native HTTP] 模型返回文本: {part['text'][:200]}")
            raise Exception("Gemini 响应中未找到图片数据")

        return {"success": True, "images": images, "count": len(images)}

    _CHAT_IMAGE_RATIO_CANDIDATES = [
        (1.0, "1:1", "square 1:1"),
        (3 / 2, "3:2", "horizontal 3:2"),
        (2 / 3, "2:3", "vertical 2:3"),
        (16 / 9, "16:9", "widescreen horizontal 16:9"),
        (9 / 16, "9:16", "vertical portrait 9:16"),
        (4 / 3, "4:3", "horizontal 4:3"),
        (3 / 4, "3:4", "vertical 3:4"),
        (1 / 4, "1:4", "tall vertical 1:4"),
        (1 / 8, "1:8", "extremely tall vertical 1:8"),
    ]

    def _ratio_from_dimensions(self, width, height):
        """将 W/H 匹配到最接近的标准比例候选，返回 (ratio_str, hint_str) 或 None"""
        try:
            w = float(width)
            h = float(height)
        except Exception:
            return None
        if w <= 0 or h <= 0:
            return None
        r = w / h
        best = min(self._CHAT_IMAGE_RATIO_CANDIDATES, key=lambda c: abs(c[0] - r))
        return (best[1], best[2])

    def _generate_chat_completions_image(self, prompt, aspect_ratio, resolution, reference_images, size=None):
        """Chat-based 图像生成 (gpt-5.4-mini / gpt-4o 等多模态模型)
        通过 /v1/chat/completions 端点 + messages.content array，
        解析 choices[0].message.images[].image_url.url 拿 base64 或远程 URL

        size 支持 4 种格式（与标准 OpenAI Images 各子提供商保持兴容）：
          1) WxH 直接指定 (如 1024x1024)
          2) original:max  -> 原图比例贴 OpenAI 像素上限
          3) original:NNN  -> 原图比例，长边 NNN
          4) original:scaleN -> 原图尺寸 × N (倍率)
        由于 chat 模式无 size 参数可传，仅能把目标像素和最近比例加进 prompt hint，
        实际输出尺寸由模型决定（实测 gpt-5.4-mini 会选 1024² / 1536×1024 / 1024×1536）。
        """
        import requests as req_lib
        from requests.adapters import HTTPAdapter
        from urllib3.util.retry import Retry
        import time as _time

        # 1. 比例提示词（chat 模式无 size 参数，靠 prompt 引导）
        ratio_hint_map = {item[1]: item[2] for item in self._CHAT_IMAGE_RATIO_CANDIDATES}
        ratio_hint = ratio_hint_map.get(aspect_ratio or "", "")
        target_dims = None  # 如果 size 传了 original:* 或 WxH，这里存解析后的 "WxH"

        # 2. 解析 size 串（复用 _normalize_openai_size 逻辑与 CPA 渠道保持一致）
        if size:
            try:
                normalized = self._normalize_openai_size(size, reference_images, aspect_ratio)
            except Exception as e:
                normalized = None
                print(f"[Chat Image] _normalize_openai_size 失败 size={size}: {e}")
            if normalized:
                m = re.match(r"^(\d+)x(\d+)$", normalized)
                if m:
                    target_w = int(m.group(1))
                    target_h = int(m.group(2))
                    target_dims = f"{target_w}x{target_h}"
                    ratio_info = self._ratio_from_dimensions(target_w, target_h)
                    if ratio_info:
                        ratio_str, hint_str = ratio_info
                        ratio_hint = hint_str
                        print(f"[Chat Image] size '{size}' 解析 -> {target_dims}, 匹配比例: {ratio_str}")

        full_prompt = f"Generate an image: {prompt}"
        if ratio_hint:
            full_prompt += f". Aspect ratio: {ratio_hint}."
        if target_dims:
            full_prompt += f" Target output dimensions approximately {target_dims} pixels."

        # 2. 构造 messages：两个分支都用 array 多模态格式
        # 关键: gpt-4o / gpt-5.x 的 image generation 能力，要求 content 是 array (即使纯文本),
        # 否则可能降级到普通文本对话，模型不会触发完整 image pipeline，
        # 表现为：返回小尺寸固定档位（如 941×1672）、忽略 ratio hint、或干脆只返回文字。
        # 之前文生图 content=string 的 bug 在 2026-05-12 修正。
        content = [{"type": "text", "text": full_prompt}]
        if reference_images:
            for idx, img_data in enumerate(reference_images):
                try:
                    raw_bytes = self._load_reference_image_bytes(img_data)
                    if not raw_bytes:
                        continue
                    compressed = self._compress_reference_image(raw_bytes)
                    b64_str = base64.b64encode(compressed).decode("utf-8")
                    data_url = f"data:image/jpeg;base64,{b64_str}"
                    content.append({
                        "type": "image_url",
                        "image_url": {"url": data_url},
                    })
                    print(f"[Chat Image] 参考图 {idx+1} 已添加 (压缩后 {len(compressed)//1024}KB)")
                except Exception as e:
                    print(f"[Chat Image] 参考图 {idx+1} 处理出错: {e}")
        messages = [{"role": "user", "content": content}]

        base_url = self.api_url.rstrip("/")
        url = f"{base_url}/v1/chat/completions"
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
            "Accept": "text/event-stream",
        }
        # stream=True 关键作用：第三方网关收到 stream 请求后通常立刻返 200 + Transfer-Encoding: chunked，
        # Cloudflare 524 仅在 origin 100s 内没有任何字节响应时触发；stream 模式立刻有头响应，CF 不会切断。
        # 已验证 codexapis_chat_mini 走 SSE 返回 delta.images（探针 _probe_codexapis_stream.py 2026-05-11）。
        payload = {"model": self.model, "messages": messages, "stream": True}

        print(f"[Chat Image] URL: {url}, 比例提示: {ratio_hint or '无'}, 参考图: {len(reference_images) if reference_images else 0}, stream=True")

        # 3. 发送请求（stream 模式，带重试）
        max_retries = 3
        last_error = None
        result = None
        for attempt in range(1, max_retries + 1):
            try:
                session = req_lib.Session()
                retry_strategy = Retry(total=0)
                adapter = HTTPAdapter(max_retries=retry_strategy)
                session.mount("https://", adapter)
                session.mount("http://", adapter)
                # connect 10s + read 600s；stream=True 让 requests 不立即读完 body，由 iter_lines 增量消费
                response = session.post(
                    url, json=payload, headers=headers,
                    stream=True, timeout=(10, 600),
                )
                if response.status_code >= 400:
                    body_text = ""
                    try:
                        body_text = response.text or ""
                    except Exception:
                        pass
                    snippet = body_text[:2000]
                    print(f"[Chat Image] HTTP {response.status_code} body: {snippet}")
                    # 524 / 502 / 503 / 504：网关侧失败，但模型可能已生成并扣费
                    # 落一条 recovery 记录用于事后到 provider 后台对账（不会触发自动下载，URL 是占位符）
                    if response.status_code in (524, 502, 503, 504):
                        try:
                            req_id = (
                                response.headers.get("x-request-id")
                                or response.headers.get("x-amzn-requestid")
                                or response.headers.get("cf-ray")
                                or uuid.uuid4().hex[:12]
                            )
                            recovery_create(
                                remote_url=f"cf{response.status_code}://billed-pending-{req_id}",
                                prompt=prompt,
                                model=self.model,
                                size=size or "",
                                quality="",
                                task_meta={
                                    "kind": "chat_image_gateway_failure",
                                    "provider_url": base_url,
                                    "aspect_ratio": aspect_ratio,
                                    "resolution": resolution,
                                    "ref_image_count": len(reference_images) if reference_images else 0,
                                    "request_id": req_id,
                                    "status_code": response.status_code,
                                    "note": "网关返回 5xx，但模型可能已生成并扣费，请到 provider 后台用 request_id 对账",
                                },
                                status="cf_billed_pending",
                            )
                            print(
                                f"[Chat Image] ⚠️ HTTP {response.status_code} 已记录 recovery (request_id={req_id})，"
                                f"此单可能已扣费，请到 {base_url} 后台用 request_id 对账",
                                level="error",
                            )
                        except Exception as _rec_err:
                            print(f"[Chat Image] recovery_create 失败: {_rec_err}", level="error")
                    raise req_lib.HTTPError(
                        f"HTTP {response.status_code} {response.reason} | body: {snippet}",
                        response=response,
                    )

                # 读 SSE 流，累积 delta.images 与可能的 final message.images
                _stream_collected = []  # delta.images 列表，每项 {"type":...,"image_url":...}
                _stream_final_msg = None  # 部分 provider 在最后给完整 message
                _stream_finish_reason = None
                _stream_text_acc = ""  # 偶发的 delta.content 文本（用于失败时回显）
                for raw_line in response.iter_lines(decode_unicode=True):
                    if not raw_line:
                        continue
                    if not raw_line.startswith("data: "):
                        # SSE event/id/retry/comment 行，忽略
                        continue
                    payload_str = raw_line[6:]
                    if payload_str.strip() == "[DONE]":
                        break
                    try:
                        chunk = json.loads(payload_str)
                    except Exception:
                        continue
                    for c in (chunk.get("choices") or []):
                        delta = c.get("delta") or {}
                        msg = c.get("message")
                        fr = c.get("finish_reason")
                        if fr:
                            _stream_finish_reason = fr
                        d_images = delta.get("images")
                        if d_images:
                            _stream_collected.extend(d_images)
                        d_content = delta.get("content")
                        if isinstance(d_content, str):
                            _stream_text_acc += d_content
                        if msg and msg.get("images"):
                            _stream_final_msg = msg
                # 构造与原同步版本结构兼容的 result：下游解析 result.choices[0].message.images
                if _stream_final_msg is None:
                    _stream_final_msg = {"images": _stream_collected, "content": _stream_text_acc or None}
                else:
                    # delta.images 与 final message.images 合并去重（按 image_url）
                    _existing = set()
                    for _it in (_stream_final_msg.get("images") or []):
                        _u = _it.get("image_url")
                        if isinstance(_u, dict):
                            _u = _u.get("url")
                        if _u:
                            _existing.add(_u)
                    for _it in _stream_collected:
                        _u = _it.get("image_url")
                        if isinstance(_u, dict):
                            _u = _u.get("url")
                        if _u and _u not in _existing:
                            _stream_final_msg.setdefault("images", []).append(_it)
                result = {"choices": [{"message": _stream_final_msg, "finish_reason": _stream_finish_reason}]}
                print(
                    f"[Chat Image] SSE 完成: images={len(_stream_final_msg.get('images') or [])}, "
                    f"finish_reason={_stream_finish_reason}"
                )
                break
            except (req_lib.exceptions.ConnectionError, req_lib.exceptions.SSLError, req_lib.exceptions.ChunkedEncodingError) as e:
                last_error = e
                if attempt < max_retries:
                    wait = 3 * attempt
                    print(f"[Chat Image] 连接失败 (尝试 {attempt}/{max_retries}), {wait}秒后重试: {e}")
                    _time.sleep(wait)
                else:
                    print(f"[Chat Image] 连接失败，已重试 {max_retries} 次")
                    raise last_error

        # 4. 解析图片
        choices = (result or {}).get("choices") or []
        if not choices:
            raise Exception(f"Chat 响应中无 choices: {str(result)[:200]}")

        msg = choices[0].get("message", {}) or {}
        msg_images = msg.get("images") or []

        images = []
        for idx, item in enumerate(msg_images):
            img_url = item.get("image_url")
            if isinstance(img_url, dict):
                img_url = img_url.get("url")
            if not img_url:
                continue
            img_bytes = None
            if "data:image" in img_url:
                try:
                    b64_part = img_url.split(",", 1)[1]
                    img_bytes = base64.b64decode(b64_part)
                except Exception as e:
                    print(f"[Chat Image] base64 解析失败 idx={idx}: {e}")
                    continue
            else:
                # 远程 URL，下载
                try:
                    rr = req_lib.get(img_url, timeout=180)
                    if rr.status_code != 200:
                        print(f"[Chat Image] 图片 URL 下载失败: HTTP {rr.status_code} url={img_url[:120]}")
                        continue
                    img_bytes = rr.content
                except Exception as e:
                    print(f"[Chat Image] 图片 URL 下载异常: {e}")
                    continue
            if not img_bytes:
                continue
            img_result = self._save_and_process_image(img_bytes)
            # 用 PIL 实算尺寸打印（_save_and_process_image 默认不返 width/height）
            _size_str = "?"
            try:
                from PIL import Image as _PIL
                import io as _io
                _img = _PIL.open(_io.BytesIO(img_bytes))
                _size_str = f"{_img.size[0]}x{_img.size[1]}"
            except Exception:
                pass
            images.append(img_result)
            print(f"[Chat Image] 图片提取成功: {_size_str}, {len(img_bytes)//1024}KB")

        if not images:
            text_content = msg.get("content") or ""
            print(f"[Chat Image] 响应无图片，模型返回文本: {str(text_content)[:300]}")
            raise Exception(f"Chat 响应中未找到图片数据: {str(text_content)[:200]}")

        return {"success": True, "images": images, "count": len(images)}

    def _generate_openai(self, prompt, aspect_ratio, resolution, reference_images):
        """图生图：使用 Gemini 原生协议（避免 dall-e 映射）"""
        print(
            f"[Gemini Native 图生图] 开始生成: {self.model}, 比例: {aspect_ratio}, 分辨率: {resolution}"
        )
        print(f"[Gemini Native 图生图] 参考图数量: {len(reference_images) if reference_images else 0}")

        # 1. 构造 Gemini 原生模型名（带分辨率和比例后缀）
        res_tag = resolution.lower()  # 4K -> 4k
        ar_tag = aspect_ratio.replace(":", "x")  # 16:9 -> 16x9
        base_model = self.model.replace("-preview", "")
        # 清理可能的旧参数后缀
        for tag in ["-4k", "-2k", "-1k", "-16x9", "-9x16", "-1x1", "-4x3", "-3x4"]:
            if tag in base_model:
                base_model = base_model.replace(tag, "")
        # 如果模型名没有 image，自动补上
        if "gemini-3" in base_model:
            if "pro" in base_model:
                base_model = base_model.replace("pro", "pro-image")
        target_model = f"{base_model}-{res_tag}-{ar_tag}"
        print(f"[Gemini Native 图生图] 原始模型: {self.model} -> 映射模型: {target_model}")

        try:
            import requests as req_lib

            # 2. 构建 Gemini 原生请求 parts（文本 + 参考图）
            parts = []

            # 添加参考图
            if reference_images:
                for img_data in reference_images:
                    try:
                        b64_str = ""
                        # 情况A: 本地路径 /api/images/xxx
                        if img_data.startswith("/api/images/"):
                            filename = img_data.replace("/api/images/", "")
                            filepath = os.path.join(self.output_folder, filename)
                            if os.path.exists(filepath):
                                with open(filepath, "rb") as f:
                                    b64_str = base64.b64encode(f.read()).decode("utf-8")
                        # 情况B: Base64 data URI
                        elif img_data.startswith("data:image"):
                            if "," in img_data:
                                b64_str = img_data.split(",")[1]
                            else:
                                b64_str = img_data
                        # 情况C: 纯 Base64
                        else:
                            b64_str = img_data

                        if b64_str:
                            parts.append({
                                "inlineData": {
                                    "mimeType": "image/jpeg",
                                    "data": b64_str
                                }
                            })
                            print(f"[Gemini Native 图生图] 参考图已添加 (base64 长度: {len(b64_str)})")
                    except Exception as e:
                        print(f"[Gemini Native 图生图] 参考图处理出错: {e}")

            # 添加文本提示词
            enhanced_prompt = (
                f"Generate an image with the following strict specifications:\n"
                f"Subject: {prompt}\n\n"
                f"TECHNICAL REQUIREMENTS (MUST FOLLOW):\n"
                f"1. Resolution: {resolution}\n"
                f"2. Aspect Ratio: {aspect_ratio}\n"
                f"3. Quality: Masterpiece, professional photography, 8k, sharp focus.\n"
                f"Refer to the attached images for composition, style, and color palette. "
                f"STRICTLY follow the reference style.\n"
                f"Do not output any text explanation, just generate the image."
            )
            parts.append({"text": enhanced_prompt})

            # 3. 发送 Gemini generateContent 请求
            url = f"{self.api_url}/v1beta/models/{target_model}:generateContent"
            headers = {
                "x-goog-api-key": self.api_key,
                "Content-Type": "application/json",
            }
            payload = {
                "contents": [{"role": "user", "parts": parts}],
                "generationConfig": {
                    "responseModalities": ["TEXT", "IMAGE"],
                },
            }

            print(f"[Gemini Native 图生图] 请求 URL: {url}")
            response = req_lib.post(url, json=payload, headers=headers, timeout=180)
            response.raise_for_status()

            result = response.json()

            # 4. 从 Gemini 响应提取图片
            candidates = result.get("candidates", [])
            if not candidates:
                raise Exception("Gemini 返回无候选结果")

            images = []
            resp_parts = candidates[0].get("content", {}).get("parts", [])
            for part in resp_parts:
                inline_data = part.get("inlineData")
                if inline_data and inline_data.get("mimeType", "").startswith("image/"):
                    b64_str = inline_data.get("data")
                    if b64_str:
                        img_bytes = base64.b64decode(b64_str)
                        img_result = self._save_and_process_image(img_bytes)
                        images.append(img_result)
                        print(f"[Gemini Native 图生图] 图片提取成功")
                        break

            if not images:
                # 打印文本部分用于调试
                for part in resp_parts:
                    if "text" in part:
                        print(f"[Gemini Native 图生图] 模型返回文本: {part['text'][:200]}")
                raise Exception("Gemini 响应中未找到图片数据")

            print(f"[Gemini Native 图生图] 成功生成 {len(images)} 张图片")
            return {"success": True, "images": images, "count": len(images)}

        except Exception as e:
            error_detail = traceback.format_exc()
            print(f"[Gemini Native 图生图] 生成失败: {error_detail}")
            raise e

    def _generate_openai_images_api(self, prompt, aspect_ratio, resolution, count=1):
        """使用 Gemini 原生协议调用 Antigravity 生成图片（避免 dall-e 映射）"""
        print(f"[Gemini Native] 开始生成 {count} 张图片")
        print(
            f"[Gemini Native] 模型: {self.model}, 比例: {aspect_ratio}, 分辨率: {resolution}"
        )

        # 1. 构建 Gemini 原生模型名（带分辨率和比例后缀）
        res_tag = resolution.lower()  # 4K -> 4k
        ar_tag = aspect_ratio.replace(":", "x")  # 16:9 -> 16x9
        base_model = self.model.replace("-preview", "")
        target_model = f"{base_model}-{res_tag}-{ar_tag}"
        print(f"[Gemini Native] 目标模型: {target_model}")

        try:
            import requests

            images = []
            for img_idx in range(count):
                print(f"[Gemini Native] 生成第 {img_idx + 1}/{count} 张...")

                # 2. 构建 Gemini generateContent 请求
                url = f"{self.api_url}/v1beta/models/{target_model}:generateContent"
                headers = {
                    "x-goog-api-key": self.api_key,
                    "Content-Type": "application/json",
                }
                payload = {
                    "contents": [{"role": "user", "parts": [{"text": prompt}]}],
                    "generationConfig": {
                        "responseModalities": ["TEXT", "IMAGE"],
                    },
                }

                print(f"[Gemini Native] 请求 URL: {url}")
                response = requests.post(url, json=payload, headers=headers, timeout=180)
                response.raise_for_status()

                result = response.json()

                # 3. 从 Gemini 响应中提取图片
                candidates = result.get("candidates", [])
                if not candidates:
                    print(f"[Gemini Native] 警告: 无候选结果")
                    continue

                parts = candidates[0].get("content", {}).get("parts", [])
                found_image = False
                for part in parts:
                    inline_data = part.get("inlineData")
                    if inline_data and inline_data.get("mimeType", "").startswith("image/"):
                        b64_str = inline_data.get("data")
                        if b64_str:
                            img_bytes = base64.b64decode(b64_str)
                            img_result = self._save_and_process_image(img_bytes)
                            images.append(img_result)
                            found_image = True
                            print(f"[Gemini Native] 第 {img_idx + 1} 张图片提取成功")
                            break

                if not found_image:
                    # 打印文本部分用于调试
                    for part in parts:
                        if "text" in part:
                            print(f"[Gemini Native] 模型返回文本: {part['text'][:200]}")
                    print(f"[Gemini Native] 警告: 第 {img_idx + 1} 张未找到图片数据")

            print(f"[Gemini Native] 成功生成 {len(images)} 张图片")
            return {"success": True, "images": images, "count": len(images)}

        except Exception as e:
            error_detail = traceback.format_exc()
            print(f"[Gemini Native] 生成失败: {error_detail}")
            raise e

    def _generate_google(self, prompt, aspect_ratio, resolution, reference_images):
        """Google 原生模式生成逻辑"""
        if not self.client:
            raise Exception("客户端未初始化")

        # === 本地 Antigravity 中转适配 ===
        # 检测是否是本地中转 (127.0.0.1 或 8045 端口)
        is_local_proxy = self.api_url and (
            "127.0.0.1" in self.api_url
            or "localhost" in self.api_url
            or ":8045" in self.api_url
        )

        target_model = self.model
        generate_content_config = None

        if is_local_proxy:
            # 自动映射模型名: gemini-3-pro-image -> gemini-3-pro-image-4k-16x9
            res_tag = resolution.lower()  # 4K -> 4k
            ar_tag = aspect_ratio.replace(":", "x")  # 16:9 -> 16x9

            # 确保基础模型名正确 (去除可能已有的后缀)
            base_model = (
                self.model.split("-2k")[0].split("-4k")[0].replace("-preview", "")
            )
            if base_model.endswith("-image"):
                base_model = base_model  # 保持 gemini-3-pro-image
            else:
                # 尝试智能修正，如果用户填的是 gemini-3-pro-image-preview，我们得去掉 preview
                # 根据 Cherry Studio 截图，基础名应该是 gemini-3-pro-image
                if "gemini-3" in base_model:
                    base_model = "gemini-3-pro-image"

            target_model = f"{base_model}-{res_tag}-{ar_tag}"
            print(f"[本地中转适配] 原始模型: {self.model} -> 映射模型: {target_model}")

            # 本地中转通常不需要传 image_config 参数，完全靠模型名控制
            generate_content_config = types.GenerateContentConfig(
                response_modalities=["TEXT", "IMAGE"]
            )
        else:
            # 官方 Google 逻辑
            generate_content_config = types.GenerateContentConfig(
                response_modalities=["TEXT", "IMAGE"],
                image_config=types.ImageConfig(
                    aspect_ratio=aspect_ratio,
                    image_size=resolution,
                ),
            )

        print(f"生成配置: aspect_ratio={aspect_ratio}, resolution={resolution}")

        # 构建内容
        contents = [prompt]

        # 添加参考图
        if reference_images:
            for img_data in reference_images:
                try:
                    # v2: 判断是 URL 路径还是 base64
                    if img_data.startswith("/api/images/"):
                        # URL 路径方式 - 从本地文件读取
                        filename = img_data.replace("/api/images/", "")
                        filepath = os.path.join(self.output_folder, filename)
                        if os.path.exists(filepath):
                            img = Image.open(filepath)
                            contents.append(img)
                        else:
                            print(f"参考图文件不存在: {filepath}")
                    elif img_data.startswith("data:image"):
                        # base64 方式
                        img_bytes = base64.b64decode(
                            img_data.split(",")[1] if "," in img_data else img_data
                        )
                        img = Image.open(BytesIO(img_bytes))
                        contents.append(img)
                    else:
                        # 尝试作为纯 base64 处理
                        img_bytes = base64.b64decode(img_data)
                        img = Image.open(BytesIO(img_bytes))
                        contents.append(img)
                except Exception as e:
                    print(f"处理参考图失败: {str(e)}")

        # 调用 API
        response = self.client.models.generate_content(
            model=self.model,
            contents=contents,
            config=generate_content_config,
        )

        # 提取图片
        images = []

        # 检查响应结构
        if not response.candidates:
            raise Exception("API 返回空响应")

        # 遍历所有候选结果
        for candidate in response.candidates:
            if candidate.content and candidate.content.parts:
                for part in candidate.content.parts:
                    if part.inline_data is not None:
                        data_buffer = part.inline_data.data
                        img_result = self._save_and_process_image(data_buffer)
                        images.append(img_result)

        return {"success": True, "images": images, "count": len(images)}

# 全局生成器实例
generator = ImageGenerator()

@app.route("/api/init", methods=["POST"])
def init_api():
    """初始化 API"""
    try:
        data = request.json
        api_key = data.get("api_key")
        api_url = data.get("api_url")
        proxy_url = data.get("proxy_url")
        output_dir = data.get("output_dir")
        model = data.get("model")

        if not api_key:
            return jsonify({"success": False, "error": "缺少 API Key"}), 400

        success = generator.initialize(api_key, api_url, proxy_url, output_dir, model)

        if success:
            return jsonify(
                {
                    "success": True,
                    "message": "API 初始化成功",
                    "output_folder": generator.output_folder,
                }
            )
        else:
            error_msg = generator.last_error or "未知错误"
            return jsonify({"success": False, "error": f"初始化失败: {error_msg}"}), 500

    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500

@app.route("/api/generate", methods=["POST"])
def generate_image():
    """生成图片"""
    _t_start = time.time()
    provider = None
    data = {}
    result = None
    try:
        data = request.json

        prompt = data.get("prompt")
        aspect_ratio = data.get("aspect_ratio", "1:1")
        size = data.get("size")
        resolution = data.get("resolution") or size or "2K"
        quality = data.get("quality")
        model = data.get("model")
        provider_id = data.get("provider_id") or data.get("providerId")
        reference_images = data.get("reference_images", [])
        count = data.get("count", 1)
        task_meta = data.get("task_meta") if isinstance(data.get("task_meta"), dict) else {}
        tile_workflow = data.get("tile_workflow") if isinstance(data.get("tile_workflow"), dict) else None
        # mode：image=图生图（默认）/ text=文生图 / multi=多参考图。前端不传时按 reference_images 是否为空推断，
        # 保持对老前端的兼容；新前端会显式传 mode，让我们在这里做防御性校验。
        mode = str(data.get("mode") or "").strip().lower()
        if mode not in {"image", "text", "multi"}:
            # 老前端没有 mode 字段：按"有图就当图生图，没图就当文生图"的旧契约推断
            mode = "image" if reference_images else "text"

        if not prompt:
            return jsonify({"success": False, "error": "缺少提示词"}), 400

        # 防御：图生图 / 多参考图 模式必须带参考图。前端按钮已禁用类似场景，但 curl / 第三方调用 / 前端 bug
        # 可能绕过 UI 校验，这里再兜一层。否则后端会"静默退化成文生图"——你以为在做图生图，结果生成的图跟参考图毫无关系。
        if mode in {"image", "multi"} and not reference_images:
            return jsonify({
                "success": False,
                "error": f"{'图生图' if mode == 'image' else '多参考图'}模式需要至少 1 张参考图。如要做文生图请把 mode 设为 'text' 或在前端切换到「文生图」模式。",
            }), 400

        try:
            count = max(1, min(int(count), 10))
        except (TypeError, ValueError):
            count = 1

        config = load_system_config()
        provider = get_provider_by_id(config, provider_id, "image") if provider_id else get_active_provider(config, "image")
        if not provider:
            if provider_id:
                return jsonify({"success": False, "error": "未找到指定的图片供应商"}), 400
            return jsonify({"success": False, "error": "未找到已启用的图片供应商"}), 400

        target_model = str(model or provider.get("model") or config.get("gemini_model") or "").strip()
        if not target_model:
            return jsonify({"success": False, "error": "当前图片供应商未配置模型"}), 400

        push_runtime_log(
            f"[生成请求] provider={provider.get('id')} model={target_model} aspect={aspect_ratio} resolution={resolution} size={size} quality={quality} count={count}",
            level="info",
        )

        # 并发安全修复 (2026-05-11): 每请求独立实例化 ImageGenerator，避免全局 generator 单例
        # 在多 provider 并发时 initialize→generate 之间被其他线程覆盖 api_key/api_url/model 的 race condition。
        # 全局 `generator` 单例保留给 /api/init、/api/generate-video、compress_image 等其他用途。
        local_gen = ImageGenerator()

        init_ok = local_gen.initialize(
            api_key=provider.get("api_key", ""),
            api_url=provider.get("api_url", ""),
            proxy_url=config.get("proxy_url"),
            output_dir=config.get("output_dir"),
            model=target_model,
        )
        if not init_ok:
            push_runtime_log(local_gen.last_error or "图片引擎初始化失败", level="error")
            return jsonify({"success": False, "error": local_gen.last_error or "图片引擎初始化失败"}), 500

        if tile_workflow:
            result = local_gen.generate_tile_workflow(
                prompt=prompt,
                reference_images=reference_images,
                tile_workflow=tile_workflow,
                aspect_ratio=aspect_ratio,
                resolution=resolution,
                size=size,
                quality=quality,
                task_meta=task_meta,
            )
        else:
            result = local_gen.generate(
                prompt=prompt,
                aspect_ratio=aspect_ratio,
                resolution=resolution,
                reference_images=reference_images,
                count=count,
                size=size,
                quality=quality,
                task_meta=task_meta,
            )

        if tile_workflow and result.get("success"):
            data["count"] = len(result.get("images", []))
            result["count"] = len(result.get("images", []))

        if result.get("success"):
            push_runtime_log(
                f"[生成完成] success images={len(result.get('images', []))}",
                level="success",
            )
        else:
            push_runtime_log(
                f"[生成失败] {result.get('error') or '未知错误'}",
                level="error",
            )

        # ====== 生图历史记录：旁路写入，失败不影响主流程 ======
        try:
            _hist_rec = history_recorder.record_generation(
                request_body=data,
                result=result,
                provider=provider,
                elapsed_sec=time.time() - _t_start,
                machine_id=_machine_id,
                store=_history_store,
            )
            # 把 record id 回塞给前端，方便 ImageNode 下载时 PATCH canvas_save_state
            if isinstance(_hist_rec, dict) and _hist_rec.get("id") and isinstance(result, dict):
                result["history_record_id"] = _hist_rec["id"]
        except Exception as _hist_exc:
            push_runtime_log(f"[history] 记录失败: {_hist_exc}", level="warn")
        # ====== 生图历史记录结束 ======

        return jsonify(result)

    except Exception as e:
        error_detail = traceback.format_exc()
        print(f"生成失败: {error_detail}")
        # ====== 生图历史记录（失败分支）：仍尝试写一条失败记录 ======
        _hist_rec_err_id = None
        try:
            _hist_rec_err = history_recorder.record_generation(
                request_body=data if isinstance(data, dict) else {},
                result={"success": False, "error": str(e)},
                provider=provider,
                elapsed_sec=time.time() - _t_start,
                machine_id=_machine_id,
                store=_history_store,
            )
            if isinstance(_hist_rec_err, dict):
                _hist_rec_err_id = _hist_rec_err.get("id")
        except Exception as _hist_exc:
            push_runtime_log(f"[history] 异常记录失败: {_hist_exc}", level="warn")
        # ====== 生图历史记录（失败分支）结束 ======
        _err_resp = {"success": False, "error": str(e), "detail": error_detail[:500]}
        if _hist_rec_err_id:
            _err_resp["history_record_id"] = _hist_rec_err_id
        return jsonify(_err_resp), 500

@app.route("/api/runtime-logs", methods=["GET"])
def get_runtime_logs():
    try:
        since = request.args.get("since", 0)
        limit = request.args.get("limit", 100)
        try:
            since = max(0, int(since))
        except (TypeError, ValueError):
            since = 0
        try:
            limit = max(1, min(int(limit), 300))
        except (TypeError, ValueError):
            limit = 100

        with runtime_log_lock:
            logs = [entry for entry in runtime_logs if entry["id"] > since]
            latest_id = runtime_logs[-1]["id"] if runtime_logs else 0

        return jsonify({
            "success": True,
            "logs": logs[-limit:],
            "latest_id": latest_id,
        })
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


@app.route("/api/generation-recovery", methods=["GET"])
def get_generation_recovery():
    try:
        statuses = request.args.get("status") or ""
        status_list = [item.strip() for item in statuses.split(",") if item.strip()] or None
        return jsonify({"success": True, "records": recovery_list(status_list)})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


@app.route("/api/generation-recovery/confirm", methods=["POST"])
def confirm_generation_recovery():
    try:
        data = request.json or {}
        ids = data.get("recovery_ids") or data.get("ids") or data.get("recovery_id") or []
        if isinstance(ids, str):
            ids = [ids]
        if not isinstance(ids, list) or not ids:
            return jsonify({"success": False, "error": "缺少 recovery_id"}), 400

        eagle_ids = data.get("eagle_ids") or []
        if isinstance(eagle_ids, str):
            eagle_ids = [eagle_ids]
        eagle_data = data.get("eagle_data") or {}
        updated = []
        for record_id in ids:
            record = recovery_mark_eagle_imported(record_id, eagle_ids=eagle_ids, eagle_data=eagle_data)
            if record:
                updated.append(record)
        return jsonify({"success": True, "updated": len(updated), "records": updated})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


@app.route("/api/generation-recovery/patrol", methods=["POST"])
def run_generation_recovery_patrol():
    try:
        return jsonify({"success": True, "summary": recovery_patrol_once()})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


@app.route("/api/generation-recovery/cleanup-remote", methods=["POST"])
def cleanup_generation_recovery_remote():
    try:
        return jsonify(recovery_cleanup_remote_if_needed(force=True))
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


@app.route("/api/generate-video", methods=["POST"])
def generate_video():
    """生成视频 (调用 AllAPI/Sora)"""
    try:
        data = request.json
        prompt = data.get("prompt")
        model = data.get("model")
        duration = data.get("duration")  # 时长: 5s, 10s, 15s
        ratio = data.get("ratio")  # 比例: 16:9, 9:16, 1:1
        quality = data.get("quality")  # 清晰度: 720p, 1080p

        if not prompt:
            return jsonify({"success": False, "error": "缺少提示词"}), 400

        print(
            f"视频生成请求: prompt={prompt}, model={model}, duration={duration}, ratio={ratio}, quality={quality}"
        )

        # 调用视频生成 (传递所有参数给新方法)
        result = generator.generate_video(
            prompt=prompt, model=model, duration=duration, ratio=ratio, quality=quality
        )

        if result.get("success"):
            return jsonify(result)
        else:
            return jsonify(result), 500

    except Exception as e:
        error_detail = traceback.format_exc()
        print(f"视频生成失败: {error_detail}")
        return jsonify(
            {"success": False, "error": str(e), "detail": error_detail[:500]}
        ), 500

@app.route("/api/video/create", methods=["POST"])
def create_video_task():
    """创建视频生成任务（返回任务ID，前端轮询进度）"""
    try:
        data = request.json
        prompt = data.get("prompt")
        model = data.get("model")
        duration = data.get("duration")
        ratio = data.get("ratio")
        quality = data.get("quality")
        image_urls = data.get("image_urls", [])

        if not prompt:
            return jsonify({"success": False, "error": "缺少提示词"}), 400

        # 加载配置
        config = load_system_config()
        video_api_key = config.get("video_api_key")
        video_api_url = config.get("video_api_url", "https://allapi.store")

        if not video_api_key:
            return jsonify({"success": False, "error": "视频 API Key 未配置"}), 400

        target_model = model or config.get("video_model") or "sora-2-all"

        # 处理参考图：将本地路径转换为 Base64
        processed_images = []
        for img_url in image_urls:
            try:
                # 1. 本地路径 /api/images/xxx
                if img_url.startswith("/api/images/"):
                    filename = img_url.replace("/api/images/", "")
                    filepath = os.path.join(OUTPUT_FOLDER, filename)
                    if os.path.exists(filepath):
                        with open(filepath, "rb") as f:
                            img_base64 = base64.b64encode(f.read()).decode("utf-8")
                            processed_images.append(
                                f"data:image/jpeg;base64,{img_base64}"
                            )
                # 2. 已经是 Base64 或 http 链接
                else:
                    processed_images.append(img_url)
            except Exception as e:
                print(f"处理参考图失败: {e}")

        # 参数处理
        video_duration = 10
        if duration:
            video_duration = int(duration.replace("s", ""))

        aspect_ratio = ratio or "16:9"
        video_quality = quality or "720p"

        # 计算尺寸
        size_map = {
            "16:9": {"720p": "1280x720", "1080p": "1920x1080"},
            "9:16": {"720p": "720x1280", "1080p": "1080x1920"},
            "1:1": {"720p": "720x720", "1080p": "1080x1080"},
            "4:3": {"720p": "960x720", "1080p": "1440x1080"},
            "3:4": {"720p": "720x960", "1080p": "1080x1440"},
            "21:9": {"720p": "1680x720", "1080p": "2520x1080"},
        }
        video_size = size_map.get(aspect_ratio, {}).get(video_quality, "1280x720")

        # 构建 API URL
        base_url = video_api_url.rstrip("/")
        if base_url.endswith("/v1"):
            create_url = f"{base_url}/video/create"
        else:
            create_url = f"{base_url}/v1/video/create"

        headers = {
            "Authorization": f"Bearer {video_api_key}",
            "Content-Type": "application/json",
        }

        payload = {
            "model": target_model,
            "prompt": prompt,
            "duration": video_duration,
            "size": video_size,
        }

        # 添加参考图到 payload（如果有的话）
        # 根据模型类型决定参数名
        if processed_images:
            # veo3.1-fast-components 等支持图生视频的模型
            if "veo" in target_model.lower():
                # Veo 模型使用 images 参数，支持多图
                payload["images"] = processed_images[:3]  # 最多3张
                print(f"📷 Veo 模型: 添加 {len(payload['images'])} 张参考图")
            # runway-gen3 等其他模型
            elif "runway" in target_model.lower() or "kling" in target_model.lower():
                # 这些模型通常只支持单图
                payload["image"] = processed_images[0] if processed_images else None
                print(f"📷 {target_model}: 添加参考图")
            # Sora 模型也支持参考图
            elif "sora" in target_model.lower():
                # Sora 使用 image 参数
                payload["image"] = processed_images[0] if processed_images else None
                print(f"📷 Sora: 添加参考图")

        print(
            f"📦 请求参数: {json.dumps({k: v for k, v in payload.items() if k != 'images'}, ensure_ascii=False)}"
        )

        response = requests.post(create_url, headers=headers, json=payload, timeout=60)

        if response.status_code != 200:
            return jsonify(
                {"success": False, "error": f"API 错误: {response.text[:200]}"}
            ), 500

        result = response.json()
        task_id = result.get("id")

        if not task_id:
            return jsonify(
                {"success": False, "error": f"未获取到任务 ID: {result}"}
            ), 500

        return jsonify(
            {"success": True, "task_id": task_id, "status": "queued", "progress": 0}
        )

    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500

@app.route("/api/video/status/<task_id>", methods=["GET"])
def get_video_status(task_id):
    """查询视频生成任务状态"""
    try:
        config = load_system_config()
        video_api_key = config.get("video_api_key")
        video_api_url = config.get("video_api_url", "https://allapi.store")

        if not video_api_key:
            return jsonify({"success": False, "error": "视频 API Key 未配置"}), 400

        # 构建状态查询 URL
        base_url = video_api_url.rstrip("/")
        if base_url.endswith("/v1"):
            status_url = f"{base_url}/videos/{task_id}"
        else:
            status_url = f"{base_url}/v1/videos/{task_id}"

        headers = {
            "Authorization": f"Bearer {video_api_key}",
            "Content-Type": "application/json",
        }

        response = requests.get(status_url, headers=headers, timeout=30)

        if response.status_code != 200:
            return jsonify(
                {"success": False, "error": f"查询失败: {response.status_code}"}
            ), 500

        status_data = response.json()
        status = status_data.get("status", "")
        progress = status_data.get("progress", 0)

        result = {"success": True, "status": status, "progress": progress}

        # 如果完成，提取视频 URL 并下载
        if status in ["completed", "succeeded"]:
            video_url = (
                status_data.get("url")
                or status_data.get("video_url")
                or status_data.get("output")
                or status_data.get("data", {}).get("url")
            )

            if video_url:
                # 下载视频
                timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
                filename = f"video_{timestamp}.mp4"
                filepath = os.path.join(OUTPUT_FOLDER, filename)

                v_resp = requests.get(video_url, stream=True, timeout=120)
                if v_resp.status_code == 200:
                    with open(filepath, "wb") as f:
                        for chunk in v_resp.iter_content(chunk_size=8192):
                            f.write(chunk)

                    result["video_url"] = f"/api/images/{filename}"
                    result["filename"] = filename
                    result["remote_url"] = video_url
                else:
                    result["error"] = f"视频下载失败: {v_resp.status_code}"
            else:
                result["error"] = "未找到视频 URL"

        elif status in ["failed", "error"]:
            result["error"] = (
                status_data.get("error") or status_data.get("message") or "生成失败"
            )

        return jsonify(result)

    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


CHENYU_DIGITAL_HUMAN_WORKFLOW_KEYWORDS = [
    "数字人",
    "对口型",
    "口播",
    "唇形",
    "播客",
    "配音",
    "讲解",
    "换脸",
    "视频编辑",
    "wananimate",
    "vace",
    "s2v",
]


def _request_int_arg(name, default, *, minimum=1, maximum=100):
    raw = request.args.get(name, default)
    try:
        value = int(raw)
    except (TypeError, ValueError):
        value = default
    value = max(minimum, value)
    if maximum is not None:
        value = min(maximum, value)
    return value


def _get_chenyu_client():
    config = load_system_config() or {}
    api_key = str(config.get("chenyu_api_key") or "").strip() or None
    base_url = str(config.get("chenyu_api_base_url") or "").strip()
    if api_key or base_url:
        return ChenyuClient(api_key=api_key, base_url=base_url or CHENYU_API_BASE_URL)
    return ChenyuClient()


def _chenyu_error_response(exc, status_code=500):
    error = str(exc)
    if isinstance(exc, ChenyuApiError) and "CHENYU_API_KEY" in error:
        error = "CHENYU_API_KEY is not set. Set it in the backend environment before using Chenyu workflows."
        status_code = 400
    return jsonify({"success": False, "error": error}), status_code


@app.route("/api/chenyu/workflows", methods=["GET"])
def list_chenyu_workflows():
    """Proxy Chenyu workflow market list for Studio."""
    try:
        client = _get_chenyu_client()
        data = client.workflow_market_list(
            keyword=request.args.get("keyword") or None,
            tag=request.args.get("tag") or None,
            sort=request.args.get("sort") or "latest",
            page=_request_int_arg("page", 1, maximum=None),
            page_size=_request_int_arg("page_size", 20, maximum=100),
        )
        return jsonify({"success": True, "data": data})
    except Exception as exc:
        return _chenyu_error_response(exc)


@app.route("/api/chenyu/workflows/recommendations", methods=["GET"])
def recommend_chenyu_workflows():
    """Search Chenyu market for digital-human and lip-sync workflow candidates."""
    try:
        raw_keywords = request.args.get("keywords") or ""
        if raw_keywords.strip():
            keywords = [item.strip() for item in re.split(r"[,，\s]+", raw_keywords) if item.strip()]
        else:
            keywords = CHENYU_DIGITAL_HUMAN_WORKFLOW_KEYWORDS

        client = _get_chenyu_client()
        page_size = _request_int_arg("page_size", 30, maximum=100)
        seen = {}
        for keyword in keywords:
            data = client.workflow_market_list(keyword=keyword, page=1, page_size=page_size)
            for item in data.get("items", []) or []:
                key = item.get("workflow_id") or f"{item.get('title')}:{item.get('revision_id')}"
                if key not in seen:
                    normalized = dict(item)
                    normalized["matched_keywords"] = [keyword]
                    seen[key] = normalized
                else:
                    seen[key].setdefault("matched_keywords", []).append(keyword)

        items = list(seen.values())
        items.sort(key=lambda item: item.get("updated_at") or "", reverse=True)
        return jsonify({
            "success": True,
            "data": {
                "keywords": keywords,
                "items": items,
                "total": len(items),
            },
        })
    except Exception as exc:
        return _chenyu_error_response(exc)


@app.route("/api/chenyu/workflows/<workflow_id>", methods=["GET"])
def get_chenyu_workflow(workflow_id):
    """Return manifest details for one Chenyu workflow before submission."""
    try:
        client = _get_chenyu_client()
        data = client.workflow_market_info(workflow_id)
        return jsonify({"success": True, "data": data})
    except Exception as exc:
        return _chenyu_error_response(exc)


@app.route("/api/chenyu/workflows/run", methods=["POST"])
def submit_chenyu_workflow_run():
    """Submit a Chenyu workflow run. Inputs must match editable_parameter_manifest."""
    try:
        data = request.json or {}
        workflow_id = str(data.get("workflow_id") or "").strip()
        if not workflow_id:
            return jsonify({"success": False, "error": "workflow_id is required"}), 400

        inputs = data.get("inputs") or {}
        if not isinstance(inputs, dict):
            return jsonify({"success": False, "error": "inputs must be an object"}), 400

        client = _get_chenyu_client()
        result = client.workflow_run_submit(
            workflow_id,
            revision_id=data.get("revision_id") or None,
            inputs=inputs,
            idempotency_key=data.get("idempotency_key") or None,
            accept_external_cost_risk=bool(data.get("accept_external_cost_risk", True)),
            contains_real_person_material=data.get("contains_real_person_material"),
        )
        return jsonify({"success": True, "data": result})
    except Exception as exc:
        return _chenyu_error_response(exc)


@app.route("/api/chenyu/workflow-runs", methods=["GET"])
def list_chenyu_workflow_runs():
    """List Chenyu workflow run records."""
    try:
        client = _get_chenyu_client()
        data = client.workflow_run_list(
            workflow_id=request.args.get("workflow_id") or None,
            status=request.args.get("status") or None,
            page=_request_int_arg("page", 1, maximum=None),
            page_size=_request_int_arg("page_size", 20, maximum=100),
        )
        return jsonify({"success": True, "data": data})
    except Exception as exc:
        return _chenyu_error_response(exc)


@app.route("/api/chenyu/workflow-runs/<run_order_id>", methods=["GET"])
def get_chenyu_workflow_run(run_order_id):
    """Return Chenyu workflow run billing/input/output details."""
    try:
        client = _get_chenyu_client()
        data = client.workflow_run_info(run_order_id)
        return jsonify({"success": True, "data": data})
    except Exception as exc:
        return _chenyu_error_response(exc)


@app.route("/api/chenyu/workflow-runs/<run_order_id>/execution", methods=["GET"])
def get_chenyu_workflow_execution(run_order_id):
    """Return Chenyu workflow execution progress and outputs."""
    try:
        client = _get_chenyu_client()
        data = client.workflow_run_execution(run_order_id)
        return jsonify({"success": True, "data": data})
    except Exception as exc:
        return _chenyu_error_response(exc)


@app.route("/api/outputs/<filename>")
def get_output(filename):
    """获取生成的图片"""
    return send_from_directory(OUTPUT_FOLDER, filename)

@app.route("/api/images/<filename>")
def get_image(filename):
    """获取图片/视频文件（新接口，优化版）"""
    filepath = os.path.join(OUTPUT_FOLDER, filename)
    if not os.path.exists(filepath):
        return jsonify({"error": "文件不存在"}), 404

    # 根据文件扩展名设置正确的 MIME 类型
    filename_lower = filename.lower()
    if filename_lower.endswith(".mp4"):
        mimetype = "video/mp4"
    elif filename_lower.endswith(".webm"):
        mimetype = "video/webm"
    elif filename_lower.endswith(".png"):
        mimetype = "image/png"
    elif filename_lower.endswith(".jpg") or filename_lower.endswith(".jpeg"):
        mimetype = "image/jpeg"
    else:
        mimetype = None  # 让 send_file 自动检测

    return send_file(filepath, mimetype=mimetype)

@app.route("/api/health")
def health():
    """健康检查"""
    return jsonify({
        "status": "ok",
        "message": "服务运行中",
        "machine_id": _machine_id,
    })

# 智能体预设配置文件
AGENT_PRESETS_FILE = os.path.join(os.path.dirname(__file__), "agent_presets.json")
PROMPT_TEMPLATES_FILE = os.path.join(os.path.dirname(__file__), "prompt_templates.json")

@app.route("/api/agent-presets", methods=["GET"])
def get_agent_presets():
    """获取智能体预设"""
    try:
        if os.path.exists(AGENT_PRESETS_FILE):
            with open(AGENT_PRESETS_FILE, "r", encoding="utf-8") as f:
                presets = json.load(f)
            return jsonify({"success": True, "presets": presets})
        return jsonify({"success": True, "presets": {}})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500

@app.route("/api/agent-presets", methods=["POST"])
def save_agent_presets():
    """保存智能体预设"""
    try:
        data = request.json
        presets = data.get("presets", {})

        with open(AGENT_PRESETS_FILE, "w", encoding="utf-8") as f:
            json.dump(presets, f, ensure_ascii=False, indent=2)

        return jsonify({"success": True, "message": "预设已保存"})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500

@app.route("/api/prompt-templates", methods=["GET"])
def get_prompt_templates():
    """获取所有提示词模板和分组"""
    try:
        if os.path.exists(PROMPT_TEMPLATES_FILE):
            with open(PROMPT_TEMPLATES_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
            return jsonify({"success": True, "groups": data.get("groups", []), "templates": data.get("templates", [])})
        return jsonify({"success": True, "groups": [], "templates": []})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500

@app.route("/api/prompt-templates", methods=["POST"])
def save_prompt_templates():
    """保存提示词模板（完整覆盖）"""
    try:
        data = request.json
        save_data = {
            "groups": data.get("groups", []),
            "templates": data.get("templates", [])
        }
        with open(PROMPT_TEMPLATES_FILE, "w", encoding="utf-8") as f:
            json.dump(save_data, f, ensure_ascii=False, indent=2)
        return jsonify({"success": True, "message": "模板已保存"})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500

@app.route("/api/prompt-templates/template", methods=["POST"])
def upsert_prompt_template():
    """新增或更新单个模板"""
    try:
        template = request.json
        if not template.get("id"):
            template["id"] = f"tpl_{int(datetime.now().timestamp() * 1000)}"
        if not template.get("createdAt"):
            template["createdAt"] = datetime.now().strftime("%Y-%m-%dT%H:%M:%S.000Z")

        data = {"groups": [], "templates": []}
        if os.path.exists(PROMPT_TEMPLATES_FILE):
            with open(PROMPT_TEMPLATES_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)

        templates = data.get("templates", [])
        idx = next((i for i, t in enumerate(templates) if t["id"] == template["id"]), None)
        if idx is not None:
            templates[idx] = template
        else:
            templates.append(template)
        data["templates"] = templates

        with open(PROMPT_TEMPLATES_FILE, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        return jsonify({"success": True, "template": template})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500

@app.route("/api/prompt-templates/template/<template_id>", methods=["DELETE"])
def delete_prompt_template(template_id):
    """删除单个模板"""
    try:
        data = {"groups": [], "templates": []}
        if os.path.exists(PROMPT_TEMPLATES_FILE):
            with open(PROMPT_TEMPLATES_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)

        data["templates"] = [t for t in data.get("templates", []) if t["id"] != template_id]

        with open(PROMPT_TEMPLATES_FILE, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        return jsonify({"success": True})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500

@app.route("/api/prompt-templates/group", methods=["POST"])
def upsert_prompt_group():
    """新增或更新分组"""
    try:
        group = request.json
        if not group.get("id"):
            group["id"] = f"grp_{int(datetime.now().timestamp() * 1000)}"

        data = {"groups": [], "templates": []}
        if os.path.exists(PROMPT_TEMPLATES_FILE):
            with open(PROMPT_TEMPLATES_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)

        groups = data.get("groups", [])
        idx = next((i for i, g in enumerate(groups) if g["id"] == group["id"]), None)
        if idx is not None:
            groups[idx] = group
        else:
            group["order"] = len(groups)
            groups.append(group)
        data["groups"] = groups

        with open(PROMPT_TEMPLATES_FILE, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        return jsonify({"success": True, "group": group})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500

@app.route("/api/prompt-templates/group/<group_id>", methods=["DELETE"])
def delete_prompt_group(group_id):
    """删除分组（同时删除该分组下的所有模板）"""
    try:
        data = {"groups": [], "templates": []}
        if os.path.exists(PROMPT_TEMPLATES_FILE):
            with open(PROMPT_TEMPLATES_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)

        data["groups"] = [g for g in data.get("groups", []) if g["id"] != group_id]
        data["templates"] = [t for t in data.get("templates", []) if t.get("groupId") != group_id]

        with open(PROMPT_TEMPLATES_FILE, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        return jsonify({"success": True})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500

def map_public_provider(p):
    return {
        "id": p.get("id"),
        "name": p.get("name"),
        "type": p.get("type"),
        "hasKey": bool(p.get("api_key")),
        "api_url": p.get("api_url", p.get("apiUrl", "")),
        "model": p.get("model", ""),
        "models": p.get("models", [])
    }


@app.route("/api/image-providers", methods=["GET"])
def get_image_providers():
    """获取图片插件需要的 provider 列表，不返回 chat/video/密钥"""
    config = load_system_config()
    if config:
        providers = [
            map_public_provider(p)
            for p in config.get("providers", [])
            if p.get("type") == "image"
        ]
        return jsonify({
            "success": True,
            "providers": providers,
            "active_image_provider_id": config.get("active_image_provider_id"),
            "config": {
                "providers": providers,
                "active_image_provider_id": config.get("active_image_provider_id"),
            },
        })
    return jsonify({
        "success": True,
        "providers": [],
        "active_image_provider_id": "",
        "config": {"providers": [], "active_image_provider_id": ""},
    })


@app.route("/api/system-config", methods=["GET"])
def get_system_config():
    """获取系统配置"""
    config = load_system_config()
    if config:
        def map_provider(p):
            return {
                "id": p.get("id"),
                "name": p.get("name"),
                "type": p.get("type"),
                "hasKey": bool(p.get("api_key")),
                "api_key": p.get("api_key", ""),
                "api_url": p.get("api_url", p.get("apiUrl", "")),
                "model": p.get("model", ""),
                "models": p.get("models", [])
            }

        safe_providers = [map_provider(p) for p in config.get("providers", [])]

        # Task 27：透传生图历史相关的机器身份字段，让 SystemSettings UI 可编辑
        # 注意不对默认值做过度兜底，让 UI 看到真实的 system_config.json 内容；
        # 真正生效的兜底逻辑在 _init_history_subsystem 里（machine_id 主机名兜底等）。
        safe_config = {
            "providers": safe_providers,
            "active_image_provider_id": config.get("active_image_provider_id"),
            "active_chat_provider_id": config.get("active_chat_provider_id"),
            "active_video_provider_id": config.get("active_video_provider_id"),

            # backward compatibility for generic settings
            "hasGeminiKey": bool(config.get("gemini_api_key")),
            "hasChatKey": bool(config.get("chat_api_key")),
            "hasVideoKey": bool(config.get("video_api_key")),
            "hasChenyuKey": bool(config.get("chenyu_api_key") or os.environ.get("CHENYU_API_KEY")),
            "chenyu_api_key": config.get("chenyu_api_key", ""),
            "chenyu_api_base_url": config.get("chenyu_api_base_url", CHENYU_API_BASE_URL),
            "proxyUrl": config.get("proxy_url", ""),
            "outputDir": config.get("output_dir", ""),

            # 生图历史子系统配置（Task 27 / Requirement C4 Open Q4）
            "machine_id": config.get("machine_id", ""),
            "peer_machines": config.get("peer_machines", []) or [],
            "history_store_path": config.get("history_store_path", ""),
            "history_store_max_mb": config.get("history_store_max_mb", 50),
            "history_recorder_enabled": bool(
                config.get("history_recorder_enabled", True)
            ),
        }
        return jsonify({"success": True, "config": safe_config, "configured": True})
    return jsonify({"success": True, "config": None, "configured": False})

@app.route("/api/system-config", methods=["POST"])
def update_system_config():
    """更新系统配置"""
    try:
        data = request.json

        # 这里不使用 load_system_config 避免合并逻辑导致的混乱，直接读取裸文件
        existing_config = copy.deepcopy(DEFAULT_CONFIG)
        if os.path.exists(CONFIG_FILE):
            try:
                # 同 load_system_config：用 utf-8-sig 容忍 BOM，否则一旦解析失败会把
                # existing_config 重置为 DEFAULT_CONFIG，下一次 POST 写回时整张 providers 列表都会丢
                with open(CONFIG_FILE, "r", encoding="utf-8-sig") as f:
                    saved_config = json.load(f)
                    existing_config.update(saved_config)
            except Exception as e:
                print(f"[update_system_config] 读取现有配置失败，可能导致 providers 丢失: {e}")

        # 确保格式正确
        if "providers" not in existing_config or (len(existing_config["providers"]) > 0 and "type" not in existing_config["providers"][0]):
            existing_config = upgrade_config(existing_config)

        if "providers" in data:
            # 兼容前端遗留的 apiUrl 字段，确保保存为 api_url
            for p in data["providers"]:
                if "apiUrl" in p:
                    if not p.get("api_url"):
                        p["api_url"] = p["apiUrl"]
                    del p["apiUrl"]
            # 前端现在拥有完整状态，直接覆盖即可
            existing_config["providers"] = normalize_providers(data["providers"])

        if "active_image_provider_id" in data:
            existing_config["active_image_provider_id"] = data["active_image_provider_id"]
        if "active_chat_provider_id" in data:
            existing_config["active_chat_provider_id"] = data["active_chat_provider_id"]
        if "active_video_provider_id" in data:
            existing_config["active_video_provider_id"] = data["active_video_provider_id"]

        # 更新通用设置 (对所有 provider 生效)
        if "proxy_url" in data:
            existing_config["proxy_url"] = data["proxy_url"]
        if "output_dir" in data:
            existing_config["output_dir"] = data["output_dir"]
        if "chenyu_api_key" in data:
            existing_config["chenyu_api_key"] = str(data.get("chenyu_api_key") or "").strip()
        if "chenyu_api_base_url" in data:
            existing_config["chenyu_api_base_url"] = (
                str(data.get("chenyu_api_base_url") or CHENYU_API_BASE_URL).strip()
                or CHENYU_API_BASE_URL
            )

        # Task 27 / Requirement C4 Open Q4：生图历史相关的机器身份字段
        # 允许前端 SystemSettings 的"机器身份" Section 写入。
        # 只做类型收敛，不做协议校验（协议校验在 _init_history_subsystem 里按 Req 22.3 执行，
        # 这样 UI 可以暂存坏值但不影响后端启动）。
        if "machine_id" in data:
            raw_mid = data.get("machine_id")
            existing_config["machine_id"] = (
                str(raw_mid).strip() if isinstance(raw_mid, str) else ""
            )
        if "peer_machines" in data:
            raw_peers = data.get("peer_machines") or []
            cleaned_peers: list[dict] = []
            if isinstance(raw_peers, list):
                for entry in raw_peers:
                    if not isinstance(entry, dict):
                        continue
                    peer_id = str(entry.get("machine_id") or "").strip()
                    base_url = str(entry.get("base_url") or "").strip()
                    if not peer_id and not base_url:
                        continue  # 空行直接丢弃
                    cleaned_peers.append(
                        {"machine_id": peer_id, "base_url": base_url}
                    )
            existing_config["peer_machines"] = cleaned_peers
        if "history_store_max_mb" in data:
            raw_max_mb = data.get("history_store_max_mb")
            try:
                max_mb = int(raw_max_mb)
            except (TypeError, ValueError):
                max_mb = 50
            if max_mb <= 0:
                max_mb = 50
            existing_config["history_store_max_mb"] = max_mb
        if "history_recorder_enabled" in data:
            existing_config["history_recorder_enabled"] = bool(
                data.get("history_recorder_enabled")
            )

        # 保存配置
        if save_system_config(existing_config):
            # 获取合并后的最新配置用于初始化
            current_config = load_system_config()

            # 立即应用新配置（强制重新初始化生成器）
            print("配置已更新，正在重新初始化生成器...")
            generator.initialize(
                api_key=current_config.get("gemini_api_key"),
                api_url=current_config.get("gemini_api_url"),
                proxy_url=current_config.get("proxy_url"),
                output_dir=current_config.get("output_dir"),
                model=current_config.get("gemini_model"),
                video_api_key=current_config.get("video_api_key"),
                video_api_url=current_config.get("video_api_url"),
                video_model=current_config.get("video_model"),
            )
            return jsonify({"success": True, "message": "配置已保存并立即生效"})
        else:
            return jsonify({"success": False, "error": "保存配置失败"}), 500

    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


@app.route("/api/auto-init", methods=["POST"])
def auto_init():
    """使用保存的配置自动初始化"""
    try:
        config = load_system_config()
        if not config or not config.get("gemini_api_key"):
            return jsonify(
                {"success": False, "error": "未找到已保存的配置", "needSetup": True}
            )

        # 使用保存的配置初始化（包括 API URL 和模型）
        success = generator.initialize(
            api_key=config.get("gemini_api_key"),
            api_url=config.get("gemini_api_url"),
            proxy_url=config.get("proxy_url"),
            output_dir=config.get("output_dir"),
            model=config.get("gemini_model"),
            video_api_key=config.get("video_api_key"),
            video_api_url=config.get("video_api_url"),
            video_model=config.get("video_model"),
        )

        if success:
            return jsonify(
                {
                    "success": True,
                    "message": "自动初始化成功",
                    "output_folder": generator.output_folder,
                }
            )
        else:
            error_msg = generator.last_error or "初始化失败"
            return jsonify({"success": False, "error": error_msg, "needSetup": True})

    except Exception as e:
        return jsonify({"success": False, "error": str(e), "needSetup": True})


@app.route("/api/upload-image", methods=["POST"])
def upload_image():
    """上传图片并返回路径（v2新功能 - 支持去重及无损）"""
    import hashlib

    try:
        if "file" not in request.files:
            return jsonify({"success": False, "error": "没有上传文件"}), 400

        file = request.files["file"]
        if file.filename == "":
            return jsonify({"success": False, "error": "文件名为空"}), 400

        is_lossless = request.form.get("is_lossless", "false").lower() == "true"

        # 读取上传的文件
        image_data = file.read()

        # 计算图片内容的 MD5 哈希值
        content_hash = hashlib.md5(image_data).hexdigest()[:12]  # 取前12位

        if is_lossless:
            # 局部截图/无损模式，直接保留原图，不进行压缩
            compressed_data = image_data
            compressed_hash = content_hash
            prefix = "detail"
            ext = ".png" # 假设前端传来的 blob 通常是 png 格式
        else:
            # 常规模式：压缩图片
            compressed_data = generator.compress_image(image_data, quality=95)
            # 计算压缩后的哈希（用于最终文件名）
            compressed_hash = hashlib.md5(compressed_data).hexdigest()[:12]
            prefix = "imported"
            ext = ".jpg"

        # 检查是否已存在相同哈希的文件
        existing_files = [f for f in os.listdir(OUTPUT_FOLDER) if compressed_hash in f]

        if existing_files:
            # 已存在相同内容的图片，直接返回
            existing_filename = existing_files[0]
            print(f"[去重] 图片已存在: {existing_filename}")
            return jsonify(
                {
                    "success": True,
                    "filename": existing_filename,
                    "url": f"/api/images/{existing_filename}",
                    "deduplicated": True,
                }
            )

        # 生成文件名（包含哈希值以便去重检测）
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        filename = f"{prefix}_{timestamp}_{compressed_hash}{ext}"
        filepath = os.path.join(OUTPUT_FOLDER, filename)

        # 保存图片
        with open(filepath, "wb") as f:
            f.write(compressed_data)

        print(f"[上传] 新图片已保存: {filename}")

        return jsonify(
            {
                "success": True,
                "filename": filename,
                "url": f"/api/images/{filename}",
                "deduplicated": False,
            }
        )

    except Exception as e:
        error_detail = traceback.format_exc()
        print(f"上传失败: {error_detail}")
        return jsonify(
            {"success": False, "error": str(e), "detail": error_detail[:500]}
        ), 500


@app.route("/api/chat", methods=["POST"])
def chat_with_ai():
    """AI 对话接口"""
    try:
        data = request.json
        prompt = data.get("prompt", "")
        system_prompt = data.get("system_prompt", "")
        reference_images = data.get("reference_images", [])

        if not prompt:
            return jsonify({"success": False, "error": "缺少提示词"}), 400

        # 加载配置
        config = load_system_config()
        if not config or not config.get("chat_api_key"):
            return jsonify(
                {
                    "success": False,
                    "error": "对话模型未配置，请在系统设置中配置 API Key",
                }
            ), 400

        chat_api_key = config.get("chat_api_key")
        chat_api_url = config.get("chat_api_url", "https://api.openai.com/v1")
        chat_model = config.get("chat_model", "gpt-4o")

        # 构建消息
        messages = []
        if system_prompt:
            messages.append({"role": "system", "content": system_prompt})

        # 构建用户消息（支持图片）
        user_content = []
        user_content.append({"type": "text", "text": prompt})

        # 添加参考图片
        for img_data in reference_images:
            try:
                if img_data.startswith("/api/images/"):
                    # 从本地文件读取
                    filename = img_data.replace("/api/images/", "")
                    filepath = os.path.join(OUTPUT_FOLDER, filename)
                    if os.path.exists(filepath):
                        with open(filepath, "rb") as f:
                            img_bytes = f.read()
                            img_base64 = base64.b64encode(img_bytes).decode("utf-8")
                            user_content.append(
                                {
                                    "type": "image_url",
                                    "image_url": {
                                        "url": f"data:image/jpeg;base64,{img_base64}"
                                    },
                                }
                            )
                elif img_data.startswith("data:image"):
                    user_content.append(
                        {"type": "image_url", "image_url": {"url": img_data}}
                    )
            except Exception as e:
                print(f"处理参考图失败: {str(e)}")

        messages.append({"role": "user", "content": user_content})

        # 调用 API
        import requests

        headers = {
            "Authorization": f"Bearer {chat_api_key}",
            "Content-Type": "application/json",
        }

        # 对话模型不使用代理（通常连接本地中转服务，不需要翻墙）
        proxies = None

        # 构建 API URL - 自动处理 /v1 路径
        api_url = chat_api_url.rstrip("/")
        if not api_url.endswith("/v1"):
            api_url = f"{api_url}/v1"

        response = requests.post(
            f"{api_url}/chat/completions",
            headers=headers,
            json={"model": chat_model, "messages": messages, "max_tokens": 2000},
            proxies=proxies,
            timeout=60,
        )

        if response.status_code == 200:
            result = response.json()
            ai_response = result["choices"][0]["message"]["content"]
            return jsonify({"success": True, "response": ai_response})
        else:
            error_msg = response.json().get("error", {}).get("message", "API 调用失败")
            return jsonify({"success": False, "error": error_msg}), 500

    except Exception as e:
        error_detail = traceback.format_exc()
        print(f"对话失败: {error_detail}")
        return jsonify(
            {"success": False, "error": str(e), "detail": error_detail[:500]}
        ), 500


@app.route("/api/export", methods=["POST"])
def export_project():
    """导出项目为 ZIP 文件"""
    try:
        data = request.json
        project_name = data.get("project_name", "未命名项目")
        nodes = data.get("nodes", [])
        edges = data.get("edges", [])

        # 创建临时目录
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        temp_dir = os.path.join(OUTPUT_FOLDER, f"temp_export_{timestamp}")
        os.makedirs(temp_dir, exist_ok=True)

        # 创建项目子目录
        project_dir = os.path.join(temp_dir, project_name)
        images_dir = os.path.join(project_dir, "images")
        os.makedirs(images_dir, exist_ok=True)

        # 处理节点中的图片
        processed_nodes = []
        for node in nodes:
            node_copy = node.copy()

            # 如果节点有图片数据
            if node.get("data", {}).get("imageUrl"):
                image_url = node["data"]["imageUrl"]

                # 如果是 base64 数据
                if image_url.startswith("data:image"):
                    # 提取 base64 数据
                    img_data = (
                        image_url.split(",")[1] if "," in image_url else image_url
                    )
                    img_bytes = base64.b64decode(img_data)

                    # 生成文件名
                    node_id = node.get("id", "unknown")
                    filename = f"{node_id}.png"
                    filepath = os.path.join(images_dir, filename)

                    # 保存图片
                    with open(filepath, "wb") as f:
                        f.write(img_bytes)

                    # 更新节点数据，使用相对路径
                    node_copy["data"]["imageUrl"] = f"images/{filename}"
                    node_copy["data"]["originalFilename"] = node["data"].get(
                        "filename", filename
                    )

            processed_nodes.append(node_copy)

        # 创建项目 JSON 文件
        project_data = {
            "name": project_name,
            "version": "1.0",
            "exportedAt": datetime.now().isoformat(),
            "nodes": processed_nodes,
            "edges": edges,
        }

        project_file = os.path.join(project_dir, "project.json")
        with open(project_file, "w", encoding="utf-8") as f:
            json.dump(project_data, f, ensure_ascii=False, indent=2)

        # 创建 ZIP 文件
        zip_filename = f"{project_name}_{timestamp}.zip"
        zip_path = os.path.join(OUTPUT_FOLDER, zip_filename)

        with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zipf:
            for root, dirs, files in os.walk(project_dir):
                for file in files:
                    file_path = os.path.join(root, file)
                    arcname = os.path.relpath(file_path, temp_dir)
                    zipf.write(file_path, arcname)

        # 清理临时目录
        shutil.rmtree(temp_dir)

        return jsonify(
            {
                "success": True,
                "filename": zip_filename,
                "download_url": f"/api/download/{zip_filename}",
            }
        )

    except Exception as e:
        error_detail = traceback.format_exc()
        print(f"导出失败: {error_detail}")
        return jsonify(
            {"success": False, "error": str(e), "detail": error_detail[:500]}
        ), 500


@app.route("/api/download/<filename>")
def download_file(filename):
    """下载导出的文件"""
    try:
        file_path = os.path.join(OUTPUT_FOLDER, filename)
        if not os.path.exists(file_path):
            return jsonify({"error": "文件不存在"}), 404

        return send_file(
            file_path,
            as_attachment=True,
            download_name=filename,
            mimetype="application/zip",
        )
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/import", methods=["POST"])
def import_project():
    """导入项目 ZIP 文件"""
    try:
        if "file" not in request.files:
            return jsonify({"success": False, "error": "没有上传文件"}), 400

        file = request.files["file"]
        if file.filename == "":
            return jsonify({"success": False, "error": "文件名为空"}), 400

        # 保存上传的文件
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        temp_zip = os.path.join(OUTPUT_FOLDER, f"temp_import_{timestamp}.zip")
        file.save(temp_zip)

        # 解压文件
        temp_extract_dir = os.path.join(OUTPUT_FOLDER, f"temp_extract_{timestamp}")
        os.makedirs(temp_extract_dir, exist_ok=True)

        with zipfile.ZipFile(temp_zip, "r") as zipf:
            zipf.extractall(temp_extract_dir)

        # 查找 project.json 文件
        project_json_path = None
        for root, dirs, files in os.walk(temp_extract_dir):
            if "project.json" in files:
                project_json_path = os.path.join(root, "project.json")
                break

        if not project_json_path:
            return jsonify({"success": False, "error": "未找到 project.json 文件"}), 400

        # 读取项目数据
        with open(project_json_path, "r", encoding="utf-8") as f:
            project_data = json.load(f)

        # 处理图片，转换为 base64
        project_dir = os.path.dirname(project_json_path)
        processed_nodes = []

        for node in project_data.get("nodes", []):
            node_copy = node.copy()

            # 如果节点有图片路径
            if node.get("data", {}).get("imageUrl"):
                image_path = node["data"]["imageUrl"]

                # 如果是相对路径
                if not image_path.startswith("data:image"):
                    full_path = os.path.join(project_dir, image_path)

                    if os.path.exists(full_path):
                        # 读取图片并转换为 base64
                        with open(full_path, "rb") as img_file:
                            img_data = img_file.read()
                            img_base64 = base64.b64encode(img_data).decode("utf-8")
                            node_copy["data"]["imageUrl"] = (
                                f"data:image/png;base64,{img_base64}"
                            )

            processed_nodes.append(node_copy)

        # 清理临时文件
        os.remove(temp_zip)
        shutil.rmtree(temp_extract_dir)

        return jsonify(
            {
                "success": True,
                "project": {
                    "name": project_data.get("name", "导入的项目"),
                    "nodes": processed_nodes,
                    "edges": project_data.get("edges", []),
                },
            }
        )

    except Exception as e:
        error_detail = traceback.format_exc()
        print(f"导入失败: {error_detail}")
        return jsonify(
            {"success": False, "error": str(e), "detail": error_detail[:500]}
        ), 500


if __name__ == "__main__":

    def find_free_port(start_port=5688, max_attempts=100):
        """查找可用端口"""
        for port in range(start_port, start_port + max_attempts):
            try:
                with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
                    s.bind(("", port))
                    return port
            except OSError:
                continue
        return start_port

    def get_local_ip():
        candidates = []
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
                s.connect(("10.255.255.255", 1))
                addr = s.getsockname()[0]
                if addr and not addr.startswith("127."):
                    candidates.append(addr)
        except OSError:
            pass
        try:
            for addr in socket.gethostbyname_ex(socket.gethostname())[2]:
                if addr and not addr.startswith("127.") and addr not in candidates:
                    candidates.append(addr)
        except OSError:
            pass
        for addr in candidates:
            if addr.startswith("192.168.") or addr.startswith("10."):
                return addr
            if addr.startswith("172."):
                parts = addr.split(".")
                if len(parts) > 1:
                    try:
                        second = int(parts[1])
                    except ValueError:
                        second = -1
                    if 16 <= second <= 31:
                        return addr
        if candidates:
            return candidates[0]
        return "127.0.0.1"

    FRONTEND_DIR = os.path.join(os.path.dirname(__file__), "..", "frontend", "dist")

    print("=" * 50)
    print("图片工作流工作室")
    print("=" * 50)

    # 自动检测可用端口
    port = find_free_port()

    # 获取实际访问地址
    actual_host = "0.0.0.0"
    local_ip = get_local_ip()
    url = f"http://localhost:{port}"
    lan_url = f"http://{local_ip}:{port}"

    print(f"输出目录: {OUTPUT_FOLDER}")
    print(f"前端目录: {FRONTEND_DIR}")
    print(f"本机访问: {url}")
    print(f"局域网访问: {lan_url}")
    print("=" * 50)
    print("按 Ctrl+C 停止服务")
    if IDLE_SHUTDOWN_SECONDS > 0:
        print(f"空闲自动退出: {IDLE_SHUTDOWN_SECONDS} 秒")
    print("=" * 50)

    start_idle_shutdown_watcher()
    start_recovery_patrol()
    app.run(host=actual_host, port=port, debug=False)
