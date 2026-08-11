# Local transcription

Agent-neutral speech-to-text adapter backed by `faster-whisper`. It accepts an
audio file and writes a UTF-8 transcript without requiring a provider API key.

```bash
python -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python transcribe.py --health
.venv/bin/python transcribe.py --input message.ogg --output message.txt --model base
```

The Docker image exposes the adapter as `openclaude-transcribe`. Other agents
can use the same executable contract or copy this directory independently.
Models are cached under `OPENCLAUDE_TRANSCRIPTION_CACHE_DIR`. Device,
compute type, language, and beam size are configurable with the corresponding
`OPENCLAUDE_TRANSCRIPTION_*` environment variables.
