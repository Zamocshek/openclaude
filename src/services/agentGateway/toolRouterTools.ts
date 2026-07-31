export const ROUTER_BUILTIN_TOOLS = [
  { name: 'Read', group: 'Files' },
  { name: 'Edit', group: 'Files' },
  { name: 'Write', group: 'Files' },
  { name: 'Glob', group: 'Files' },
  { name: 'Grep', group: 'Files' },
  { name: 'NotebookEdit', group: 'Files' },
  { name: 'Bash', group: 'Execution' },
  { name: 'PowerShell', group: 'Execution' },
  { name: 'REPL', group: 'Execution' },
  { name: 'LSP', group: 'Execution' },
  { name: 'WebSearch', group: 'Research' },
  { name: 'WebFetch', group: 'Research' },
  { name: 'ToolSearch', group: 'Routing' },
  { name: 'Skill', group: 'Routing' },
  { name: 'Agent', group: 'Routing' },
  { name: 'TodoWrite', group: 'Planning' },
  { name: 'AskUserQuestion', group: 'Planning' },
  { name: 'TaskCreate', group: 'Tasks' },
  { name: 'TaskGet', group: 'Tasks' },
  { name: 'TaskList', group: 'Tasks' },
  { name: 'TaskOutput', group: 'Tasks' },
  { name: 'TaskStop', group: 'Tasks' },
  { name: 'TaskUpdate', group: 'Tasks' },
  { name: 'CronCreate', group: 'Scheduling' },
  { name: 'CronList', group: 'Scheduling' },
  { name: 'CronDelete', group: 'Scheduling' },
] as const

const ROUTER_BUILTIN_TOOL_NAMES = new Set<string>(
  ROUTER_BUILTIN_TOOLS.map(tool => tool.name),
)

export type RouterToolConfig = {
  disableTools: boolean
  availableTools: string[]
  disallowedTools: string[]
}

export function isRouterBuiltinToolName(name: string): boolean {
  return ROUTER_BUILTIN_TOOL_NAMES.has(name)
}

export function describeRouterBuiltinTools(
  config: RouterToolConfig,
): Array<{ name: string; group: string; enabled: boolean }> {
  const available = new Set(config.availableTools)
  const disallowed = new Set(config.disallowedTools)
  const usesAllowlist = available.size > 0
  return ROUTER_BUILTIN_TOOLS.map(tool => ({
    ...tool,
    enabled:
      !config.disableTools
      && !disallowed.has(tool.name)
      && (!usesAllowlist || available.has(tool.name)),
  }))
}

export function updateRouterBuiltinToolState(
  config: RouterToolConfig,
  name: string,
  enabled: boolean,
): { availableTools: string[]; disallowedTools: string[] } {
  if (!isRouterBuiltinToolName(name)) {
    throw new Error(`Unknown built-in tool: ${name}`)
  }
  const available = new Set(config.availableTools)
  const disallowed = new Set(config.disallowedTools)
  if (enabled) {
    disallowed.delete(name)
    if (available.size > 0) available.add(name)
  } else {
    disallowed.add(name)
  }
  return {
    availableTools: [...available].sort(),
    disallowedTools: [...disallowed].sort(),
  }
}
