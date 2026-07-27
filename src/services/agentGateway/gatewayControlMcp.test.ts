import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

import { prepareGatewayControlMcpConfig } from './gatewayControlMcp.js'

const temporaryPaths: string[] = []

afterEach(async () => {
  delete process.env.OPENCLAUDE_AGENT_GATEWAY_STATE_DIR
  await Promise.all(temporaryPaths.splice(0).map(path =>
    rm(path, { recursive: true, force: true })
  ))
})

describe('gateway control MCP configuration', () => {
  test('merges a private gateway-control MCP server into the effective config', async () => {
    const project = await mkdtemp(join(tmpdir(), 'openclaude-gateway-control-project-'))
    const state = await mkdtemp(join(tmpdir(), 'openclaude-gateway-control-state-'))
    temporaryPaths.push(project, state)
    process.env.OPENCLAUDE_AGENT_GATEWAY_STATE_DIR = state
    await writeFile(join(project, '.mcp.json'), JSON.stringify({
      mcpServers: { existing: { command: 'node', args: ['existing.mjs'] } },
    }))

    const generatedPath = prepareGatewayControlMcpConfig(project)
    expect(generatedPath).toBe(join(state, 'gateway-control.mcp.json'))
    const generated = JSON.parse(await readFile(generatedPath!, 'utf8'))
    expect(generated.mcpServers.existing).toBeTruthy()
    expect(generated.mcpServers['gateway-control']).toMatchObject({
      command: process.execPath,
      env: {
        OPENCLAUDE_AGENT_GATEWAY_STATE_DIR: state,
      },
    })
    expect(JSON.stringify(generated)).not.toContain('DEEPSEEK_API_KEY')
  })
})
