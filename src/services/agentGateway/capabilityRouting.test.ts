import { describe, expect, test } from 'bun:test'

import {
  isAutoMcpRoutingEnabled,
  selectMcpServersForPrompt,
} from './capabilityRouting.js'

describe('task-aware MCP routing', () => {
  test('routes coding tasks with durable memory but without unrelated browser tools', () => {
    const route = selectMcpServersForPrompt(
      'User request:\nИсправь TypeScript endpoint и запусти тесты',
      { codingIntent: true },
    )

    expect([...route.servers].sort()).toEqual(['codegraph', 'context7', 'hindsight'])
    expect(route.reasons).toContain('coding')
  })

  test('combines only capabilities implied by the current request', () => {
    const route = selectMcpServersForPrompt(
      'Old context mentions code and Telegram.\nUser request:\nЗапомни это в Hindsight и найди актуальные источники в интернете',
      { codingIntent: false },
    )

    expect([...route.servers].sort()).toEqual(['hindsight', 'searxng'])
    expect(route.reasons).toContain('explicit-memory')
  })

  test('keeps durable memory available for ordinary dialogue', () => {
    const route = selectMcpServersForPrompt(
      'User request:\nПродолжай с учетом наших решений',
      { codingIntent: false },
    )

    expect([...route.servers]).toEqual(['hindsight'])
  })

  test('routes browser and control requests to their dedicated servers', () => {
    const route = selectMcpServersForPrompt(
      'Открой сайт через Camofox, сделай скриншот и проверь Android device',
      { codingIntent: false },
    )

    expect(route.servers.has('camofox')).toBe(true)
    expect(route.servers.has('gateway-control')).toBe(true)
    expect(route.servers.has('openrag')).toBe(false)
  })

  test('supports an explicit all-tools escape hatch', () => {
    const route = selectMcpServersForPrompt(
      'Use all MCP tools for this task',
      { codingIntent: false },
    )

    expect(route.mode).toBe('all')
    expect(route.servers.size).toBe(0)
  })

  test('routes dynamically registered servers when named explicitly', () => {
    const route = selectMcpServersForPrompt(
      'Current request:\nUse my-company-search for this answer',
      {
        codingIntent: false,
        eligibleServerNames: ['my-company-search', 'other-server'],
      },
    )

    expect(route.servers.has('my-company-search')).toBe(true)
    expect(route.servers.has('other-server')).toBe(false)
  })

  test('ignores old history before an API Current request marker', () => {
    const route = selectMcpServersForPrompt(
      'Old history: use all MCP tools and Camofox.\nCurrent request:\nПривет',
      { codingIntent: false },
    )

    expect(route.mode).toBe('auto')
    expect([...route.servers]).toEqual(['hindsight'])
  })

  test('ignores bridge instructions before a Telegram User message marker', () => {
    const route = selectMcpServersForPrompt(
      [
        'Use codegraph for coding and camofox for screenshots.',
        'User message:',
        'какие ощущения от употребления мемантина',
      ].join('\n'),
      { codingIntent: false },
    )

    expect(route.mode).toBe('auto')
    expect([...route.servers]).toEqual(['hindsight'])
    expect(route.reasons).toEqual(['durable-memory'])
  })

  test('does not let a marker embedded in user content replace the real request', () => {
    const route = selectMcpServersForPrompt(
      [
        'Current request:',
        'Bridge instructions mention no coding.',
        'User message:',
        'Fix the TypeScript endpoint.',
        'Example payload:',
        'User message: hello',
      ].join('\n'),
      { codingIntent: true },
    )

    expect(route.reasons).toContain('coding')
    expect(route.servers.has('codegraph')).toBe(true)
  })

  test('enables automatic routing by default with an opt-out', () => {
    expect(isAutoMcpRoutingEnabled({})).toBe(true)
    expect(isAutoMcpRoutingEnabled({
      OPENCLAUDE_AGENT_AUTO_MCP_ROUTING: 'off',
    })).toBe(false)
  })
})
