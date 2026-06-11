#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
清理未使用的图片文件

功能：
1. 读取导出的项目数据（JSON）
2. 扫描 outputs 目录的所有图片文件
3. 找出未被项目引用的图片文件
4. 将未使用的文件移动到备份目录（安全删除）
"""

import os
import json
import shutil
from pathlib import Path
from datetime import datetime

# 配置
OUTPUTS_DIR = Path("outputs")
BACKUP_DIR = Path("outputs_backup_unused")
PROJECTS_FILE = "projects_export.json"  # 前端导出的项目数据文件


def load_projects(projects_file):
    """加载项目数据"""
    print(f"📖 读取项目数据: {projects_file}")

    try:
        with open(projects_file, "r", encoding="utf-8") as f:
            projects = json.load(f)

        print(f"✅ 成功加载 {len(projects)} 个项目")
        return projects
    except FileNotFoundError:
        print(f"❌ 错误: 找不到文件 {projects_file}")
        print("💡 请先运行 export_projects.html 导出项目数据")
        exit(1)
    except json.JSONDecodeError as e:
        print(f"❌ 错误: JSON 解析失败 - {e}")
        exit(1)


def get_used_images(projects):
    """获取所有被项目引用的图片文件名"""
    used_images = set()

    for project in projects:
        nodes = project.get("nodes", [])
        for node in nodes:
            # 提取 imageUrl（图片文件名）
            image_url = node.get("data", {}).get("imageUrl", "")
            if image_url:
                # 移除可能的路径前缀，只保留文件名
                filename = os.path.basename(image_url)
                if filename:
                    used_images.add(filename)

    print(f"✅ 找到 {len(used_images)} 个被引用的图片文件")
    return used_images


def scan_outputs(outputs_dir):
    """扫描 outputs 目录的所有图片文件"""
    print(f"📂 扫描目录: {outputs_dir}")

    if not outputs_dir.exists():
        print(f"❌ 错误: 目录不存在 {outputs_dir}")
        exit(1)

    # 只扫描 PNG 和 JPG 文件
    image_files = []
    for ext in ["*.png", "*.jpg", "*.jpeg", "*.webp"]:
        image_files.extend(outputs_dir.glob(ext))

    print(f"✅ 找到 {len(image_files)} 个图片文件")
    return image_files


def find_unused_images(all_files, used_images):
    """找出未被使用的图片文件"""
    unused_files = []

    for file in all_files:
        filename = file.name
        if filename not in used_images:
            unused_files.append(file)

    print(f"⚠️  找到 {len(unused_files)} 个未使用的图片文件")
    return unused_files


def backup_unused_files(unused_files, backup_dir):
    """备份未使用的文件（而不是直接删除）"""
    print(f"📦 备份目录: {backup_dir}")

    # 创建备份目录
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    backup_path = backup_dir / timestamp
    backup_path.mkdir(parents=True, exist_ok=True)

    print(f"📦 创建备份目录: {backup_path}")

    moved_count = 0
    total_size = 0

    for file in unused_files:
        try:
            # 目标路径
            dest_file = backup_path / file.name

            # 移动文件
            shutil.move(str(file), str(dest_file))
            moved_count += 1
            total_size += file.stat().st_size

            print(f"✅ 已移动: {file.name} ({file.stat().st_size / 1024:.1f} KB)")
        except Exception as e:
            print(f"❌ 移动失败 {file.name}: {e}")

    print(f"\n✅ 完成！")
    print(f"📦 已移动 {moved_count} 个文件到备份目录")
    print(f"💾 释放空间: {total_size / (1024 * 1024):.1f} MB")
    print(f"📁 备份路径: {backup_path}")


def show_summary(all_files, used_images, unused_files):
    """显示清理统计信息"""
    used_count = len(used_images)
    unused_count = len(unused_files)
    total_count = len(all_files)

    used_size = sum(f.stat().st_size for f in all_files if f.name in used_images)
    unused_size = sum(f.stat().st_size for f in unused_files)
    total_size = used_size + unused_size

    print("\n" + "=" * 60)
    print("📊 清理统计")
    print("=" * 60)
    print(f"总文件数:     {total_count}")
    print(f"已使用文件:   {used_count} ({used_count / total_count * 100:.1f}%)")
    print(f"未使用文件:   {unused_count} ({unused_count / total_count * 100:.1f}%)")
    print()
    print(f"总大小:       {total_size / (1024 * 1024):.1f} MB")
    print(
        f"已使用大小:   {used_size / (1024 * 1024):.1f} MB ({used_size / total_size * 100:.1f}%)"
    )
    print(
        f"未使用大小:   {unused_size / (1024 * 1024):.1f} MB ({unused_size / total_size * 100:.1f}%)"
    )
    print("=" * 60)

    # 显示前 10 个未使用的文件
    if unused_files:
        print("\n📝 未使用的文件（前 10 个）:")
        for i, file in enumerate(unused_files[:10], 1):
            size_mb = file.stat().st_size / (1024 * 1024)
            print(f"  {i}. {file.name} ({size_mb:.2f} MB)")

        if len(unused_files) > 10:
            print(f"  ... 还有 {len(unused_files) - 10} 个文件")


def main():
    """主函数"""
    print("=" * 60)
    print("🧹 图片清理工具")
    print("=" * 60)
    print()

    # 1. 加载项目数据
    projects = load_projects(PROJECTS_FILE)

    # 2. 获取被引用的图片
    used_images = get_used_images(projects)

    # 3. 扫描 outputs 目录
    all_files = scan_outputs(OUTPUTS_DIR)

    # 4. 找出未使用的文件
    unused_files = find_unused_images(all_files, used_images)

    # 5. 显示统计信息
    show_summary(all_files, used_images, unused_files)

    # 6. 询问是否继续
    if not unused_files:
        print("\n✅ 没有需要清理的文件，退出！")
        return

    print()
    print("⚠️  警告: 以下操作将把未使用的文件移动到备份目录")
    print("💡 如果确认无误，请输入 'yes' 继续，其他任意输入取消: ")
    confirm = input("> ").strip().lower()

    if confirm != "yes":
        print("❌ 已取消清理操作")
        return

    # 7. 备份未使用的文件
    backup_unused_files(unused_files, BACKUP_DIR)

    print("\n✅ 清理完成！")
    print(f"💡 如需恢复，请从 {BACKUP_DIR} 复制文件回 {OUTPUTS_DIR}")


if __name__ == "__main__":
    main()
