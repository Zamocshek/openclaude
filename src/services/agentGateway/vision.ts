import { createHash } from 'crypto'
import { mkdir, readdir, stat, unlink, writeFile } from 'fs/promises'
import { join } from 'path'

import { getAgentGatewayStateDir } from './config.js'

const DEFAULT_MAX_IMAGE_BYTES = 20 * 1024 * 1024
const DEFAULT_MAX_IMAGES = 8
const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000
const VISION_INPUT_MARKER = '[Vision input]'

const IMAGE_TYPES = new Map([
  ['image/png', { extension: '.png', signature: isPng }],
  ['image/jpeg', { extension: '.jpg', signature: isJpeg }],
  ['image/jpg', { extension: '.jpg', signature: isJpeg }],
  ['image/webp', { extension: '.webp', signature: isWebp }],
  ['image/gif', { extension: '.gif', signature: isGif }],
])

export type MaterializedVisionInput = {
  value: unknown
  imagePaths: string[]
  warnings: string[]
}

type VisionMaterializeOptions = {
  stateDir?: string
  env?: NodeJS.ProcessEnv
  now?: number
}

type ImageSource =
  | { kind: 'data'; value: string }
  | { kind: 'remote'; value: string }

export async function materializeVisionInput(
  value: unknown,
  options: VisionMaterializeOptions = {},
): Promise<MaterializedVisionInput> {
  if (!containsVisionSource(value)) {
    return { value, imagePaths: [], warnings: [] }
  }

  const env = options.env ?? process.env
  const stateDir = options.stateDir ?? getAgentGatewayStateDir()
  const outputDir = join(stateDir, 'vision-inputs')
  const maxBytes = boundedPositiveInteger(
    env.OPENCLAUDE_VISION_MAX_IMAGE_BYTES,
    DEFAULT_MAX_IMAGE_BYTES,
    1024,
    100 * 1024 * 1024,
  )
  const maxImages = boundedPositiveInteger(
    env.OPENCLAUDE_VISION_MAX_IMAGES,
    DEFAULT_MAX_IMAGES,
    1,
    64,
  )
  const retentionMs = boundedPositiveInteger(
    env.OPENCLAUDE_VISION_RETENTION_MS,
    DEFAULT_RETENTION_MS,
    60_000,
    90 * 24 * 60 * 60 * 1000,
  )
  const imagePaths: string[] = []
  const warnings: string[] = []
  let imageCount = 0

  await mkdir(outputDir, { recursive: true })
  await pruneVisionInputs(outputDir, (options.now ?? Date.now()) - retentionMs)

  const visit = async (current: unknown): Promise<unknown> => {
    if (Array.isArray(current)) {
      return Promise.all(current.map(visit))
    }
    if (!current || typeof current !== 'object') return current

    const record = current as Record<string, unknown>
    const source = extractImageSource(record)
    if (source) {
      imageCount += 1
      if (imageCount > maxImages) {
        const warning = `image ${imageCount} exceeds the per-request limit of ${maxImages}`
        warnings.push(warning)
        return imageReferencePart(record, `${VISION_INPUT_MARKER} unavailable: ${warning}.`)
      }

      if (source.kind === 'remote') {
        const url = source.value.slice(0, 2048)
        const warning = 'remote image URL was not downloaded by the gateway'
        warnings.push(warning)
        return imageReferencePart(
          record,
          `${VISION_INPUT_MARKER} remote_url: ${url}\n${warning}; use a browser-capable vision route or send a data URL.`,
        )
      }

      try {
        const saved = await saveDataImage(source.value, outputDir, maxBytes)
        imagePaths.push(saved.path)
        return imageReferencePart(
          record,
          [
            VISION_INPUT_MARKER,
            `local_path: ${saved.path}`,
            `mime_type: ${saved.mimeType}`,
            `size_bytes: ${saved.size}`,
            'Do not attach or read this image in the parent model. Delegate the exact local_path to gateway-vision and use the returned visual evidence.',
          ].join('\n'),
        )
      } catch (error) {
        const warning = safeError(error)
        warnings.push(warning)
        return imageReferencePart(
          record,
          `${VISION_INPUT_MARKER} unavailable: ${warning}.`,
        )
      }
    }

    const entries = await Promise.all(
      Object.entries(record).map(async ([key, nested]) => [key, await visit(nested)] as const),
    )
    return Object.fromEntries(entries)
  }

  return {
    value: await visit(value),
    imagePaths: [...new Set(imagePaths)],
    warnings,
  }
}

function containsVisionSource(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsVisionSource)
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  if (extractImageSource(record)) return true
  return Object.values(record).some(containsVisionSource)
}

export function hasVisionInputReference(prompt: string): boolean {
  return (
    prompt.includes(VISION_INPUT_MARKER)
    || /(?:^|\n)\s*-\s*type:\s*photo\s*(?:\n|$)/iu.test(prompt)
    || /(?:^|\n)\s*mime_type:\s*image\//iu.test(prompt)
  )
}

function extractImageSource(record: Record<string, unknown>): ImageSource | undefined {
  const type = String(record.type || '').toLowerCase()
  if (type === 'image_url' || type === 'input_image') {
    const raw = record.image_url
    const url = typeof raw === 'string'
      ? raw
      : raw && typeof raw === 'object'
        ? String((raw as Record<string, unknown>).url || '')
        : ''
    return classifyImageSource(url)
  }

  if (type === 'image' && record.source && typeof record.source === 'object') {
    const source = record.source as Record<string, unknown>
    if (source.type === 'base64' && source.media_type && source.data) {
      return {
        kind: 'data',
        value: `data:${String(source.media_type)};base64,${String(source.data)}`,
      }
    }
    if (source.type === 'url' && source.url) {
      return classifyImageSource(String(source.url))
    }
  }
  return undefined
}

function classifyImageSource(value: string): ImageSource | undefined {
  const trimmed = value.trim()
  if (!trimmed) return undefined
  if (trimmed.startsWith('data:')) return { kind: 'data', value: trimmed }
  if (/^https?:\/\//iu.test(trimmed)) return { kind: 'remote', value: trimmed }
  return undefined
}

function imageReferencePart(
  original: Record<string, unknown>,
  text: string,
): Record<string, unknown> {
  return {
    type: String(original.type || '').toLowerCase() === 'input_image'
      ? 'input_text'
      : 'text',
    text,
  }
}

async function saveDataImage(
  dataUrl: string,
  outputDir: string,
  maxBytes: number,
): Promise<{ path: string; mimeType: string; size: number }> {
  const match = dataUrl.match(/^data:([^;,]+)(?:;[^,]*)?;base64,([\s\S]*)$/iu)
  if (!match) throw new Error('image must be a base64 data URL')

  const mimeType = String(match[1] || '').toLowerCase()
  const imageType = IMAGE_TYPES.get(mimeType)
  if (!imageType) {
    throw new Error(`unsupported image MIME type: ${mimeType || 'unknown'}`)
  }

  const base64 = String(match[2] || '').replace(/\s+/gu, '')
  if (
    !base64
    || base64.length % 4 === 1
    || !/^[A-Za-z0-9+/]*={0,2}$/u.test(base64)
  ) {
    throw new Error('image contains invalid base64 data')
  }
  const estimatedBytes = Math.floor(base64.length * 3 / 4)
  if (estimatedBytes > maxBytes) {
    throw new Error(`image exceeds OPENCLAUDE_VISION_MAX_IMAGE_BYTES (${estimatedBytes} > ${maxBytes})`)
  }

  const buffer = Buffer.from(base64, 'base64')
  if (buffer.length === 0 || buffer.length > maxBytes) {
    throw new Error(`image exceeds OPENCLAUDE_VISION_MAX_IMAGE_BYTES (${buffer.length} > ${maxBytes})`)
  }
  if (!imageType.signature(buffer)) {
    throw new Error(`image bytes do not match declared MIME type ${mimeType}`)
  }

  const hash = createHash('sha256').update(buffer).digest('hex')
  const path = join(outputDir, `${hash}${imageType.extension}`)
  try {
    await writeFile(path, buffer, { flag: 'wx', mode: 0o600 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  return { path, mimeType, size: buffer.length }
}

async function pruneVisionInputs(directory: string, cutoff: number): Promise<void> {
  try {
    const entries = await readdir(directory, { withFileTypes: true })
    await Promise.all(entries.map(async entry => {
      if (!entry.isFile()) return
      const path = join(directory, entry.name)
      try {
        if ((await stat(path)).mtimeMs < cutoff) await unlink(path)
      } catch {
        // A concurrent request may have already removed the same stale file.
      }
    }))
  } catch {
    // Vision input cleanup is best effort and must not reject the API request.
  }
}

function boundedPositiveInteger(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < min) return fallback
  return Math.min(max, Math.floor(parsed))
}

function isPng(buffer: Buffer): boolean {
  return buffer.length >= 8 && buffer.subarray(0, 8).equals(
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  )
}

function isJpeg(buffer: Buffer): boolean {
  return buffer.length >= 3
    && buffer[0] === 0xff
    && buffer[1] === 0xd8
    && buffer[2] === 0xff
}

function isWebp(buffer: Buffer): boolean {
  return buffer.length >= 12
    && buffer.subarray(0, 4).toString('ascii') === 'RIFF'
    && buffer.subarray(8, 12).toString('ascii') === 'WEBP'
}

function isGif(buffer: Buffer): boolean {
  if (buffer.length < 6) return false
  const signature = buffer.subarray(0, 6).toString('ascii')
  return signature === 'GIF87a' || signature === 'GIF89a'
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
