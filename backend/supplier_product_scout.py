"""
供应商产品侦察脚本 V0
=======================

针对一个 Eagle 供应商 / 展会文件夹，自动识别里面有几个独立产品、每个产品关联哪些
素材（原图 + 视频抽帧），输出人类可读的 products_draft.md + 结构化 JSON。

这是整条"供应商批量出图"工作流的第一步（侦察），目的是让卡卡快速确认：
  - 文件夹里到底有几款产品
  - 每款产品值不值得做电商图
  - AI 的分组是否准确

确认后才进入下一步（详细分析 → Eagle 归档 → 批量出主图+详情）。

用法
----
默认配置下直接 folder id 就能跑：

  D:/gcli2api/.venv/Scripts/python.exe supplier_product_scout.py --folder-id MND4Y2YNHFNFI

  # 或用文件夹名模糊匹配
  D:/gcli2api/.venv/Scripts/python.exe supplier_product_scout.py --folder "艾狄 沙发"

  # 指定 VLM
  ... --model gemini-3.1-pro-preview

产出（默认 outputs/supplier_scouts/<safe_folder_name>/）
-------------------------------------------------------
  thumbnails/         每个候选素材的 512px 缩图（命名=asset_key）
  assets_index.json   所有候选素材的源信息清单
  products_draft.json VLM 产品聚类结构化结果
  products_draft.md   人类可读版（给卡卡看）
  vlm_raw_response.md VLM 原始回复（debug 用）
  scout_meta.json     本次运行的元信息
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import re
import subprocess
import sys
import time
from dataclasses import dataclass, field, asdict
from datetime import datetime
from pathlib import Path
from typing import Optional

# 复用 D:\2026AI\tools 下的 Eagle / ffmpeg 工具
_TOOLS_DIR = Path(r"D:\2026AI\tools")
if _TOOLS_DIR.is_dir() and str(_TOOLS_DIR) not in sys.path:
    sys.path.insert(0, str(_TOOLS_DIR))

from eagle_api import EagleAPI  # type: ignore
from path_runtime import resolve_ffmpeg  # type: ignore

import httpx
from PIL import Image

# Windows 控制台常默认 GBK，包含 emoji / 中文的 print 会崩。强制 UTF-8。
try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass


# ====================================
# 配置
# ====================================
DEFAULT_MODEL = os.environ.get("SCOUT_MODEL", "gemini-3.1-pro-preview")
DEFAULT_API_BASE = os.environ.get("GCLI_BASE", "http://127.0.0.1:7861")
DEFAULT_API_KEY = os.environ.get("GCLI_KEY", "kaka-gcli2026")
FFMPEG = resolve_ffmpeg()

DEFAULT_OUTPUT_ROOT = Path(__file__).resolve().parent / "outputs" / "supplier_scouts"

# 单张缩图最大长边（像素）— Gemini Pro 对 token 还是敏感的，512 已经够分类
THUMB_MAX_SIDE = 512
# JPEG 压缩质量
THUMB_QUALITY = 80

# 视频抽帧策略：在视频 [start_pct, mid_pct, end_pct] 位置各抽 1 帧
VIDEO_FRAME_PCTS = (0.20, 0.50, 0.80)

# 一次最多送多少张图（超过就截断并在报告里警告）
MAX_THUMBS_PER_BATCH = 60


# ====================================
# 数据结构
# ====================================
@dataclass
class Asset:
    """一个候选素材：可能是一张原图或一个视频的某一帧"""
    key: str                  # 唯一键：photo:<eagle_id> / frame:<eagle_id>@<sec>
    kind: str                 # "photo" or "video_frame"
    eagle_id: str             # 来源 Eagle item id
    eagle_name: str           # 来源 item 名
    thumb_path: str = ""      # 512px 缩图本地路径
    frame_sec: Optional[float] = None   # video_frame 专用
    width: int = 0
    height: int = 0


# ====================================
# ffmpeg & 缩图
# ====================================
def get_video_duration(path: Path) -> float:
    r = subprocess.run(
        [FFMPEG, "-hide_banner", "-i", str(path)],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    m = re.search(r"Duration:\s*(\d+):(\d+):([\d.]+)", r.stderr or "")
    if not m:
        return 0.0
    h, mm, ss = int(m.group(1)), int(m.group(2)), float(m.group(3))
    return h * 3600 + mm * 60 + ss


def extract_video_frame(video: Path, sec: float, out_jpg: Path) -> bool:
    """用 ffmpeg 抽一帧并缩图保存到 out_jpg（内部会写临时大图再缩）"""
    out_jpg.parent.mkdir(parents=True, exist_ok=True)
    # 直接在 ffmpeg 里缩到长边不超 THUMB_MAX_SIDE，省 IO
    vf = (
        f"scale='if(gt(iw,ih),{THUMB_MAX_SIDE},-2)':"
        f"'if(gt(iw,ih),-2,{THUMB_MAX_SIDE})'"
    )
    cmd = [
        FFMPEG, "-y", "-loglevel", "error",
        "-ss", f"{sec:.2f}",
        "-i", str(video),
        "-vframes", "1",
        "-vf", vf,
        "-q:v", "3",
        str(out_jpg),
    ]
    r = subprocess.run(cmd, capture_output=True)
    return r.returncode == 0 and out_jpg.exists() and out_jpg.stat().st_size > 0


def make_thumbnail_from_image(src: Path, out_jpg: Path) -> bool:
    """把原图缩到长边 THUMB_MAX_SIDE，输出 JPEG"""
    try:
        out_jpg.parent.mkdir(parents=True, exist_ok=True)
        with Image.open(src) as im:
            im = im.convert("RGB")
            w, h = im.size
            scale = min(1.0, THUMB_MAX_SIDE / max(w, h))
            if scale < 1.0:
                im = im.resize((int(w * scale), int(h * scale)), Image.LANCZOS)
            im.save(out_jpg, "JPEG", quality=THUMB_QUALITY, optimize=True)
        return True
    except Exception as e:
        print(f"  [缩图失败] {src}: {e}")
        return False


# ====================================
# Eagle 素材收集
# ====================================
IMAGE_EXTS = {"jpg", "jpeg", "png", "webp", "heic", "bmp"}
VIDEO_EXTS = {"mp4", "mov", "mkv", "m4v", "webm", "avi"}


def _safe_folder_name(name: str) -> str:
    s = re.sub(r"[^\w\u4e00-\u9fff]+", "_", name or "").strip("_")
    return s[:80] or "unknown_supplier"


def collect_assets(
    eagle: EagleAPI,
    folder_id: str,
    thumbs_dir: Path,
    max_videos: int = 0,
    video_frame_count: int = 3,
) -> list[Asset]:
    """列 folder 下所有图片 + 视频，生成候选 Asset 清单并抽缩图。
    不递归子文件夹（子文件夹通常是 gen/ 或旧分析结果）。
    """
    items = eagle.list_folder_items(folder_id, limit=1000)
    assets: list[Asset] = []

    # 图片直接纳入
    photos = [i for i in items if (i.get("ext") or "").lower() in IMAGE_EXTS]
    videos = [i for i in items if (i.get("ext") or "").lower() in VIDEO_EXTS]

    print(f"[素材盘点] 图片 {len(photos)}, 视频 {len(videos)}")

    for it in photos:
        key = f"photo__{it['id']}"
        thumb = thumbs_dir / f"{key}.jpg"
        if not thumb.exists():
            src = eagle.get_item_path(it)
            if not src.exists():
                print(f"  [跳过] {it['name']}: 物理文件不存在 {src}")
                continue
            if not make_thumbnail_from_image(src, thumb):
                continue
        assets.append(Asset(
            key=key,
            kind="photo",
            eagle_id=it["id"],
            eagle_name=it.get("name", ""),
            thumb_path=str(thumb),
            width=it.get("width", 0),
            height=it.get("height", 0),
        ))

    # 视频按拍摄时间排序，最多取 max_videos（0 = 全部）
    videos.sort(key=lambda v: v.get("btime", 0))
    if max_videos and len(videos) > max_videos:
        print(f"[限制] 视频 {len(videos)} > {max_videos}，按 btime 取前 {max_videos}")
        videos = videos[:max_videos]

    pcts = VIDEO_FRAME_PCTS[:max(1, min(video_frame_count, len(VIDEO_FRAME_PCTS)))]

    for it in videos:
        src = eagle.get_item_path(it)
        if not src.exists():
            print(f"  [跳过] {it['name']}: 物理文件不存在 {src}")
            continue
        dur = it.get("duration") or get_video_duration(src)
        if dur <= 0:
            print(f"  [跳过] {it['name']}: 无法获取时长")
            continue
        for pct in pcts:
            sec = round(dur * pct, 2)
            key = f"frame__{it['id']}__{sec:.2f}s"
            thumb = thumbs_dir / f"{key}.jpg"
            if not thumb.exists():
                ok = extract_video_frame(src, sec, thumb)
                if not ok:
                    print(f"  [抽帧失败] {it['name']} @ {sec:.1f}s")
                    continue
            assets.append(Asset(
                key=key,
                kind="video_frame",
                eagle_id=it["id"],
                eagle_name=it.get("name", ""),
                thumb_path=str(thumb),
                frame_sec=sec,
                width=it.get("width", 0),
                height=it.get("height", 0),
            ))
    return assets


# ====================================
# VLM 调用
# ====================================
SCOUT_PROMPT = """你是电商供应商产品侦察助手。

下面我会给你一个供应商/展会文件夹里的所有候选素材缩图，可能包括：
- 现场拍的产品全景照
- 产品细节特写
- 视频里抽出的代表帧（文件名里带 frame__ 和秒数）

每张图前面会标注它的 **asset_key**，后续产品聚类必须引用这个 key。

你的任务：

## 1. 识别独立产品
把这些素材按"是不是同一款产品"聚类。判断依据：
- 同一产品的不同角度、不同机位、不同光线 → **同一款**
- 同款不同颜色、不同面料、不同尺寸 → **不同款**（重要！）
- 邻位展品、背景里别家的东西、路人、标牌、场外环境 → **不归入任何产品**，放到 excluded

## 2. 每款产品要给出
- `product_id`：P1 / P2 / P3 …
- `name_zh`：简洁中文名，20 字内，包含关键外观识别信息
  例："黑色布艺三人位直排沙发" / "米白色皮质单人休闲椅"
- `category`：品类（沙发 / 椅子 / 床 / 柜 / 灯具 / 茶几 / 餐桌 / 其他）
- `color`：主色
- `material`：主要面料/材质
- `structure`：结构/规格（几人位、有无扶手、是否可拆卸等）
- `style`：风格关键词（现代简约 / 美式 / 侘寂 / 奶油风 等）
- `confidence`：high / medium / low（你对这款聚类正确性的信心）
- `worth_ecommerce`：true/false（这款是否值得做电商主图/详情）
- `worth_reason`：简短理由（够不够主打、角度是否完整）
- `selling_points_hint`：建议的 3-6 个主卖点关键词
- `source_refs`：关联的 asset_key 列表，每个附上 role
  role 取值："front" / "angle" / "back" / "detail" / "material" / "scene" / "other"

## 3. Excluded 清单
不归入任何产品的 asset_key，简要说明原因（如"邻位展品"、"标牌参数"、"人物抢镜"、"纯背景环境"）。

## 4. Notes
额外观察，比如"2 款是同设计不同面料可能可合并"、"某视频帧模糊建议重抽"等。

---

**严格按下面 JSON 格式输出，不要加任何 markdown 围栏或解释**：

```
{
  "products": [
    {
      "product_id": "P1",
      "name_zh": "...",
      "category": "...",
      "color": "...",
      "material": "...",
      "structure": "...",
      "style": "...",
      "confidence": "high",
      "worth_ecommerce": true,
      "worth_reason": "...",
      "selling_points_hint": ["...", "..."],
      "source_refs": [
        {"asset_key": "photo__MNCFZN01WPJOO", "role": "front"},
        {"asset_key": "frame__MNDT51PFEMIHK__15.50s", "role": "detail"}
      ]
    }
  ],
  "excluded": [
    {"asset_key": "...", "reason": "..."}
  ],
  "notes": "..."
}
```

要求：
- source_refs 里的 asset_key 必须和我给你的 key **完全一致**，不要改写。
- 每张图要么进 products 要么进 excluded，不要遗漏。
- 宁可多做判断，不要漏掉明显的产品款式差异。
"""


def call_vlm(
    assets: list[Asset],
    prompt: str,
    api_base: str,
    api_key: str,
    model: str,
    timeout: float = 900.0,
) -> dict:
    """把所有 asset 缩图 + prompt 送给 VLM，返回原始 response dict"""
    content: list[dict] = [{"type": "text", "text": prompt}]
    for a in assets:
        with open(a.thumb_path, "rb") as f:
            b64 = base64.b64encode(f.read()).decode("ascii")
        content.append({"type": "text", "text": f"\n\n[asset_key: {a.key}]"})
        content.append({
            "type": "image_url",
            "image_url": {"url": f"data:image/jpeg;base64,{b64}"},
        })

    payload = {
        "model": model,
        "messages": [{"role": "user", "content": content}],
        "temperature": 0.2,
    }
    url = f"{api_base.rstrip('/')}/v1/chat/completions"
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}

    print(f"[VLM] model={model} n_images={len(assets)} → POST {url}")
    t0 = time.time()
    with httpx.Client(timeout=timeout, trust_env=False) as client:
        resp = client.post(url, json=payload, headers=headers)
    elapsed = time.time() - t0
    print(f"[VLM] 耗时 {elapsed:.1f}s, status={resp.status_code}")
    if resp.status_code != 200:
        raise RuntimeError(f"VLM API failed: {resp.status_code} {resp.text[:800]}")
    return resp.json()


def parse_vlm_json(text: str) -> dict:
    """从 VLM 响应里抠出 JSON。容忍 ```json 围栏。"""
    # 先尝试找 ```json``` 围栏
    m = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.DOTALL)
    if m:
        try:
            return json.loads(m.group(1))
        except Exception:
            pass
    # 退化：抓第一个 { 到最后一个 }
    start = text.find("{")
    end = text.rfind("}")
    if start >= 0 and end > start:
        snippet = text[start:end + 1]
        try:
            return json.loads(snippet)
        except Exception:
            pass
    raise ValueError(f"无法从 VLM 响应里解析出 JSON。原文前 500 字：{text[:500]}")


# ====================================
# 报告生成
# ====================================
def render_products_md(
    result: dict,
    assets_by_key: dict[str, Asset],
    supplier_name: str,
    folder_path: str,
    model: str,
    elapsed_sec: float,
) -> str:
    products = result.get("products", []) or []
    excluded = result.get("excluded", []) or []
    notes = result.get("notes", "") or ""

    lines: list[str] = []
    lines.append(f"# 供应商产品侦察 · {supplier_name}")
    lines.append("")
    lines.append(f"- **Eagle 路径**：{folder_path}")
    lines.append(f"- **扫描时间**：{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    lines.append(f"- **VLM 模型**：`{model}`，耗时 {elapsed_sec:.1f}s")
    lines.append(f"- **候选素材**：{len(assets_by_key)} 张")
    lines.append(f"- **识别产品**：{len(products)} 款")
    lines.append(f"- **排除素材**：{len(excluded)} 张")
    lines.append("")

    if not products:
        lines.append("> ⚠️ VLM 没识别出任何产品，请查看 `vlm_raw_response.md` 排查。")
        lines.append("")

    for p in products:
        pid = p.get("product_id", "?")
        name = p.get("name_zh", "未命名产品")
        worth = "✅ 值得出图" if p.get("worth_ecommerce") else "❌ 不建议"
        conf = p.get("confidence", "?")
        lines.append(f"## {pid} · {name}  （{worth}，置信 {conf}）")
        lines.append("")
        lines.append(f"- **品类**：{p.get('category', '')}")
        lines.append(f"- **颜色**：{p.get('color', '')}")
        lines.append(f"- **材质**：{p.get('material', '')}")
        lines.append(f"- **结构**：{p.get('structure', '')}")
        lines.append(f"- **风格**：{p.get('style', '')}")
        if p.get("worth_reason"):
            lines.append(f"- **判断理由**：{p['worth_reason']}")
        hints = p.get("selling_points_hint") or []
        if hints:
            lines.append(f"- **卖点建议**：{' / '.join(hints)}")

        refs = p.get("source_refs") or []
        if refs:
            lines.append("- **关联素材**：")
            for r in refs:
                key = r.get("asset_key", "?")
                role = r.get("role", "")
                a = assets_by_key.get(key)
                thumb_rel = ""
                src_desc = "未知"
                if a:
                    thumb_rel = Path(a.thumb_path).name
                    src_desc = f"{a.kind} {a.eagle_name}"
                    if a.frame_sec is not None:
                        src_desc += f" @ {a.frame_sec:.1f}s"
                lines.append(
                    f"  - `[{role}]` `{key}` — {src_desc}  "
                    f"![]({Path('thumbnails') / thumb_rel})" if thumb_rel
                    else f"  - `[{role}]` `{key}` — {src_desc}"
                )
        lines.append("")

    if excluded:
        lines.append("## Excluded（AI 认为与产品无关）")
        lines.append("")
        for e in excluded:
            key = e.get("asset_key", "?")
            reason = e.get("reason", "")
            a = assets_by_key.get(key)
            src_desc = f"{a.kind} {a.eagle_name}" if a else "未知"
            if a and a.frame_sec is not None:
                src_desc += f" @ {a.frame_sec:.1f}s"
            lines.append(f"- `{key}` — {src_desc} — {reason}")
        lines.append("")

    if notes:
        lines.append("## Notes")
        lines.append("")
        lines.append(notes)
        lines.append("")

    # 原始 JSON 附上，方便下一步 V1 脚本直接读
    lines.append("---")
    lines.append("")
    lines.append("## 下一步")
    lines.append("")
    lines.append("- 卡卡检查上面聚类是否合理")
    lines.append("- 在 `products_draft.json` 里把不想做的产品 `worth_ecommerce` 设为 false")
    lines.append("- 跑 V1 脚本：`supplier_product_profile.py --scout-dir <本目录>` "
                 "（对 worth_ecommerce=true 的产品跑详细视频分析）")
    return "\n".join(lines)


# ====================================
# 主流程
# ====================================
def main():
    ap = argparse.ArgumentParser(description="供应商产品侦察 V0")
    grp = ap.add_mutually_exclusive_group(required=True)
    grp.add_argument("--folder-id", help="Eagle 文件夹 ID（精确）")
    grp.add_argument("--folder", help="Eagle 文件夹名（模糊匹配）")
    ap.add_argument("--supplier", help="供应商名（默认取文件夹名）")
    ap.add_argument("--output-root", default=str(DEFAULT_OUTPUT_ROOT),
                    help="产出根目录（默认 backend/outputs/supplier_scouts）")
    ap.add_argument("--model", default=DEFAULT_MODEL, help="VLM 模型")
    ap.add_argument("--api-base", default=DEFAULT_API_BASE)
    ap.add_argument("--api-key", default=DEFAULT_API_KEY)
    ap.add_argument("--max-videos", type=int, default=0,
                    help="最多处理多少个视频（0 = 全部）")
    ap.add_argument("--video-frame-count", type=int, default=3,
                    help="每个视频抽多少帧（默认 3）")
    ap.add_argument("--max-thumbs", type=int, default=MAX_THUMBS_PER_BATCH,
                    help="送给 VLM 的最多缩图数（超过会截断）")
    ap.add_argument("--force-vlm", action="store_true", help="即使 products_draft.json 存在也重跑 VLM")
    args = ap.parse_args()

    eagle = EagleAPI()

    # 定位文件夹
    query = args.folder_id or args.folder
    matches = eagle.find_folder(query)
    if args.folder_id:
        matches = [m for m in matches if m["id"] == args.folder_id]
    if not matches:
        print(f"❌ 未找到文件夹: {query}")
        sys.exit(1)
    if len(matches) > 1 and not args.folder_id:
        print(f"⚠️ '{query}' 匹配到 {len(matches)} 个，请用 --folder-id 精确指定：")
        for m in matches:
            print(f"  {m['id']}  {m['path']}")
        sys.exit(1)
    folder = matches[0]
    supplier = args.supplier or folder["name"]
    safe = _safe_folder_name(supplier)

    out_dir = Path(args.output_root) / safe
    thumbs_dir = out_dir / "thumbnails"
    out_dir.mkdir(parents=True, exist_ok=True)
    thumbs_dir.mkdir(parents=True, exist_ok=True)

    print(f"\n📁 供应商: {supplier}")
    print(f"   Eagle ID: {folder['id']}")
    print(f"   路径: {folder['path']}")
    print(f"   产出: {out_dir}\n")

    # 收集素材 + 抽缩图
    t_collect = time.time()
    assets = collect_assets(
        eagle, folder["id"], thumbs_dir,
        max_videos=args.max_videos,
        video_frame_count=args.video_frame_count,
    )
    print(f"[缩图] 共 {len(assets)} 张候选，耗时 {time.time() - t_collect:.1f}s")

    if not assets:
        print("❌ 没有任何候选素材，结束")
        sys.exit(1)

    # assets_index.json — 总览
    assets_index = {a.key: asdict(a) for a in assets}
    (out_dir / "assets_index.json").write_text(
        json.dumps(assets_index, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    # 超限截断
    if len(assets) > args.max_thumbs:
        print(f"⚠️ 候选 {len(assets)} > {args.max_thumbs}，只送前 {args.max_thumbs} 张给 VLM")
        vlm_assets = assets[:args.max_thumbs]
    else:
        vlm_assets = assets

    # 可恢复：products_draft.json 已存在就跳过，除非 --force-vlm
    draft_json = out_dir / "products_draft.json"
    if draft_json.exists() and not args.force_vlm:
        print(f"[复用] {draft_json} 已存在，跳过 VLM 调用。加 --force-vlm 可强制重跑。")
        result = json.loads(draft_json.read_text(encoding="utf-8"))
        raw_text = ""
        elapsed = 0.0
    else:
        # 调 VLM
        t_vlm = time.time()
        resp = call_vlm(
            vlm_assets, SCOUT_PROMPT,
            api_base=args.api_base, api_key=args.api_key, model=args.model,
        )
        elapsed = time.time() - t_vlm

        raw_text = resp["choices"][0]["message"]["content"]
        (out_dir / "vlm_raw_response.md").write_text(raw_text, encoding="utf-8")
        try:
            result = parse_vlm_json(raw_text)
        except ValueError as e:
            print(f"❌ VLM 响应解析失败: {e}")
            print(f"   原始响应已保存到 vlm_raw_response.md，请人工检查")
            sys.exit(2)

        draft_json.write_text(
            json.dumps(result, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

    # 生成 md 报告
    assets_by_key = {a.key: a for a in assets}
    md = render_products_md(
        result, assets_by_key,
        supplier_name=supplier,
        folder_path=folder["path"],
        model=args.model,
        elapsed_sec=elapsed,
    )
    (out_dir / "products_draft.md").write_text(md, encoding="utf-8")

    # 元信息
    (out_dir / "scout_meta.json").write_text(
        json.dumps({
            "supplier": supplier,
            "folder_id": folder["id"],
            "folder_path": folder["path"],
            "model": args.model,
            "api_base": args.api_base,
            "assets_total": len(assets),
            "assets_sent_to_vlm": len(vlm_assets),
            "vlm_elapsed_sec": round(elapsed, 1),
            "finished_at": datetime.now().isoformat(),
        }, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    print("\n" + "=" * 60)
    print(f"✅ 完成：{out_dir}")
    print(f"  📄 products_draft.md      ← 卡卡先看这份")
    print(f"  🧾 products_draft.json    ← 结构化（给 V1 读）")
    print(f"  📦 thumbnails/*.jpg       ← {len(assets)} 张候选缩图")
    print("=" * 60)


if __name__ == "__main__":
    main()
