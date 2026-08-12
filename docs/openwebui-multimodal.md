# OpenWebUI voice and local vision

OpenWebUI connects to the Agent Gateway through its OpenAI-compatible endpoint:

```text
OpenWebUI -> /v1/chat/completions -> Agent Gateway -> local Qwen-MM -> coordinator
```

The default Docker profile does not require a Qwen or speech API key:

- `qwen3-vl:2b-instruct` runs in the bundled Ollama service;
- OpenWebUI speech-to-text runs through its bundled local faster-whisper backend;
- text-to-speech uses the browser when no backend engine is selected;
- uploaded images and screen/camera frames are sent to the Agent Gateway as
  OpenAI-compatible `image_url` parts.

The gateway validates and materializes each image, asks local Qwen-MM for
visual evidence, and gives that evidence to the selected coordinating model.
This also lets text-only providers such as DeepSeek reason about an image.

## Voice with screen share

OpenWebUI's voice/video call interface offers camera and screen-share sources.
For screen share, the browser captures the current screen frame when a spoken
turn completes and sends that frame with the transcription. This is
turn-by-turn visual context, not continuous frame-by-frame video streaming.

1. Open `http://localhost:8080` (or the configured host port).
2. Select the `openclaude-agent` model.
3. Start voice/video mode and choose **Screen Share**.
4. Grant microphone and screen-capture permissions in the browser.
5. Speak a request that refers to the visible screen.

The first local Whisper or Qwen-MM request can be slower while models load.
CPU-only Qwen-VL inference is functional but is not real-time. A supported GPU
for Ollama is recommended for interactive screen analysis.

## Configuration

The production defaults are explicit so OpenWebUI upgrades do not silently
change the voice and image pipeline:

```dotenv
OPENCLAUDE_OPEN_WEBUI_STT_ENGINE=
OPENCLAUDE_OPEN_WEBUI_TTS_ENGINE=
OPENCLAUDE_OPEN_WEBUI_WHISPER_MODEL=base
OPENCLAUDE_OPEN_WEBUI_WHISPER_COMPUTE_TYPE=int8
OPENCLAUDE_OPEN_WEBUI_WHISPER_VAD_FILTER=True
OPENCLAUDE_OPEN_WEBUI_IMAGE_MAX_WIDTH=1280
OPENCLAUDE_OPEN_WEBUI_IMAGE_MAX_HEIGHT=1280
```

An empty STT engine selects local faster-whisper. An empty TTS engine keeps
speech output in the browser. The image bounds reduce screen-frame latency
while preserving enough detail for ordinary UI inspection and OCR. Increase
them when small text matters more than latency.

Qwen-MM can still be controlled globally with Telegram `/qwenmm on`,
`/qwenmm off`, and `/qwenmm status`. When it is disabled or unavailable, the
gateway retains its configured vision fallback instead of pretending that a
text-only model inspected the image.
