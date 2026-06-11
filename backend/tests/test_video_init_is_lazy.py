from __future__ import annotations


def test_image_initialize_does_not_check_video_key_by_default(tmp_path, capsys):
    from app import ImageGenerator

    gen = ImageGenerator()

    assert gen.initialize(api_key="", output_dir=str(tmp_path))

    captured = capsys.readouterr()
    assert "API Key" not in captured.out
