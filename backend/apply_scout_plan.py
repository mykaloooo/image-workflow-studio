"""
供应商产品侦察落地脚本（apply）v2
==================================

接 supplier_product_scout.py 的产出（products_draft.json + assets_index.json + scout_meta.json），
在 Eagle 里完成"建产品子文件夹 + 把 item 引用进去"的落地：

  1. 读 scout 输出目录，定位父供应商文件夹
  2. 计算每个产品对应的 unique Eagle item id 列表（去重）
  3. dry-run（默认）：输出 apply_plan.md，不动 Eagle
  4. --apply：在 Eagle 父文件夹下建产品子文件夹（含 _Excluded 子夹）
  5.          生成 folder_link_tasks.json 交给 Eagle folder-linker 插件执行
  6. 输出 apply_report.md

执行机制（v2 引用模式）：
  Eagle HTTP API 不支持 /api/item/update 改 folders 字段。
  所以分两步：
    Step A: 本脚本通过 HTTP API 建子文件夹 + 生成 folder_link_tasks.json
    Step B: 用户在 Eagle 里打开 folder-linker 插件，加载 tasks.json，批量给 item 加 folder 引用

  优势：原始 item 不复制、不移动、不进回收站。一个 item 可同时出现在父文件夹和子文件夹。

用法
----

  # dry-run 看计划，不动 Eagle
  python backend/apply_scout_plan.py --scout-dir backend/outputs/supplier_scouts/歌宝婷

  # 真正落地（建文件夹 + 生成任务 JSON）
  python backend/apply_scout_plan.py --scout-dir backend/outputs/supplier_scouts/歌宝婷 --apply

  # 跳过 worth_ecommerce=false 的产品（不为它建夹）
  python backend/apply_scout_plan.py --scout-dir ... --apply --skip-low-worth
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Optional

# 复用 D:\2026AI\tools 下的 Eagle 客户端
_TOOLS_DIR = Path(r"D:\2026AI\tools")
if _TOOLS_DIR.is_dir() and str(_TOOLS_DIR) not in sys.path:
    sys.path.insert(0, str(_TOOLS_DIR))

from eagle_api import EagleAPI  # type: ignore

try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass


EXCLUDED_FOLDER_NAME = "_Excluded（待审核）"
APPLY_TAG_PREFIX = "scout"  # 给重入的 item 打 tag: scout, scout:P1 之类


# ====================================
# 数据加载
# ====================================
@dataclass
class ScoutBundle:
    """一次 scout 产出的所有数据"""
    scout_dir: Path
    supplier: str
    folder_id: str
    folder_path: str
    products: list[dict]
    excluded: list[dict]
    notes: str
    assets_index: dict[str, dict]  # asset_key -> asset info

    @classmethod
    def load(cls, scout_dir: Path) -> "ScoutBundle":
        meta = json.loads((scout_dir / "scout_meta.json").read_text(encoding="utf-8"))
        draft = json.loads((scout_dir / "products_draft.json").read_text(encoding="utf-8"))
        assets = json.loads((scout_dir / "assets_index.json").read_text(encoding="utf-8"))
        return cls(
            scout_dir=scout_dir,
            supplier=meta["supplier"],
            folder_id=meta["folder_id"],
            folder_path=meta.get("folder_path", ""),
            products=draft.get("products", []),
            excluded=draft.get("excluded", []),
            notes=draft.get("notes", ""),
            assets_index=assets,
        )


# ====================================
# 计划构建
# ====================================
@dataclass
class FolderPlan:
    """一个待建子文件夹的计划"""
    name: str
    purpose: str  # "product" | "excluded"
    product_id: str = ""
    product_name: str = ""
    eagle_item_ids: list[str] = field(default_factory=list)        # 主归属
    asset_keys: list[str] = field(default_factory=list)
    shared_with_earlier: list[str] = field(default_factory=list)   # 被前一 plan 抢走的 id（VLM 多归属）
    worth_ecommerce: bool = True
    confidence: str = ""
    selling_points: list[str] = field(default_factory=list)


def _safe_folder_name(s: str) -> str:
    """Eagle 能吃中文，但避免奇怪字符干扰路径解析"""
    s = re.sub(r"[\\/:*?\"<>|\r\n\t]+", "_", s or "").strip()
    return s[:120] or "unknown"


def build_plan(bundle: ScoutBundle, skip_low_worth: bool = False) -> list[FolderPlan]:
    """根据 products_draft.json 构造 FolderPlan 列表（产品 + Excluded 子夹）。

    去重策略：一个 eagle_id 只主归属第一个出现的 plan；后续 plan 里出现的同 id
    记入 shared_with_earlier 但不重入（避免一个 item 被复制 N 次到 N 个文件夹，
    避免第一次 trash 之后第二次 add_from_path 失败）。多归属信息在 apply 阶段
    通过 annotation/tags 写到主归属 item 上。"""
    plans: list[FolderPlan] = []
    claimed: dict[str, str] = {}  # eagle_id -> 第一个 plan 的 name

    # 1) 每个产品一个子文件夹
    for p in bundle.products:
        if skip_low_worth and not p.get("worth_ecommerce", True):
            continue

        # 子夹名 = "P1 黑色真皮三人位直排沙发"
        folder_name = _safe_folder_name(f"{p['product_id']} {p.get('name_zh', '').strip()}")

        eagle_ids: list[str] = []
        asset_keys: list[str] = []
        shared: list[str] = []
        for ref in p.get("source_refs", []):
            ak = ref.get("asset_key")
            if not ak or ak not in bundle.assets_index:
                continue
            eid = bundle.assets_index[ak]["eagle_id"]
            asset_keys.append(ak)
            if eid in claimed:
                if eid not in shared:
                    shared.append(eid)
                continue
            if eid not in eagle_ids:
                eagle_ids.append(eid)
                claimed[eid] = folder_name

        plans.append(FolderPlan(
            name=folder_name,
            purpose="product",
            product_id=p.get("product_id", ""),
            product_name=p.get("name_zh", ""),
            eagle_item_ids=eagle_ids,
            asset_keys=asset_keys,
            shared_with_earlier=shared,
            worth_ecommerce=p.get("worth_ecommerce", True),
            confidence=p.get("confidence", ""),
            selling_points=p.get("selling_points_hint", []),
        ))

    # 2) Excluded 子夹（如果有）
    if bundle.excluded:
        excluded_eagle_ids: list[str] = []
        excluded_keys: list[str] = []
        excluded_shared: list[str] = []
        for ex in bundle.excluded:
            ak = ex.get("asset_key")
            if not ak or ak not in bundle.assets_index:
                continue
            eid = bundle.assets_index[ak]["eagle_id"]
            excluded_keys.append(ak)
            if eid in claimed:
                if eid not in excluded_shared:
                    excluded_shared.append(eid)
                continue
            if eid not in excluded_eagle_ids:
                excluded_eagle_ids.append(eid)
                claimed[eid] = EXCLUDED_FOLDER_NAME

        if excluded_eagle_ids:
            plans.append(FolderPlan(
                name=EXCLUDED_FOLDER_NAME,
                purpose="excluded",
                eagle_item_ids=excluded_eagle_ids,
                asset_keys=excluded_keys,
                shared_with_earlier=excluded_shared,
            ))

    return plans


def find_orphan_items(bundle: ScoutBundle, plans: list[FolderPlan]) -> list[str]:
    """没出现在任何 plan 里的 eagle_id（可能 VLM 漏判，留在父文件夹不动）"""
    covered = set()
    for plan in plans:
        covered.update(plan.eagle_item_ids)
    all_ids = {a["eagle_id"] for a in bundle.assets_index.values()}
    return sorted(all_ids - covered)


# ====================================
# 报告：dry-run 输出 apply_plan.md
# ====================================
def render_plan_md(bundle: ScoutBundle, plans: list[FolderPlan], orphans: list[str]) -> str:
    lines: list[str] = []
    lines.append(f"# {bundle.supplier} · 落地计划（apply_plan）\n")
    lines.append(f"- **Eagle 完整路径**：`{bundle.folder_path}`")
    lines.append(f"- **父 folderId**：`{bundle.folder_id}`")
    lines.append(f"- **打开链接**：http://localhost:41595/folder?id={bundle.folder_id}")
    lines.append(f"- **生成时间**：{datetime.now().isoformat(timespec='seconds')}\n")

    lines.append("## 计划新建的子文件夹\n")
    for plan in plans:
        emoji = "📁" if plan.purpose == "product" else "🗑"
        worth_mark = ""
        if plan.purpose == "product":
            worth_mark = " ✅" if plan.worth_ecommerce else " ⏸（worth_ecommerce=false）"
        lines.append(f"### {emoji} {plan.name}{worth_mark}")
        if plan.purpose == "product":
            lines.append(f"- 置信度：`{plan.confidence}`")
            if plan.selling_points:
                lines.append(f"- 卖点：{' / '.join(plan.selling_points)}")
        lines.append(f"- 待重入 Eagle item 数：{len(plan.eagle_item_ids)}（来自 {len(plan.asset_keys)} 个素材引用）")
        for eid in plan.eagle_item_ids:
            lines.append(f"  - `{eid}`")
        if plan.shared_with_earlier:
            lines.append(f"- 与前一 plan 重叠的 item（VLM 多归属，本 plan 不再重入）：")
            for eid in plan.shared_with_earlier:
                lines.append(f"  - `{eid}`（已归到更早的 plan）")
        lines.append("")

    if orphans:
        lines.append("## 未归类 item（保留在父文件夹不动）\n")
        for eid in orphans:
            lines.append(f"- `{eid}`")
        lines.append("")

    lines.append("## 执行机制（v2 引用模式）\n")
    lines.append("- 创建子文件夹：HTTP `POST /api/folder/create`")
    lines.append("- 给 item 加文件夹引用：Eagle **folder-linker** 插件（使用 `eagle.item.modify` SDK）")
    lines.append("- 原始 item **不移动、不复制、不进回收站**，同时出现在父文件夹和子文件夹中\n")

    lines.append("## 注意\n")
    lines.append("- 当前为 **dry-run**，未对 Eagle 做任何修改。")
    lines.append("- 卡卡确认后用 `--apply` 真正执行。")
    lines.append("- `--apply` 会建子文件夹 + 生成 `folder_link_tasks.json`，随后在 Eagle 打开 folder-linker 插件完成引用。")
    return "\n".join(lines)


# ====================================
# 真正执行（v2: 只建文件夹 + 生成任务 JSON）
# ====================================
@dataclass
class ApplyOutcome:
    plan: FolderPlan
    new_folder_id: str = ""
    linked_items: list[str] = field(default_factory=list)  # item_ids 待引用
    failures: list[str] = field(default_factory=list)


def _get_existing_subfolders(eagle: EagleAPI, parent_id: str) -> dict[str, str]:
    """获取父文件夹下已有子文件夹 {name: folder_id}"""
    import httpx
    resp = httpx.get("http://localhost:41595/api/folder/list", timeout=10)
    all_folders = resp.json().get("data", [])

    def find_children(node, target_id):
        if node["id"] == target_id:
            return {c["name"]: c["id"] for c in node.get("children", [])}
        for ch in node.get("children", []):
            r = find_children(ch, target_id)
            if r is not None:
                return r
        return None

    for f in all_folders:
        result = find_children(f, parent_id)
        if result is not None:
            return result
    return {}


def apply_plan(
    eagle: EagleAPI,
    bundle: ScoutBundle,
    plans: list[FolderPlan],
) -> tuple[list[ApplyOutcome], list[dict]]:
    """建子文件夹 + 生成 folder_link_tasks。返回 (outcomes, link_tasks)"""
    outcomes: list[ApplyOutcome] = []
    link_tasks: list[dict] = []  # [{item_id, add_folders, plan_name, product_id}]
    parent_id = bundle.folder_id

    # 检查已有子文件夹（复用，不重建）
    existing = _get_existing_subfolders(eagle, parent_id)
    if existing:
        print(f"  ℹ️  检测到 {len(existing)} 个已有子文件夹，同名的将复用")

    for plan in plans:
        outcome = ApplyOutcome(plan=plan)
        print(f"\n=== {plan.name} ({len(plan.eagle_item_ids)} items) ===")

        # 0. 跳过 0 item 的 plan
        if not plan.eagle_item_ids:
            outcome.failures.append("跳过：本 plan 所有 item 都已归到更早的 plan，不建空夹")
            print(f"  ⏭️  跳过：item 已被前一 plan 占用")
            outcomes.append(outcome)
            continue

        # 1. 建子文件夹（或复用已有）
        if plan.name in existing:
            outcome.new_folder_id = existing[plan.name]
            print(f"  ♻️  复用已有子文件夹: {outcome.new_folder_id}")
        else:
            try:
                folder_resp = eagle._post("/api/folder/create", {
                    "folderName": plan.name,
                    "parent": parent_id,
                })
                outcome.new_folder_id = folder_resp["id"]
                print(f"  ✅ 子文件夹创建: {outcome.new_folder_id}")
            except Exception as e:
                outcome.failures.append(f"创建子文件夹失败: {e}")
                print(f"  ❌ 子文件夹创建失败: {e}")
                outcomes.append(outcome)
                continue

        # 2. 生成引用任务（不实际执行——由 Eagle 插件完成）
        for eid in plan.eagle_item_ids:
            link_tasks.append({
                "item_id": eid,
                "add_folders": [outcome.new_folder_id],
                "plan_name": plan.name,
                "product_id": plan.product_id,
            })
            outcome.linked_items.append(eid)

        print(f"  📋 生成 {len(plan.eagle_item_ids)} 条引用任务")
        outcomes.append(outcome)

    return outcomes, link_tasks


def render_report_md(
    bundle: ScoutBundle,
    outcomes: list[ApplyOutcome],
    orphans: list[str],
    tasks_path: str,
) -> str:
    lines: list[str] = []
    lines.append(f"# {bundle.supplier} · 落地报告（apply_report）\n")
    lines.append(f"- **Eagle 完整路径**：`{bundle.folder_path}`")
    lines.append(f"- **父 folderId**：`{bundle.folder_id}`")
    lines.append(f"- **执行时间**：{datetime.now().isoformat(timespec='seconds')}")
    lines.append(f"- **任务文件**：`{tasks_path}`\n")

    total_items = sum(len(o.linked_items) for o in outcomes)
    total_fail = sum(len(o.failures) for o in outcomes)
    lines.append(f"## 总览\n")
    lines.append(f"- 子文件夹建成：{sum(1 for o in outcomes if o.new_folder_id)}/{len(outcomes)}")
    lines.append(f"- 待引用 item：{total_items}")
    lines.append(f"- 失败：{total_fail}\n")

    for o in outcomes:
        lines.append(f"### {o.plan.name}")
        if o.new_folder_id:
            url = f"http://localhost:41595/folder?id={o.new_folder_id}"
            lines.append(f"- 子 folderId：`{o.new_folder_id}`")
            lines.append(f"- 打开：{url}")
        lines.append(f"- 待引用：{len(o.linked_items)} | 失败：{len(o.failures)}")
        for eid in o.linked_items:
            lines.append(f"  - `{eid}`")
        for f in o.failures:
            lines.append(f"  - ⚠️ {f}")
        lines.append("")

    if orphans:
        lines.append("## 未归类 item（保留在父文件夹）\n")
        for eid in orphans:
            lines.append(f"- `{eid}`")
        lines.append("")

    lines.append("## 下一步\n")
    lines.append(f"1. 在 Eagle 里打开 **folder-linker** 插件")
    lines.append(f"2. 加载任务文件：`{tasks_path}`")
    lines.append(f"3. 点击【执行】，批量给 item 加文件夹引用")
    lines.append(f"4. 完成后原始 item 不移动、不复制，同时出现在父文件夹和产品子文件夹中")
    return "\n".join(lines)


# ====================================
# 主入口
# ====================================
def main() -> int:
    ap = argparse.ArgumentParser(description="供应商产品侦察落地脚本 v2")
    ap.add_argument("--scout-dir", required=True, help="scout 输出目录，含 products_draft.json/assets_index.json/scout_meta.json")
    ap.add_argument("--apply", action="store_true", help="真实执行（默认 dry-run）")
    ap.add_argument("--skip-low-worth", action="store_true", help="跳过 worth_ecommerce=false 的产品")
    args = ap.parse_args()

    scout_dir = Path(args.scout_dir).resolve()
    if not (scout_dir / "products_draft.json").exists():
        print(f"❌ scout 目录无效: {scout_dir}")
        return 1

    print(f"📁 加载 scout 产物: {scout_dir}")
    bundle = ScoutBundle.load(scout_dir)
    print(f"   供应商: {bundle.supplier}")
    print(f"   父 folderId: {bundle.folder_id}")
    print(f"   产品数: {len(bundle.products)}")
    print(f"   Excluded: {len(bundle.excluded)}")

    plans = build_plan(bundle, skip_low_worth=args.skip_low_worth)
    orphans = find_orphan_items(bundle, plans)
    print(f"\n📋 计划子文件夹: {len(plans)}")
    print(f"   未归类 item: {len(orphans)}")

    # 写计划 md
    plan_md = render_plan_md(bundle, plans, orphans)
    plan_path = scout_dir / "apply_plan.md"
    plan_path.write_text(plan_md, encoding="utf-8")
    print(f"   计划已写: {plan_path}")

    if not args.apply:
        print("\n⏸  当前为 dry-run，未对 Eagle 做任何修改。")
        print(f"   人工 review {plan_path} 后，加 --apply 真实执行。")
        return 0

    # 真实执行：建文件夹 + 生成任务 JSON
    print(f"\n🚀 开始执行（建子文件夹 + 投递引用任务到队列）...")
    eagle = EagleAPI()
    outcomes, link_tasks = apply_plan(eagle, bundle, plans)

    # 写 folder_link_tasks.json
    # 1) 在 scout 目录留存档
    # 2) 投递到 folder-linker 监听队列（D:\2026AI\.runtime\folder_link_queue\）
    tasks_data = {
        "supplier": bundle.supplier,
        "parent_folder_id": bundle.folder_id,
        "generated_at": datetime.now().isoformat(timespec='seconds'),
        "tasks": link_tasks,
    }
    tasks_json = json.dumps(tasks_data, ensure_ascii=False, indent=2)

    # 存档
    archive_path = scout_dir / "folder_link_tasks.json"
    archive_path.write_text(tasks_json, encoding="utf-8")

    # 投递到队列
    queue_dir = Path(r"D:\2026AI\.runtime\folder_link_queue")
    queue_dir.mkdir(parents=True, exist_ok=True)
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    queue_path = queue_dir / f"{bundle.supplier}_{ts}.json"
    queue_path.write_text(tasks_json, encoding="utf-8")

    print(f"\n📋 任务文件已投递:")
    print(f"   存档: {archive_path}")
    print(f"   队列: {queue_path}")
    print(f"   共 {len(link_tasks)} 条任务")
    tasks_path = queue_path  # 报告用队列路径

    # 写报告
    report_md = render_report_md(bundle, outcomes, orphans, tasks_path=str(tasks_path))
    report_path = scout_dir / "apply_report.md"
    report_path.write_text(report_md, encoding="utf-8")
    print(f"📄 报告已写: {report_path}")

    # 写结构化 outcome
    outcome_json = scout_dir / "apply_outcome.json"
    outcome_json.write_text(json.dumps([{
        "folder_name": o.plan.name,
        "purpose": o.plan.purpose,
        "product_id": o.plan.product_id,
        "new_folder_id": o.new_folder_id,
        "linked_items": o.linked_items,
        "failures": o.failures,
    } for o in outcomes], ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"📄 结构化结果: {outcome_json}")

    fail_total = sum(len(o.failures) for o in outcomes)
    if fail_total:
        print(f"\n⚠️ 共 {fail_total} 个失败项，详见 apply_report.md")
        return 2

    print(f"\n✅ 子文件夹已建好，任务已投递到队列。")
    print(f"   只要 Eagle 里 folder-linker 插件处于【监听中】状态，")
    print(f"   它会在几秒内自动检测并执行引用。")
    print(f"   监听队列目录: {queue_dir}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
