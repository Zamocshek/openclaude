import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'

import { getAgentGatewayConfigPath, getAgentGatewayStateDir } from './config.js'
import { resolveEffectiveMcpConfigPath } from './mcpRegistry.js'

const CURRENT_FILE = fileURLToPath(import.meta.url)
const CONTROL_MCP_CONFIG_FILE = 'gateway-control.mcp.json'
const CONTROL_MCP_NAME = 'gateway-control'

type McpConfig = {
  mcpServers?: Record<string, unknown>
}

/**
 * Adds the Gateway's own control server to the effective MCP configuration.
 * This exposes routing controls as real model tools instead of requiring the
 * Telegram bridge to infer configuration changes from user phrasing.
 */
export function prepareGatewayControlMcpConfig(projectRoot: string): string | undefined {
  const scriptPath = resolveGatewayControlMcpScriptPath()
  if (!scriptPath) return resolveEffectiveMcpConfigPath(projectRoot)

  const sourcePath = resolveEffectiveMcpConfigPath(projectRoot)
  const source = readMcpConfig(sourcePath)
  const mcpServers = { ...(source.mcpServers || {}) }
  mcpServers[CONTROL_MCP_NAME] = {
    command: process.execPath,
    args: [scriptPath],
    env: {
      OPENCLAUDE_AGENT_GATEWAY_CONFIG_PATH: getAgentGatewayConfigPath(),
      OPENCLAUDE_AGENT_GATEWAY_STATE_DIR: getAgentGatewayStateDir(),
    },
  }

  const stateDir = getAgentGatewayStateDir()
  const outputPath = join(stateDir, CONTROL_MCP_CONFIG_FILE)
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(outputPath, `${JSON.stringify({ mcpServers }, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  })
  chmodSync(outputPath, 0o600)
  return outputPath
}

function readMcpConfig(path: string | undefined): McpConfig {
  if (!path || !existsSync(path)) return {}
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const mcpServers = (parsed as McpConfig).mcpServers
    return mcpServers && typeof mcpServers === 'object' && !Array.isArray(mcpServers)
      ? { mcpServers }
      : {}
  } catch {
    return {}
  }
}

function resolveGatewayControlMcpScriptPath(): string | undefined {
  const candidates = [
    process.env.OPENCLAUDE_GATEWAY_CONTROL_MCP_SCRIPT,
    '/app/scripts/gateway-control-mcp.mjs',
    resolve(process.cwd(), 'scripts', 'gateway-control-mcp.mjs'),
    resolve(dirname(CURRENT_FILE), '../../../scripts/gateway-control-mcp.mjs'),
  ].filter((candidate): candidate is string => Boolean(candidate))
  return candidates.find(candidate => existsSync(candidate))
}
