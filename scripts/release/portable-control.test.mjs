import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import {
  initializePortableLayout,
  portableDirectories,
  renderPortableDefaults,
  upsertEnvValue,
} from './portable-control.mjs'

describe('portable control', () => {
  test('creates a repository-local persistent layout without credentials', () => {
    const root = mkdtempSync(join(tmpdir(), 'openclaude-portable-'))
    try {
      const result = initializePortableLayout(root)
      expect(result.created).toBe(true)
      for (const directory of portableDirectories(root)) {
        expect(existsSync(directory)).toBe(true)
      }
      const env = readFileSync(join(root, '.env'), 'utf8')
      expect(env).toContain('OPENCLAUDE_HOST_CONFIG_DIR=./.openclaude-data/config')
      expect(env).toContain('OPENCLAUDE_DOCKER_PROVIDER=ollama')
      expect(env).not.toContain('TELEGRAM_BOT_TOKEN=')
      expect(initializePortableLayout(root).created).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('ships reproducible local model and integration defaults', () => {
    const env = renderPortableDefaults()
    expect(env).toContain('OPENCLAUDE_BOOTSTRAP_OLLAMA_MODEL=qwen3:1.7b')
    expect(env).toContain('OPENCLAUDE_BOOTSTRAP_EMBEDDING_MODEL=nomic-embed-text:latest')
    expect(env).toContain('OPENCLAUDE_OPENRAG_VERSION=0.5.1')
    expect(env).toContain('OPENCLAUDE_OPENRAG_ENABLED=0')
    expect(env).toContain('OPENCLAUDE_OPENRAG_OLLAMA_ENDPOINT=http://openclaude-ollama:11434')
    expect(env).toContain('OPENCLAUDE_DOCKER_OPENRAG_URL=http://openrag-frontend:3000')
    expect(env).toContain('OPENCLAUDE_DOCKER_HINDSIGHT_URL=http://openclaude-hindsight:8888')
    expect(env).toContain('OPENCLAUDE_SHARED_DOCKER_NETWORK=openclaude_default')
  })

  test('updates a dotenv setting without creating duplicate active values', () => {
    expect(upsertEnvValue('A=1\nB=2\n', 'A', '3')).toBe('A=3\nB=2\n')
    expect(upsertEnvValue('A=1\n', 'B', '2')).toBe('A=1\nB=2\n')
  })
})
