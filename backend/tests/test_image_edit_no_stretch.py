"""
Regression guard for OpenAI Images Edit reference-image stretching.

⛔ DO NOT delete or weaken this test.
This test exists because the exact same bug has been re-introduced TWICE:
  - 2026-05-10  first fix     (memory `b032055a`)
  - 2026-05-12  regression    (someone re-wrote `img.resize((target_w, target_h))`,
                               which un-did the 5/10 fix; kaka noticed her
                               生成图 came out 横向拉伸)

The contract that must NEVER break:
  When the caller passes `size="WxH"` whose aspect ratio differs from the
  reference image's aspect ratio, `_generate_openai_images_edit` must upload
  the reference image WITH ITS ORIGINAL ASPECT RATIO PRESERVED (gpt-image-1/2
  visual encoder accepts arbitrary aspect ratios — see memory `b032055a`).

Failure of this test means a future AI / developer has re-introduced the
1920x3840 → 2336x3520 squashing bug. Read `backend/app.py:2069-2091` and
`AGENTS.md` lock L1 before touching that code path.
"""

from __future__ import annotations

import base64
import io
from unittest.mock import MagicMock

import pytest
from PIL import Image


# ----- helpers ---------------------------------------------------------------

def _make_solid_png_bytes(width: int, height: int, color=(128, 64, 200)) -> bytes:
    """Generate a deterministic solid-color PNG of the requested size."""
    img = Image.new("RGB", (width, height), color)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def _aspect_ratio(width: int, height: int) -> float:
    return width / height if height else 0.0


# ----- the actual regression test -------------------------------------------

@pytest.mark.parametrize(
    "src_w, src_h, target_size, expected_ratio_label",
    [
        # 2026-05-12 卡卡踩坑的真实数据：1:2 参考图 + 2:3 目标 size
        (1920, 3840, "2336x3520", "1:2"),
        # 极致非标比例：1:3 详情页（卡卡说她做过 1:3 详情页都没问题）
        (1080, 3240, "2336x3520", "1:3"),
        # 横版被压成竖版的反向场景
        (3840, 1920, "1024x1536", "2:1"),
    ],
    ids=["1:2 ref → 2:3 target", "1:3 ref → 2:3 target", "2:1 ref → 2:3 target"],
)
def test_reference_image_aspect_ratio_preserved_when_target_size_differs(
    monkeypatch, src_w, src_h, target_size, expected_ratio_label
):
    """
    Smoke regression: pass a non-square reference image, pass a target size
    whose aspect ratio is INTENTIONALLY different, and assert the uploaded
    multipart bytes still match the source aspect ratio.

    If this test fails, someone has put back `img.resize((target_w, target_h))`
    or equivalent in `_generate_openai_images_edit`. See memory `b032055a`.
    """
    # Import here so a broken `app.py` (e.g. SyntaxError) shows up as the
    # collection failure, not a misleading test failure.
    from app import ImageGenerator

    src_png = _make_solid_png_bytes(src_w, src_h)
    src_b64 = base64.b64encode(src_png).decode("ascii")

    captured = {}

    def fake_post(url, **kwargs):
        # Intercept the multipart upload; pluck out the "image" file bytes
        # and decode them with PIL to recover the actual uploaded dimensions.
        files = kwargs.get("files") or []
        for entry in files:
            if not (isinstance(entry, tuple) and len(entry) >= 2):
                continue
            name, value = entry[0], entry[1]
            if name != "image":
                continue
            # value can be (filename, bytes) or (filename, bytes, mimetype)
            if isinstance(value, tuple) and len(value) >= 2:
                file_bytes = value[1]
            else:
                file_bytes = value
            img = Image.open(io.BytesIO(file_bytes))
            captured["w"] = img.width
            captured["h"] = img.height
            captured["url"] = url
            break

        resp = MagicMock()
        resp.status_code = 200
        # Empty data list → function returns cleanly without hitting save logic
        resp.json.return_value = {"data": []}
        resp.text = ""
        return resp

    # Patch BOTH `requests.post` (module-level alias inside app.py) and the
    # local `req_lib.post` (the function re-imports `requests as req_lib`).
    import requests as _requests
    monkeypatch.setattr(_requests, "post", fake_post)

    gen = ImageGenerator()
    gen.model = "codex-gpt-image-2"

    # Call the function under test. Downstream code may complain about empty
    # data, but we only care that `fake_post` was invoked with the multipart
    # body so we can inspect the uploaded reference image.
    try:
        gen._generate_openai_images_edit(
            prompt="regression-test",
            reference_images=[src_b64],
            size=target_size,
            quality="high",
            headers={"Authorization": "Bearer fake-key"},
            base_url="http://fake.test",
        )
    except Exception:
        # Downstream may raise (no images returned); ignore — captured is what
        # we need.
        pass

    assert "w" in captured, (
        f"`requests.post` was never called — test scaffolding is broken, not "
        f"the production code. Inspect `_generate_openai_images_edit`."
    )

    uw, uh = captured["w"], captured["h"]
    src_ratio = _aspect_ratio(src_w, src_h)
    up_ratio = _aspect_ratio(uw, uh)
    delta = abs(up_ratio - src_ratio)

    assert delta < 0.01, (
        f"\n\n"
        f"⛔⛔⛔ REGRESSION DETECTED ⛔⛔⛔\n"
        f"  参考图被 stretch 了！这就是卡卡在 2026-05-12 抓到的拉伸 bug。\n"
        f"\n"
        f"  参考图 (ratio {expected_ratio_label}):  {src_w}x{src_h}  ratio={src_ratio:.4f}\n"
        f"  目标 size              :  {target_size}\n"
        f"  实际上传              :  {uw}x{uh}  ratio={up_ratio:.4f}\n"
        f"  比例偏差              :  {delta:.4f}  (允许 < 0.01)\n"
        f"\n"
        f"  请检查 backend/app.py:2069-2091 的 `_generate_openai_images_edit`：\n"
        f"  参考图必须按原比例上传，长边 > 4096 才等比缩放，**严禁**\n"
        f"  `img.resize((target_w, target_h))` 这种强行 stretch 的写法。\n"
        f"\n"
        f"  中央记忆 ID: `b032055a` (2026-05-10 首修, 2026-05-12 二次回归)\n"
        f"  AGENTS.md 锁定段: L1\n"
    )


def test_oversize_reference_image_is_proportionally_downscaled(monkeypatch):
    """
    Long edge > 4096 must be proportionally downscaled to <= 4096, ratio
    preserved (this is the only resize allowed for reference images).
    """
    from app import ImageGenerator

    # 5000x2500 = 2:1, long edge 5000 > 4096 → expect downscale to ~4096x2048
    src_png = _make_solid_png_bytes(5000, 2500)
    src_b64 = base64.b64encode(src_png).decode("ascii")

    captured = {}

    def fake_post(url, **kwargs):
        files = kwargs.get("files") or []
        for entry in files:
            if isinstance(entry, tuple) and len(entry) >= 2 and entry[0] == "image":
                value = entry[1]
                file_bytes = value[1] if isinstance(value, tuple) else value
                img = Image.open(io.BytesIO(file_bytes))
                captured["w"], captured["h"] = img.width, img.height
                break
        resp = MagicMock()
        resp.status_code = 200
        resp.json.return_value = {"data": []}
        resp.text = ""
        return resp

    import requests as _requests
    monkeypatch.setattr(_requests, "post", fake_post)

    gen = ImageGenerator()
    gen.model = "codex-gpt-image-2"

    try:
        gen._generate_openai_images_edit(
            prompt="downscale-test",
            reference_images=[src_b64],
            size="2048x1024",
            quality="high",
            headers={"Authorization": "Bearer fake-key"},
            base_url="http://fake.test",
        )
    except Exception:
        pass

    assert "w" in captured
    uw, uh = captured["w"], captured["h"]
    assert max(uw, uh) <= 4096, (
        f"Long edge > 4096 violates the 4K upload cap: got {uw}x{uh}"
    )
    # Ratio preserved within 1%
    src_ratio = 5000 / 2500
    up_ratio = uw / uh
    assert abs(up_ratio - src_ratio) < 0.01, (
        f"Downscale broke aspect ratio: orig 2:1 → uploaded {uw}x{uh} "
        f"({up_ratio:.4f}, expected ~{src_ratio:.4f})"
    )
