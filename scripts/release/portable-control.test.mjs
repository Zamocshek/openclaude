import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import {
  hasRequiredTelegramRepositoryFiles,
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
    expect(env).toContain('OPENCLAUDE_LIGHTRAG_ENABLED=1')
    expect(env).toContain('LIGHTRAG_LLM_BINDING_HOST=http://lightrag-ollama-adapter:11435')
    expect(env).toContain('LIGHTRAG_LLM_MODEL=qwen3-lightrag:1.7b')
    expect(env).toContain('LIGHTRAG_EMBEDDING_BINDING_HOST=http://lightrag-ollama:11434')
    expect(env).toContain('LIGHTRAG_EMBEDDING_MODEL=nomic-embed-text:latest')
    expect(env).toContain('OPENCLAUDE_DOCKER_LIGHTRAG_URL=http://lightrag:9621')
    expect(env).toContain('OPENCLAUDE_DOCKER_HINDSIGHT_URL=http://openclaude-hindsight:8888')
    expect(env).toContain('OPENCLAUDE_SHARED_DOCKER_NETWORK=openclaude_default')
  })

  test('ships Telegram MCP source and its required skills in the repository', () => {
    expect(hasRequiredTelegramRepositoryFiles()).toBe(true)
  })

  test('updates a dotenv setting without creating duplicate active values', () => {
    expect(upsertEnvValue('A=1\nB=2\n', 'A', '3')).toBe('A=3\nB=2\n')
    expect(upsertEnvValue('A=1\n', 'B', '2')).toBe('A=1\nB=2\n')
  })
})
