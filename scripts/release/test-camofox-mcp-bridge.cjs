#!/usr/bin/env node

const { resolve } = require('node:path')

const CALL_TIMEOUT_MS = 45_000
const QWEN_USER_ID = 'nova-qwen-max'

function textContent(result) {
  return (result.content || [])
    .filter(item => item.type === 'text')
    .map(item => item.text || '')
    .join('\n')
}

function withTimeout(promise, label) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${label} timed out`)),
        CALL_TIMEOUT_MS,
      )
    }),
  ]).finally(() => clearTimeout(timer))
}

async function main() {
  const { Client } = await import(
    '@modelcontextprotocol/sdk/client/index.js'
  )
  const { StdioClientTransport } = await import(
    '@modelcontextprotocol/sdk/client/stdio.js'
  )
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve('scripts/release/camofox-mcp-bridge.cjs')],
    env: {
      ...process.env,
      CAMOFOX_URL: process.env.CAMOFOX_URL || 'http://127.0.0.1:9377',
    },
    stderr: 'pipe',
  })
  const client = new Client({
    name: 'camofox-bridge-smoke',
    version: '0.1.0',
  })

  try {
    await withTimeout(client.connect(transport), 'Camofox MCP connect')
    const tools = await withTimeout(
      client.listTools(),
      'Camofox MCP listTools',
    )
    const names = tools.tools.map(tool => tool.name)
    for (const expected of [
      'camofox_health',
      'camofox_list_tabs',
      'camofox_checkpoint_session',
      'camofox_list_model_profiles',
      'camofox_open_model_profile',
      'camofox_checkpoint_model_profile',
    ]) {
      if (!names.includes(expected)) {
        throw new Error(`Camofox MCP is missing ${expected}`)
      }
    }

    const profiles = await withTimeout(
      client.callTool({
        name: 'camofox_list_model_profiles',
        arguments: {},
      }),
      'Camofox list browser model profiles',
    )
    const profilesText = textContent(profiles)
    if (
      profiles.isError ||
      !profilesText.includes('"qwen"') ||
      !profilesText.includes('"chatgpt"')
    ) {
      throw new Error(
        `Camofox browser model profiles failed: ${profilesText}`,
      )
    }

    const health = await withTimeout(
      client.callTool({
        name: 'camofox_health',
        arguments: {},
      }),
      'Camofox health',
    )
    if (health.isError || !textContent(health).includes('"ok": true')) {
      throw new Error(`Camofox health failed: ${textContent(health)}`)
    }

    const tabs = await withTimeout(
      client.callTool({
        name: 'camofox_list_tabs',
        arguments: { userId: QWEN_USER_ID },
      }),
      'Camofox list tabs',
    )
    const tabsText = textContent(tabs)
    if (tabs.isError || !tabsText.includes('chat.qwen.ai')) {
      throw new Error(`Qwen navigator tab is missing: ${tabsText}`)
    }

    const checkpoint = await withTimeout(
      client.callTool({
        name: 'camofox_checkpoint_session',
        arguments: { userId: QWEN_USER_ID },
      }),
      'Camofox checkpoint',
    )
    if (
      checkpoint.isError ||
      !textContent(checkpoint).includes('"ok": true')
    ) {
      throw new Error(
        `Camofox checkpoint failed: ${textContent(checkpoint)}`,
      )
    }

    console.log('CAMOFOX_BROWSER_MODELS_MCP_SMOKE_OK')
  } finally {
    await client.close().catch(() => {})
  }
}

main().catch(error => {
  console.error(error?.stack || error?.message || error)
  process.exit(1)
})
