import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, stat, utimes } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  hasVisionInputReference,
  materializeVisionInput,
} from './vision.js'

const ONE_PIXEL_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='

describe('gateway vision input', () => {
  test('materializes OpenAI chat image_url data into a protected local image', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'openclaude-vision-'))
    try {
      const result = await materializeVisionInput([
        {
          role: 'user',
          content: [
            { type: 'text', text: 'What is shown?' },
            {
              type: 'image_url',
              image_url: { url: `data:image/png;base64,${ONE_PIXEL_PNG}` },
            },
          ],
        },
      ], { stateDir })

      expect(result.imagePaths).toHaveLength(1)
      expect(result.warnings).toEqual([])
      expect((await readFile(result.imagePaths[0]!)).subarray(0, 8)).toEqual(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      )
      const content = (result.value as Array<{
        content: Array<{ text?: string }>
      }>)[0]!.content
      const reference = content[1]?.text || ''
      expect(reference).toContain('[Vision input]')
      expect(reference).toContain(`local_path: ${result.imagePaths[0]}`)
      expect(reference).toContain('gateway-vision')
      expect(reference).not.toContain('prompt_reference:')
      expect(reference).not.toContain(`@${result.imagePaths[0]}`)
      expect(hasVisionInputReference(reference)).toBe(true)
    } finally {
      await rm(stateDir, { recursive: true, force: true })
    }
  })

  test('supports Responses input_image and deduplicates identical bytes', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'openclaude-vision-'))
    try {
      const input = [{
        role: 'user',
        content: [
          { type: 'input_text', text: 'Compare these.' },
          { type: 'input_image', image_url: `data:image/png;base64,${ONE_PIXEL_PNG}` },
          { type: 'input_image', image_url: `data:image/png;base64,${ONE_PIXEL_PNG}` },
        ],
      }]
      const result = await materializeVisionInput(input, { stateDir })

      expect(result.imagePaths).toHaveLength(1)
      const content = (result.value as Array<{
        content: Array<{ type: string; text?: string }>
      }>)[0]!.content
      expect(content[1]?.type).toBe('input_text')
      expect(content[2]?.text).toContain(result.imagePaths[0]!)
    } finally {
      await rm(stateDir, { recursive: true, force: true })
    }
  })

  test('does not fetch remote URLs and rejects forged image bytes', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'openclaude-vision-'))
    try {
      const result = await materializeVisionInput([
        { type: 'image_url', image_url: { url: 'https://example.com/image.png' } },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,bm90LXBuZw==' } },
      ], { stateDir })

      expect(result.imagePaths).toEqual([])
      expect(result.warnings).toContain('remote image URL was not downloaded by the gateway')
      expect(result.warnings.some(warning =>
        warning.includes('do not match declared MIME type'),
      )).toBe(true)
    } finally {
      await rm(stateDir, { recursive: true, force: true })
    }
  })

  test('prunes expired materialized images on the next request', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'openclaude-vision-'))
    try {
      const first = await materializeVisionInput(
        [{ type: 'image_url', image_url: `data:image/png;base64,${ONE_PIXEL_PNG}` }],
        { stateDir, now: 1_000_000 },
      )
      const old = new Date(1000)
      await utimes(first.imagePaths[0]!, old, old)

      await materializeVisionInput(
        [{ type: 'image_url', image_url: 'https://example.com/new.png' }],
        {
        stateDir,
        now: 10_000_000,
        env: { OPENCLAUDE_VISION_RETENTION_MS: '60000' },
        },
      )

      await expect(stat(first.imagePaths[0]!)).rejects.toThrow()
    } finally {
      await rm(stateDir, { recursive: true, force: true })
    }
  })
})
