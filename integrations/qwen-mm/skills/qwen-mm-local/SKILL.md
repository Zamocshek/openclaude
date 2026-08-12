---
name: qwen-mm-local
description: Use local Qwen3-VL through the portable Qwen-MM tool layer for image and video understanding, OCR, object grounding, cropping, visualization, and visual evidence without sending media to a cloud API.
compatibility: openclaude hermes opencode openclaw codex
metadata:
  category: multimodal
  provider: ollama
  model: qwen3-vl:2b-instruct
---

# Qwen-MM local vision

Use this skill whenever the active coordinator cannot inspect visual input
directly or a task needs OCR, grounding, frame extraction, or visual evidence.

## Workflow

1. Inspect metadata with `qwen-mm-core.media_info` when dimensions, duration,
   or codec details matter.
2. For an image, call `qwen-mm-local.vision_chat`, `ocr`, or `grounding` with
   the absolute local path and a precise question.
3. For a video, use `qwen-mm-core.read_video` to select representative frames,
   save views when needed, then inspect those frame paths with
   `qwen-mm-local.vision_chat`.
4. Use `crop` or `draw_bbox` only when a region or annotated artifact improves
   verification. Register resulting files with `openclaude-artifact` when the
   user needs them returned.
5. Give the coordinator compact textual evidence: visible text, objects,
   locations, uncertainty, and source paths.

## Invariants

- Never send raw binary image tool output to a text-only coordinator. Use the
  local Qwen vision tools and pass their textual evidence instead.
- Never infer image contents from filenames, captions, or prior conversation.
- The endpoint and model are injected by the local facade. Do not request a
  cloud endpoint, API key, or another model.
- One failed visual tool call may be retried once with a smaller image, a
  focused crop, or a clearer prompt. Then report the exact limitation.
- Qwen-MM is lazy-routed. Do not load it for text-only work.
