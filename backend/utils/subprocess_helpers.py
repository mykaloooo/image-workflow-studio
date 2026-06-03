"""跨平台 subprocess 调用辅助。

Windows 上 subprocess 默认会给外部命令创建前台 conhost 窗口，
导致命令行工具（ssh、git、curl 等）每次调用都闪一个黑窗。
本模块提供的封装统一加 CREATE_NO_WINDOW 标志，跨平台安全（POSIX 上无副作用）。

约束见 .windsurf/rules.md。
"""

import os
import subprocess


def _add_no_window_flag(kwargs: dict) -> dict:
    """在 Windows 上为 kwargs 注入 CREATE_NO_WINDOW，POSIX 上保持不变。"""
    if os.name == "nt":
        kwargs["creationflags"] = (
            kwargs.get("creationflags", 0) | subprocess.CREATE_NO_WINDOW
        )
    return kwargs


def run_silent(args, **kwargs):
    """跨平台 ``subprocess.run`` 包装，Windows 上自动隐藏控制台窗口。

    Args:
        args: 要执行的命令（list 或 str）。
        **kwargs: 透传给 ``subprocess.run``，如 ``capture_output`` /
            ``text`` / ``timeout`` 等。

    Returns:
        ``subprocess.CompletedProcess``
    """
    return subprocess.run(args, **_add_no_window_flag(kwargs))


def popen_silent(args, **kwargs):
    """跨平台 ``subprocess.Popen`` 包装，Windows 上自动隐藏控制台窗口。

    Args:
        args: 要执行的命令（list 或 str）。
        **kwargs: 透传给 ``subprocess.Popen``。

    Returns:
        ``subprocess.Popen`` 实例。
    """
    return subprocess.Popen(args, **_add_no_window_flag(kwargs))
