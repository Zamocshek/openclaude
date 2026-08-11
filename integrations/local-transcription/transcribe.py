#!/opt/openclaude-stt/bin/python
"""Portable local speech-to-text CLI used by any agent runtime."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import shutil
import sys


def parser() -> argparse.ArgumentParser:
    cli = argparse.ArgumentParser(description="Local faster-whisper transcription")
    cli.add_argument("--health", action="store_true")
    cli.add_argument("--input", type=Path)
    cli.add_argument("--output", type=Path)
    cli.add_argument("--model", default=os.getenv("OPENCLAUDE_TRANSCRIPTION_MODEL", "base"))
    cli.add_argument("--language", default=os.getenv("OPENCLAUDE_TRANSCRIPTION_LANGUAGE") or None)
    return cli


def health() -> int:
    try:
        import faster_whisper  # noqa: F401
    except Exception as exc:  # pragma: no cover - exercised by deployment smoke tests
        print(json.dumps({"ok": False, "error": str(exc)}))
        return 1
    print(json.dumps({
        "ok": True,
        "provider": "faster-whisper",
        "ffmpeg": shutil.which("ffmpeg"),
    }))
    return 0


def transcribe(args: argparse.Namespace) -> int:
    if args.input is None or args.output is None:
        raise ValueError("--input and --output are required")
    if not args.input.is_file():
        raise FileNotFoundError(f"audio file does not exist: {args.input}")

    from faster_whisper import WhisperModel

    cache_dir = Path(os.getenv(
        "OPENCLAUDE_TRANSCRIPTION_CACHE_DIR",
        str(Path.home() / ".cache" / "openclaude" / "faster-whisper"),
    ))
    cache_dir.mkdir(parents=True, exist_ok=True)
    model = WhisperModel(
        args.model,
        device=os.getenv("OPENCLAUDE_TRANSCRIPTION_DEVICE", "cpu"),
        compute_type=os.getenv("OPENCLAUDE_TRANSCRIPTION_COMPUTE_TYPE", "int8"),
        download_root=str(cache_dir),
    )
    segments, info = model.transcribe(
        str(args.input),
        language=args.language,
        vad_filter=True,
        beam_size=max(1, int(os.getenv("OPENCLAUDE_TRANSCRIPTION_BEAM_SIZE", "5"))),
    )
    text = " ".join(segment.text.strip() for segment in segments if segment.text.strip()).strip()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(text, encoding="utf-8")
    print(json.dumps({
        "ok": True,
        "provider": "faster-whisper",
        "model": args.model,
        "language": getattr(info, "language", args.language),
        "output": str(args.output),
        "characters": len(text),
    }, ensure_ascii=False))
    return 0


def main() -> int:
    args = parser().parse_args()
    if args.health:
        return health()
    try:
        return transcribe(args)
    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
