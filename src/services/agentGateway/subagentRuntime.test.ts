import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

import { getDefaultAgentGatewayConfig, normalizeAgentGatewayConfig } from './config.js'
import {
  buildGatewaySubagentAppendPrompt,
  prepareGatewaySubagentRuntime,
} from './subagentRuntime.js'

const originalStateDir = process.env.OPENCLAUDE_AGENT_GATEWAY_STATE_DIR
const stateDirs: string[] = []

afterEach(async () => {
  if (originalStateDir === undefined) delete process.env.OPENCLAUDE_AGENT_GATEWAY_STATE_DIR
  else process.env.OPENCLAUDE_AGENT_GATEWAY_STATE_DIR = originalStateDir
  await Promise.all(stateDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

describe('gateway subagent runtime', () => {
  test('writes provider routing to a protected settings file without exposing the key in agent definitions', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'openclaude-subagents-'))
    stateDirs.push(stateDir)
    process.env.OPENCLAUDE_AGENT_GATEWAY_STATE_DIR = stateDir
    const defaults = getDefaultAgentGatewayConfig()
    const config = normalizeAgentGatewayConfig({
      ...defaults,
      subagents: {
        enabled: true,
        maxParallel: 2,
        routes: {
          'gateway-explore': {
            provider: 'deepseek',
            model: 'deepseek-v4-flash',
            baseUrl: 'https://api.deepseek.com/v1',
            apiKeyEnv: 'DEEPSEEK_API_KEY',
          },
        },
      },
    })

    const runtime = prepareGatewaySubagentRuntime(config, {
      DEEPSEEK_API_KEY: 'test-deepseek-secret',
    })

    expect(runtime).toBeDefined()
    expect(runtime?.roles).toEqual([
      { name: 'gateway-explore', provider: 'deepseek', model: 'deepseek-v4-flash' },
    ])
    expect(runtime?.agentsJson).not.toContain('test-deepseek-secret')
    const settings = JSON.parse(await readFile(runtime!.settingsPath, 'utf8'))
    expect(settings.agentModels['deepseek-v4-flash']).toEqual({
      base_url: 'https://api.deepseek.com/v1',
      api_key: 'test-deepseek-secret',
    })
    expect(settings.agentRouting['gateway-explore']).toBe('deepseek-v4-flash')

    const prompt = buildGatewaySubagentAppendPrompt(runtime, config.subagents.maxParallel)
    expect(prompt).toContain('at most 2 independent delegates')
    expect(prompt).toContain('gateway-explore: deepseek/deepseek-v4-flash')
  })

  test('does not expose unavailable routes to the coordinator', () => {
    const defaults = getDefaultAgentGatewayConfig()
    const config = normalizeAgentGatewayConfig({
      ...defaults,
      subagents: {
        enabled: true,
        maxParallel: 3,
        routes: {
          'gateway-review': {
            provider: 'deepseek',
            model: 'deepseek-v4-pro',
            baseUrl: 'https://api.deepseek.com/v1',
            apiKeyEnv: 'MISSING_KEY',
          },
        },
      },
    })

    expect(prepareGatewaySubagentRuntime(config, {})).toBeUndefined()
  })

  test('directs model-driven routing changes through the gateway-control MCP tools', () => {
    const defaults = getDefaultAgentGatewayConfig()
    const config = normalizeAgentGatewayConfig({
      ...defaults,
      subagents: {
        enabled: true,
        maxParallel: 3,
        routes: {
          'gateway-explore': {
            provider: 'deepseek',
            model: 'deepseek-v4-flash',
            baseUrl: 'https://api.deepseek.com/v1',
            apiKeyEnv: 'DEEPSEEK_API_KEY',
          },
        },
      },
    })
    const runtime = prepareGatewaySubagentRuntime(config, {
      DEEPSEEK_API_KEY: 'deepseek-test-key',
    })
    const prompt = buildGatewaySubagentAppendPrompt(runtime, config.subagents.maxParallel)

    expect(prompt).toContain('Use gateway-control for requested route changes')
    expect(prompt).toContain('applies to the next top-level run')
  })

  test('defines a read-only Codex vision specialist', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'openclaude-subagents-'))
    stateDirs.push(stateDir)
    process.env.OPENCLAUDE_AGENT_GATEWAY_STATE_DIR = stateDir
    const defaults = getDefaultAgentGatewayConfig()
    const config = normalizeAgentGatewayConfig({
      ...defaults,
      subagents: {
        enabled: true,
        maxParallel: 3,
        routes: {
          'gateway-vision': {
            provider: 'codex',
            model: 'gpt-5.6-sol?reasoning=medium',
            baseUrl: 'https://chatgpt.com/backend-api/codex',
            apiKeyEnv: 'CODEX_API_KEY',
          },
        },
      },
    })
    const runtime = prepareGatewaySubagentRuntime(config, {
      CODEX_API_KEY: 'codex-test-key',
    })

    expect(runtime?.roles).toEqual([{
      name: 'gateway-vision',
      provider: 'codex',
      model: 'gpt-5.6-sol?reasoning=medium',
    }])
    const agents = JSON.parse(runtime!.agentsJson)
    expect(agents['gateway-vision'].prompt).toContain('Read tool')
    expect(agents['gateway-vision'].prompt).toContain('observable visual evidence')
    expect(agents['gateway-vision'].disallowedTools).toContain('Edit')
    expect(agents['gateway-vision'].disallowedTools).toContain('Agent')
    expect(
      buildGatewaySubagentAppendPrompt(runtime, config.subagents.maxParallel),
    ).toContain('gateway-vision: codex/gpt-5.6-sol?reasoning=medium')
  })
})
