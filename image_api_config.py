"""
图片生成 API 统一配置与调用模块
支持: SuXi.ai / 77code / laozhang.ai / APIYI / Google AI Studio

用法:
    from image_api_config import generate_image, PROVIDERS

    # SuXi.ai ($0.15/张, 支持4K+多比例, 已验证可用)
    img = generate_image("suxi", "a red car", image_size="2K", aspect_ratio="16:9")
    img = generate_image("suxi", "a red car", image_size="4K", aspect_ratio="1:1")

    # 77code (5分/张, ~1376x768, 不支持分辨率控制)
    img = generate_image("77code", "a red car on the street")

    # 图生图 (77code)
    img = generate_image("77code", "change car to blue", ref_images=["path/to/car.jpg"])
"""
import requests
import base64
import time
import os
import json
from io import BytesIO
from PIL import Image

# ============================================================
# 服务商配置
# ============================================================
PROVIDERS = {
    "suxi": {
        "name": "SuXi.ai",
        "protocol": "gemini",  # Gemini 原生协议, 支持 imageConfig
        "base_url": "https://new.suxi.ai",
        "api_key": "",
        "model": "gemini-3.1-flash-image-preview",
        "price": "~$0.15/张(不限分辨率)",
        "max_resolution": "4K",
        "supports_image_config": True,
        "note": "已验证4K(4096x4096)和2K(2048x2048)可用, 支持多比例: 1:1/4:3/3:2/16:9/9:16/21:9/4:5/3:4/2:3等",
    },
    "77code": {
        "name": "77code",
        "protocol": "openai",  # OpenAI 兼容协议
        "base_url": "https://code.77code.fun",
        "api_key": "",
        "model": "gemini-3.1-flash-image",
        "price": "~0.05 RMB/张",
        "max_resolution": "~1376x768",
        "supports_image_config": False,
        "note": "最便宜, 不支持分辨率控制, 适合批量低分辨率任务",
    },
    "laozhang": {
        "name": "laozhang.ai",
        "protocol": "gemini",  # Gemini 原生协议
        "base_url": "https://api.laozhang.ai",
        "api_key": "",  # TODO: 注册后填入
        "model": "gemini-3.1-flash-image-preview",
        "price": "$0.02/张(2K) $0.03/张(4K)",
        "max_resolution": "4K",
        "supports_image_config": True,
        "note": "性价比最高, 支持 imageConfig 控制分辨率和宽高比",
    },
    "apiyi": {
        "name": "APIYI",
        "protocol": "gemini",  # Gemini 原生协议
        "base_url": "https://api.apiyi.com",
        "api_key": "",  # TODO: 注册后填入
        "model": "gemini-3.1-flash-image-preview",
        "price": "$0.045/张",
        "max_resolution": "4K",
        "supports_image_config": True,
        "note": "备选, 支持 imageConfig",
    },
    "google": {
        "name": "Google AI Studio",
        "protocol": "gemini",
        "base_url": "https://generativelanguage.googleapis.com",
        "api_key": "",
        "model": "gemini-3.1-flash-image-preview",
        "price": "需绑billing, $0.067(1K)-$0.151(4K)",
        "max_resolution": "4K",
        "supports_image_config": True,
        "auth_mode": "query_param",  # Google 用 ?key= 而不是 Bearer
        "note": "需绑 Cloud Billing, 当前 key 图片额度为 0",
    },
}


# ============================================================
# 核心调用函数
# ============================================================
def _load_local_keys():
    keys_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "image_api_keys.local.json")
    if not os.path.exists(keys_path):
        return {}
    try:
        with open(keys_path, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except Exception as e:
        print(f"[warn] failed to read image_api_keys.local.json: {e}")
        return {}


_LOCAL_KEYS = _load_local_keys()
for _pid, _cfg in PROVIDERS.items():
    if _LOCAL_KEYS.get(_pid):
        _cfg["api_key"] = _LOCAL_KEYS[_pid]


def generate_image(
    provider: str,
    prompt: str,
    image_size: str = None,      # "1K" / "2K" / "4K" (仅 gemini 协议)
    aspect_ratio: str = None,    # "16:9" / "9:16" / "4:3" / "1:1" 等
    ref_images: list = None,     # 参考图路径列表 (图生图)
    timeout: int = 180,
) -> dict:
    """
    统一图片生成接口

    返回: {
        "success": bool,
        "image_bytes": bytes | None,
        "width": int, "height": int,
        "elapsed": float,
        "provider": str,
        "error": str | None,
    }
    """
    cfg = PROVIDERS.get(provider)
    if not cfg:
        return _err(f"未知服务商: {provider}, 可选: {list(PROVIDERS.keys())}")
    if not cfg["api_key"]:
        return _err(f"{cfg['name']} 的 api_key 未配置")

    if cfg["protocol"] == "openai":
        return _call_openai(cfg, prompt, ref_images, timeout)
    elif cfg["protocol"] == "gemini":
        return _call_gemini(cfg, prompt, image_size, aspect_ratio, ref_images, timeout)
    else:
        return _err(f"未知协议: {cfg['protocol']}")


def _call_openai(cfg, prompt, ref_images, timeout):
    """OpenAI 兼容协议调用 (77code)"""
    url = f"{cfg['base_url']}/v1/chat/completions"
    headers = {
        "Authorization": f"Bearer {cfg['api_key']}",
        "Content-Type": "application/json",
    }

    # 构建 messages
    if ref_images:
        content_parts = []
        for img_path in ref_images:
            b64_url = _file_to_b64_url(img_path)
            content_parts.append({"type": "image_url", "image_url": {"url": b64_url}})
        content_parts.append({"type": "text", "text": prompt})
        messages = [{"role": "user", "content": content_parts}]
    else:
        messages = [{"role": "user", "content": prompt}]

    payload = {
        "model": cfg["model"],
        "messages": messages,
        "max_tokens": 8192,
    }

    start = time.time()
    try:
        resp = requests.post(url, json=payload, headers=headers, timeout=timeout)
        elapsed = round(time.time() - start, 1)
        if resp.status_code != 200:
            return _err(f"HTTP {resp.status_code}: {resp.text[:200]}", elapsed)

        data = resp.json()
        content = data["choices"][0]["message"]["content"]
        img_bytes = _extract_b64_image(content)
        if not img_bytes:
            return _err(f"响应中无图片: {content[:200]}", elapsed)

        img = Image.open(BytesIO(img_bytes))
        return _ok(img_bytes, img.size[0], img.size[1], elapsed, cfg["name"])
    except Exception as e:
        return _err(str(e), round(time.time() - start, 1))


def _call_gemini(cfg, prompt, image_size, aspect_ratio, ref_images, timeout):
    """Gemini 原生协议调用 (laozhang / APIYI / Google)"""
    model = cfg["model"]
    url = f"{cfg['base_url']}/v1beta/models/{model}:generateContent"

    # Google 用 query param 认证, 其他用 Bearer
    if cfg.get("auth_mode") == "query_param":
        url += f"?key={cfg['api_key']}"
        headers = {"Content-Type": "application/json"}
    else:
        headers = {
            "Authorization": f"Bearer {cfg['api_key']}",
            "Content-Type": "application/json",
        }

    # 构建 contents
    parts = []
    if ref_images:
        for img_path in ref_images:
            img_data, mime = _file_to_b64_data(img_path)
            parts.append({"inlineData": {"mimeType": mime, "data": img_data}})
    parts.append({"text": prompt})

    # 构建 generationConfig
    gen_config = {"responseModalities": ["TEXT", "IMAGE"]}
    if image_size or aspect_ratio:
        img_cfg = {}
        if image_size:
            img_cfg["imageSize"] = image_size
        if aspect_ratio:
            img_cfg["aspectRatio"] = aspect_ratio
        gen_config["imageConfig"] = img_cfg

    payload = {
        "contents": [{"parts": parts}],
        "generationConfig": gen_config,
    }

    start = time.time()
    try:
        resp = requests.post(url, json=payload, headers=headers, timeout=timeout)
        elapsed = round(time.time() - start, 1)
        if resp.status_code != 200:
            return _err(f"HTTP {resp.status_code}: {resp.text[:200]}", elapsed)

        data = resp.json()
        for c in data.get("candidates", []):
            for p in c.get("content", {}).get("parts", []):
                if "inlineData" in p:
                    img_bytes = base64.b64decode(p["inlineData"]["data"])
                    img = Image.open(BytesIO(img_bytes))
                    return _ok(img_bytes, img.size[0], img.size[1], elapsed, cfg["name"])

        return _err(f"响应中无图片: {str(data)[:200]}", elapsed)
    except Exception as e:
        return _err(str(e), round(time.time() - start, 1))


# ============================================================
# 工具函数
# ============================================================
def save_result(result, output_path):
    """保存生成结果到文件"""
    if not result["success"]:
        print(f"[FAIL] {result['error']}")
        return None
    os.makedirs(os.path.dirname(output_path) or ".", exist_ok=True)
    img = Image.open(BytesIO(result["image_bytes"]))
    img.save(output_path)
    print(f"[OK] {result['width']}x{result['height']}, "
          f"{len(result['image_bytes'])//1024}KB, "
          f"{result['elapsed']}s -> {output_path}")
    return output_path


def _extract_b64_image(content):
    if not content or "data:image" not in content:
        return None
    try:
        b64 = content.split("base64,")[1].split(")")[0].split('"')[0]
        return base64.b64decode(b64)
    except Exception:
        return None


def _file_to_b64_url(path):
    with open(path, "rb") as f:
        data = base64.b64encode(f.read()).decode()
    ext = os.path.splitext(path)[1].lower()
    mime = {"jpg": "jpeg", "jpeg": "jpeg", "png": "png", "webp": "webp"}.get(ext.strip("."), "jpeg")
    return f"data:image/{mime};base64,{data}"


def _file_to_b64_data(path):
    with open(path, "rb") as f:
        data = base64.b64encode(f.read()).decode()
    ext = os.path.splitext(path)[1].lower()
    mime = {"jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png", "webp": "image/webp"}.get(ext.strip("."), "image/jpeg")
    return data, mime


def _ok(img_bytes, w, h, elapsed, provider):
    return {"success": True, "image_bytes": img_bytes, "width": w, "height": h,
            "elapsed": elapsed, "provider": provider, "error": None}


def _err(msg, elapsed=0):
    return {"success": False, "image_bytes": None, "width": 0, "height": 0,
            "elapsed": elapsed, "provider": "", "error": msg}


# ============================================================
# 快速测试
# ============================================================
if __name__ == "__main__":
    print("=== 图片 API 配置信息 ===\n")
    for k, v in PROVIDERS.items():
        status = "已配置" if v["api_key"] else "未配置 key"
        print(f"  [{k}] {v['name']}")
        print(f"    协议: {v['protocol']}, 价格: {v['price']}")
        print(f"    最大分辨率: {v['max_resolution']}, 状态: {status}")
        print(f"    备注: {v['note']}\n")

    # 快速测试 77code
    print("=== 测试 77code 生图 ===")
    result = generate_image("77code", "A white coffee mug on clean white background, studio lighting, product photo.")
    save_result(result, "test_outputs/config_test_77code.png")
