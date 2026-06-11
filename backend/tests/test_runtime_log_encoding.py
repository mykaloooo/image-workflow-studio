from __future__ import annotations


def test_repair_mojibake_text_recovers_utf8_decoded_as_latin1():
    from app import _repair_mojibake_text

    mojibake = "æç®åä¸è½ç´æ¥è¾åºå¾ç"

    assert _repair_mojibake_text(mojibake) == "我目前不能直接输出图片"


def test_sanitize_runtime_log_text_repairs_mojibake_without_touching_normal_text():
    from app import _sanitize_runtime_log_text

    assert _sanitize_runtime_log_text("生成失败: æç®åä¸è½ç´æ¥è¾åºå¾ç") == "生成失败: 我目前不能直接输出图片"
    assert _sanitize_runtime_log_text("Chat 响应中未找到图片数据") == "Chat 响应中未找到图片数据"
