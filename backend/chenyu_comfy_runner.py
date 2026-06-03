"""Command line runner for Chenyu instance + ComfyUI jobs."""

from __future__ import annotations

import argparse
import json
import sys
import time
import uuid
from pathlib import Path

from PIL import Image

from integrations.chenyu_comfy import (
    ChenyuClient,
    ComfyClient,
    DEFAULT_RUNNING_STATUS,
    DEFAULT_STOPPED_STATUSES,
    find_service_url,
    first_output_image,
    nomos_4x_prompt,
)


def _load_prompt(path: Path, image_name: str) -> dict:
    text = path.read_text(encoding="utf-8")
    text = text.replace("{{input_image}}", image_name)
    return json.loads(text)


def _resize_to_target(raw_path: Path, final_path: Path, width: int, height: int, dpi: int) -> None:
    final_path.parent.mkdir(parents=True, exist_ok=True)
    with Image.open(raw_path) as image:
        image = image.convert("RGB")
        image = image.resize((width, height), Image.Resampling.LANCZOS)
        image.save(final_path, dpi=(dpi, dpi), optimize=True)


def _wait_for_comfy_ready(
    comfy: ComfyClient,
    *,
    timeout_seconds: int,
    poll_seconds: int,
) -> dict:
    deadline = time.monotonic() + timeout_seconds
    last_error: Exception | None = None
    while time.monotonic() < deadline:
        try:
            return comfy.system_stats()
        except Exception as exc:
            last_error = exc
            print(f"waiting ComfyUI ready... {type(exc).__name__}")
            time.sleep(poll_seconds)
    raise TimeoutError(f"ComfyUI did not become ready: {last_error}") from last_error


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run a ComfyUI job on a Chenyu GPU instance and optionally shut it down.",
    )
    parser.add_argument("--instance-uuid", help="Existing Chenyu instance UUID.")
    parser.add_argument("--comfy-url", help="Use an already running ComfyUI URL and skip Chenyu startup.")
    parser.add_argument("--input-image", required=True, help="Local input image path.")
    parser.add_argument("--raw-output", required=True, help="Path for the direct ComfyUI output image.")
    parser.add_argument("--final-output", help="Optional path for resized final output.")
    parser.add_argument("--target-width", type=int, help="Final output width in pixels.")
    parser.add_argument("--target-height", type=int, help="Final output height in pixels.")
    parser.add_argument("--dpi", type=int, default=150, help="Final output DPI metadata.")
    parser.add_argument("--workflow-json", help="Custom ComfyUI prompt JSON. Use {{input_image}} placeholder.")
    parser.add_argument("--workflow", default="nomos4x", choices=["nomos4x"], help="Built-in workflow.")
    parser.add_argument("--prefix", default="codex_chenyu", help="ComfyUI SaveImage filename prefix.")
    parser.add_argument("--gpu-uuid", help="Optional GPU UUID for startup.")
    parser.add_argument("--gpu-nums", type=int, help="Optional GPU count for startup.")
    parser.add_argument("--startup-timeout", type=int, default=900)
    parser.add_argument("--comfy-ready-timeout", type=int, default=600)
    parser.add_argument("--prompt-timeout", type=int, default=1800)
    parser.add_argument("--poll-seconds", type=int, default=5)
    parser.add_argument("--idle-close-minutes", type=int, choices=[0, 10, 30, 60, 120])
    parser.add_argument("--keep-running", action="store_true", help="Do not shut down the Chenyu instance.")
    parser.add_argument("--dry-run", action="store_true", help="Print the planned job and exit.")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    input_image = Path(args.input_image)
    raw_output = Path(args.raw_output)
    final_output = Path(args.final_output) if args.final_output else None

    if not input_image.exists():
        raise FileNotFoundError(input_image)
    if final_output and (not args.target_width or not args.target_height):
        raise ValueError("--final-output requires --target-width and --target-height")
    if not args.comfy_url and not args.instance_uuid:
        raise ValueError("Provide --instance-uuid or --comfy-url")

    print("Chenyu/ComfyUI runner")
    print(f"input: {input_image}")
    print(f"raw_output: {raw_output}")
    if final_output:
        print(f"final_output: {final_output} ({args.target_width}x{args.target_height}, {args.dpi}DPI)")
    print(f"shutdown_after_run: {not args.keep_running and not args.comfy_url}")

    if args.dry_run:
        return 0

    chenyu: ChenyuClient | None = None
    comfy_url = args.comfy_url.rstrip("/") if args.comfy_url else None
    should_shutdown = False

    try:
        if not comfy_url:
            chenyu = ChenyuClient()
            info = chenyu.instance_info(args.instance_uuid)
            status = int(info.get("status", -1))
            print(f"instance status before startup: {status}")
            if status != DEFAULT_RUNNING_STATUS:
                print("starting instance...")
                chenyu.startup(args.instance_uuid, gpu_uuid=args.gpu_uuid, gpu_nums=args.gpu_nums)
                should_shutdown = True
                info = chenyu.wait_for_status(
                    args.instance_uuid,
                    {DEFAULT_RUNNING_STATUS},
                    timeout_seconds=args.startup_timeout,
                    poll_seconds=args.poll_seconds,
                    on_poll=lambda item: print(f"startup poll status={item.get('status')}"),
                )
            else:
                should_shutdown = True
            if args.idle_close_minutes is not None:
                chenyu.set_idle_close(args.instance_uuid, args.idle_close_minutes)
                print(f"idle close set: {args.idle_close_minutes} minutes")
            comfy_url = find_service_url(info, "WebUI")

        print(f"comfy_url: {comfy_url}")
        comfy = ComfyClient(comfy_url)
        stats = _wait_for_comfy_ready(
            comfy,
            timeout_seconds=args.comfy_ready_timeout,
            poll_seconds=args.poll_seconds,
        )
        devices = stats.get("devices") or []
        print("device:", devices[0].get("name") if devices else "unknown")

        upload_name = f"input_{uuid.uuid4().hex[:8]}{input_image.suffix.lower()}"
        uploaded = comfy.upload_image(input_image, name=upload_name)
        print(f"uploaded: {uploaded}")

        if args.workflow_json:
            prompt = _load_prompt(Path(args.workflow_json), uploaded)
        else:
            prompt = nomos_4x_prompt(uploaded, prefix=args.prefix)

        prompt_id = comfy.queue_prompt(prompt, client_id=f"codex-{uuid.uuid4().hex[:10]}")
        print(f"prompt_id: {prompt_id}")
        start = time.monotonic()
        history = comfy.wait_for_prompt(
            prompt_id,
            timeout_seconds=args.prompt_timeout,
            poll_seconds=args.poll_seconds,
            on_poll=lambda elapsed: print(f"waiting prompt... {elapsed}s"),
        )
        print(f"prompt finished in {int(time.monotonic() - start)}s")

        image_meta = first_output_image(history)
        comfy.download_image(image_meta, raw_output)
        print(f"downloaded raw: {raw_output}")

        if final_output:
            _resize_to_target(raw_output, final_output, args.target_width, args.target_height, args.dpi)
            print(f"resized final: {final_output}")

        return 0
    finally:
        if chenyu and args.instance_uuid and should_shutdown and not args.keep_running:
            try:
                print("shutting down instance...")
                chenyu.shutdown(args.instance_uuid)
                chenyu.wait_for_status(
                    args.instance_uuid,
                    DEFAULT_STOPPED_STATUSES,
                    timeout_seconds=900,
                    poll_seconds=args.poll_seconds,
                    on_poll=lambda item: print(f"shutdown poll status={item.get('status')}"),
                )
                print("instance stopped")
            except Exception as exc:
                print(f"WARNING: shutdown did not complete automatically: {exc}", file=sys.stderr)


if __name__ == "__main__":
    raise SystemExit(main())
