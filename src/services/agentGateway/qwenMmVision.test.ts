import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  inspectImagesWithLocalQwen,
  isLocalQwenMmEnabled,
  resolveLocalQwenMmEndpoint,
} from './qwenMmVision.js'

const temporaryPaths: string[] = []

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map(path =>
    rm(path, { recursive: true, force: true })
  ))
})

describe('local Qwen-MM vision adapter', () => {
  test('uses local defaults and supports an explicit off switch', () => {
    expect(resolveLocalQwenMmEndpoint({})).toMatchObject({
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: 'qwen3-vl:2b-instruct',
      apiKey: 'ollama-local',
    })
    expect(isLocalQwenMmEnabled({})).toBe(true)
    expect(isLocalQwenMmEnabled({ OPENCLAUDE_QWEN_MM_ENABLED: 'off' })).toBe(false)
  })

  test('sends image data to the local OpenAI-compatible endpoint', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'qwen-mm-vision-'))
    temporaryPaths.push(directory)
    const imagePath = join(directory, 'sample.png')
    await writeFile(imagePath, Buffer.from('89504e470d0a1a0a', 'hex'))
    let requestBody: Record<string, unknown> | undefined

    const result = await inspectImagesWithLocalQwen({
      imagePaths: [imagePath],
      prompt: 'Read the label.',
      env: {
        QWEN_MM_BASE_URL: 'http://ollama.test/v1/',
        QWEN_MM_MODEL: 'local-vision',
      },
      fetchImpl: (async (url, init) => {
        expect(String(url)).toBe('http://ollama.test/v1/chat/completions')
        requestBody = JSON.parse(String(init?.body))
        return new Response(JSON.stringify({
          choices: [{ message: { content: 'Visible label: TEST' } }],
        }), { status: 200 })
      }) as typeof fetch,
    })

    expect(result).toBe('Visible label: TEST')
    expect(requestBody?.model).toBe('local-vision')
    expect(JSON.stringify(requestBody)).toContain('data:image/png;base64,')
    expect(JSON.stringify(requestBody)).toContain('Read the label.')
  })
})
