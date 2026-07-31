import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'

import { getAgentGatewayConfigPath, getAgentGatewayStateDir } from './config.js'
import { resolveEffectiveMcpConfigPath } from './mcpRegistry.js'

const CURRENT_FILE = fileURLToPath(import.meta.url)
const CONTROL_MCP_CONFIG_FILE = 'gateway-control.mcp.json'
const PENTEST_MCP_CONFIG_FILE = 'gateway-pentest.mcp.json'
const DISABLED_MCP_CONFIG_FILE = 'gateway-tools-disabled.mcp.json'
const CONTROL_MCP_NAME = 'gateway-control'
const PENTEST_MCP_ALLOWLIST = new Set(['pentest', 'codegraph'])

type McpConfig = {
  mcpServers?: Record<string, unknown>
}

/**
 * Adds the Gateway's own control server to the effective MCP configuration.
 * This exposes routing controls as real model tools instead of requiring the
 * Telegram bridge to infer configuration changes from user phrasing.
 */
export function prepareGatewayControlMcpConfig(
  projectRoot: string,
  profile: 'default' | 'pentest' | 'disabled' = 'default',
): string | undefined {
  const scriptPath = resolveGatewayControlMcpScriptPath()
  const sourcePath = resolveEffectiveMcpConfigPath(projectRoot)
  const source = readMcpConfig(sourcePath)
  const sourceServers = source.mcpServers || {}
  const mcpServers = profile === 'disabled'
    ? {}
    : profile === 'pentest'
      ? Object.fromEntries(
          Object.entries(sourceServers)
            .filter(([name]) => PENTEST_MCP_ALLOWLIST.has(name)),
        )
      : { ...sourceServers }

  if (profile === 'default' && scriptPath) {
    const gatewayApiKey =
      process.env.OPENCLAUDE_AGENT_API_KEY?.trim() || ''
    mcpServers[CONTROL_MCP_NAME] = {
      command: process.execPath,
      args: [scriptPath],
      env: {
        OPENCLAUDE_AGENT_GATEWAY_CONFIG_PATH: getAgentGatewayConfigPath(),
        OPENCLAUDE_AGENT_GATEWAY_STATE_DIR: getAgentGatewayStateDir(),
        OPENCLAUDE_AGENT_GATEWAY_URL:
          process.env.OPENCLAUDE_AGENT_GATEWAY_URL
          || `http://127.0.0.1:${process.env.OPENCLAUDE_AGENT_API_PORT || '8642'}`,
        ...(gatewayApiKey
          ? { OPENCLAUDE_AGENT_API_KEY: gatewayApiKey }
          : {}),
      },
    }
  } else if (profile === 'default' && !scriptPath) {
    return sourcePath
  }

  const stateDir = getAgentGatewayStateDir()
  const outputPath = join(
    stateDir,
    profile === 'pentest'
      ? PENTEST_MCP_CONFIG_FILE
      : profile === 'disabled'
        ? DISABLED_MCP_CONFIG_FILE
        : CONTROL_MCP_CONFIG_FILE,
  )
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
