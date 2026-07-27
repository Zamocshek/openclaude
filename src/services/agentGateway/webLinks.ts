import type { AgentGatewayConfig } from './config.js'

export type AgentGatewayWebLinks = {
  toolRouter: string
  openWebUI: string
  hindsight: string
  openRAG: string
}

export function getAgentGatewayWebLinks(
  config: Pick<AgentGatewayConfig, 'api' | 'openWebUI' | 'openRAG'>,
): AgentGatewayWebLinks {
  return {
    toolRouter: publicUrl(
      process.env.OPENCLAUDE_ROUTER_PUBLIC_URL,
      `http://${publicHost(config.api.host)}:${process.env.OPENCLAUDE_AGENT_API_HOST_PORT || config.api.port}/router`,
    ),
    openWebUI: publicUrl(
      process.env.OPENCLAUDE_OPEN_WEBUI_PUBLIC_URL,
      `http://${publicHost(config.openWebUI.host)}:${process.env.OPENCLAUDE_OPEN_WEBUI_HOST_PORT || config.openWebUI.port}`,
    ),
    hindsight: publicUrl(
      process.env.HINDSIGHT_PUBLIC_URL,
      process.env.HINDSIGHT_URL || 'http://localhost:8888',
    ),
    openRAG: publicUrl(
      process.env.OPENRAG_PUBLIC_URL,
      process.env.OPENRAG_URL || config.openRAG.url,
    ),
  }
}

function publicUrl(value: string | undefined, fallback: string): string {
  const candidate = (value || fallback).trim()
  try {
    const parsed = new URL(candidate)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return fallback
    }
    parsed.hostname = publicHost(parsed.hostname)
    return parsed.toString().replace(/\/$/u, '')
  } catch {
    return fallback
  }
}

function publicHost(host: string): string {
  const normalized = host.trim().toLowerCase()
  if (
    !normalized ||
    normalized === '0.0.0.0' ||
    normalized === '::' ||
    normalized === 'host.docker.internal'
  ) {
    return 'localhost'
  }
  return host
}
