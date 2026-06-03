"""
PC2 outputs 目录扫描 + 回填 legacy 历史 → generation_history.jsonl

5/10 之前 PC2 backend 是旧版（5001 端口），没启用历史子系统，所有生图只剩
outputs 目录里的 PNG 文件，没有 prompt/model/参考图等元数据。

本脚本扫描 outputs 下所有 generated_*.png（跳过 imported_*.*），
按文件名时间戳生成"轻量级历史记录"写入 generation_history.jsonl，
machine_id=pc2，prompt 用占位文案，让 SUPT 历史面板至少能看到缩略图和时间。

用法（在 PC2 上执行）：
    python _backfill_history.py --dry-run     # 只统计不写
    python _backfill_history.py               # 真实写入

幂等性：通过 jsonl 已有 output_files 集合做去重，重复跑不会写入相同记录。
"""

from __future__ import annotations

import argparse
import json
import os
import re
import secrets
import sys
import time
from datetime import datetime, timezone, timedelta

OUTPUTS_DIR = r"D:\2026AI\image-workflow-studio\backend\outputs"
JSONL_PATH = os.path.join(OUTPUTS_DIR, "generation_history.jsonl")
MACHINE_ID = "pc2"
LEGACY_PROMPT = "(legacy backfill: 5001 时期记录已丢失，仅保留缩略图和时间)"
LEGACY_TZ = timezone(timedelta(hours=8))  # 假设本地时区 +08:00
SCHEMA_VERSION = "1"

# generated_20260507_045307_633033.png  →  日期 + 时间 + 微秒序列
FILENAME_RE = re.compile(
    r"^generated_(\d{8})_(\d{6})_(\d{6,})\.(png|jpg|jpeg|webp)$",
    re.IGNORECASE,
)


def parse_timestamp_from_name(name: str) -> datetime | None:
    """从 generated_YYYYMMDD_HHMMSS_xxx.png 解析时间戳。"""
    m = FILENAME_RE.match(name)
    if not m:
        return None
    date_str, time_str, _suffix, _ext = m.groups()
    try:
        dt = datetime.strptime(date_str + time_str, "%Y%m%d%H%M%S")
        return dt.replace(tzinfo=LEGACY_TZ)
    except ValueError:
        return None


def load_existing_output_files(jsonl_path: str) -> set[str]:
    """从已有 jsonl 收集所有 output_files，用于去重。"""
    existing: set[str] = set()
    if not os.path.exists(jsonl_path):
        return existing
    with open(jsonl_path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            for p in rec.get("output_files") or []:
                existing.add(os.path.normcase(os.path.abspath(p)))
    return existing


def build_record(filepath: str, dt: datetime) -> dict:
    """构造一条 schema_version=1 的轻量级 history record。"""
    ts_ms = int(dt.timestamp() * 1000)
    rec_id = f"{MACHINE_ID}-{ts_ms}-{secrets.token_hex(3)}"
    return {
        "id": rec_id,
        "schema_version": SCHEMA_VERSION,
        "created_at": dt.isoformat(timespec="seconds"),
        "machine_id": MACHINE_ID,
        "source": "unknown",
        "raw_source": "legacy_backfill",
        "mode": "text2img",  # 无法判断，用文生图占位
        "prompt": LEGACY_PROMPT,
        "aspect_ratio": None,
        "resolution": None,
        "size": None,
        "quality": None,
        "provider_id": None,
        "provider_name": None,
        "model": None,
        "count": 1,
        "reference_count": 0,
        "output_files": [filepath],
        "eagle_item_ids": [],
        "elapsed_sec": 0.0,
        "success": True,
        "error_message": None,
        "canvas_save_state": None,
        "canvas_node_id": None,
        "batch_id": None,
        "script_name": "legacy_backfill_20260510",
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true", help="只统计，不写入")
    parser.add_argument(
        "--outputs-dir",
        default=OUTPUTS_DIR,
        help=f"outputs 目录（默认 {OUTPUTS_DIR}）",
    )
    parser.add_argument(
        "--jsonl",
        default=JSONL_PATH,
        help="目标 jsonl 路径",
    )
    args = parser.parse_args()

    if not os.path.isdir(args.outputs_dir):
        print(f"[ERROR] outputs 目录不存在: {args.outputs_dir}", file=sys.stderr)
        return 1

    existing = load_existing_output_files(args.jsonl)
    print(f"已有 jsonl 中 output_files 条目: {len(existing)}")

    candidates: list[tuple[str, datetime]] = []
    skipped_imported = 0
    skipped_unparseable = 0
    skipped_dup = 0
    total_files = 0

    for name in sorted(os.listdir(args.outputs_dir)):
        full = os.path.join(args.outputs_dir, name)
        if not os.path.isfile(full):
            continue
        total_files += 1
        if name.startswith("imported_"):
            skipped_imported += 1
            continue
        if not name.startswith("generated_"):
            # 可能是 legacy 命名或者其他格式，安全起见跳过
            skipped_unparseable += 1
            continue
        dt = parse_timestamp_from_name(name)
        if dt is None:
            skipped_unparseable += 1
            continue
        norm_key = os.path.normcase(os.path.abspath(full))
        if norm_key in existing:
            skipped_dup += 1
            continue
        candidates.append((full, dt))

    print(f"扫描总文件数: {total_files}")
    print(f"  generated_*: {len(candidates) + skipped_dup}")
    print(f"  imported_* (跳过): {skipped_imported}")
    print(f"  无法解析/其他 (跳过): {skipped_unparseable}")
    print(f"  已在 jsonl 中 (跳过): {skipped_dup}")
    print(f"  待回填: {len(candidates)}")

    if not candidates:
        print("没有需要回填的记录。")
        return 0

    # 按时间正序排
    candidates.sort(key=lambda x: x[1])
    earliest = candidates[0][1].isoformat(timespec="seconds")
    latest = candidates[-1][1].isoformat(timespec="seconds")
    print(f"  时间跨度: {earliest}  →  {latest}")

    if args.dry_run:
        print("\n--dry-run 模式，未写入。前 3 条预览:")
        for i, (full, dt) in enumerate(candidates[:3]):
            rec = build_record(full, dt)
            print(json.dumps(rec, ensure_ascii=False, indent=2))
        return 0

    os.makedirs(os.path.dirname(args.jsonl), exist_ok=True)
    written = 0
    with open(args.jsonl, "a", encoding="utf-8") as f:
        for full, dt in candidates:
            rec = build_record(full, dt)
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
            written += 1
    print(f"\n已写入 {written} 条 legacy 记录到 {args.jsonl}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
