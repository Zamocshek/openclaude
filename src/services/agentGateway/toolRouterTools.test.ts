import { describe, expect, test } from 'bun:test'

import {
  describeRouterBuiltinTools,
  isRouterBuiltinToolName,
  updateRouterBuiltinToolState,
} from './toolRouterTools.js'

describe('Tool Router built-in tools', () => {
  test('describes global, allowlist, and denylist state', () => {
    const all = describeRouterBuiltinTools({
      disableTools: false,
      availableTools: [],
      disallowedTools: ['WebSearch'],
    })
    expect(all.find(tool => tool.name === 'Read')?.enabled).toBe(true)
    expect(all.find(tool => tool.name === 'WebSearch')?.enabled).toBe(false)

    const allowlisted = describeRouterBuiltinTools({
      disableTools: false,
      availableTools: ['Read'],
      disallowedTools: [],
    })
    expect(allowlisted.find(tool => tool.name === 'Read')?.enabled).toBe(true)
    expect(allowlisted.find(tool => tool.name === 'Edit')?.enabled).toBe(false)

    expect(describeRouterBuiltinTools({
      disableTools: true,
      availableTools: [],
      disallowedTools: [],
    }).every(tool => !tool.enabled)).toBe(true)
  })

  test('updates denylist state without losing an existing allowlist', () => {
    expect(updateRouterBuiltinToolState({
      disableTools: false,
      availableTools: ['Read'],
      disallowedTools: ['WebSearch'],
    }, 'WebSearch', true)).toEqual({
      availableTools: ['Read', 'WebSearch'],
      disallowedTools: [],
    })
    expect(updateRouterBuiltinToolState({
      disableTools: false,
      availableTools: [],
      disallowedTools: [],
    }, 'Bash', false)).toEqual({
      availableTools: [],
      disallowedTools: ['Bash'],
    })
    expect(isRouterBuiltinToolName('Bash')).toBe(true)
    expect(isRouterBuiltinToolName('NotARealTool')).toBe(false)
  })
})
