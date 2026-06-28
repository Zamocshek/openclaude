import type { Command } from '@commander-js/extra-typings'

type HelpConfigFactory = () => {
  sortSubcommands: true
  sortOptions: true
}

export function registerAgentGatewayCommand(
  program: Command,
  createSortedHelpConfig: HelpConfigFactory,
): void {
  const gateway = program
    .command('agent-gateway')
    .alias('gateway')
    .description('Configure and control the local agent gateway')
    .configureHelp(createSortedHelpConfig())

  gateway
    .command('status')
    .description('Show agent gateway configuration status')
    .option('--json', 'Output as JSON')
    .option('--show-key', 'Reveal the stored Agent API key')
    .action(async (options: {
      json?: boolean
      showKey?: boolean
    }) => {
      const { agentGatewayStatusHandler } = await import(
        '../../cli/handlers/agentGateway.js'
      )
      await agentGatewayStatusHandler(options)
    })

  gateway
    .command('model')
    .description('Show the active gateway model and provider auth status')
    .option('--json', 'Output as JSON')
    .option('--show-key', 'Reveal resolved provider API keys')
    .action(async (options: {
      json?: boolean
      showKey?: boolean
    }) => {
      const { agentGatewayModelHandler } = await import(
        '../../cli/handlers/agentGateway.js'
      )
      await agentGatewayModelHandler(options)
    })

  const gatewaySetup = gateway
    .command('setup')
    .description('Run Hermes-style setup workflows')
    .configureHelp(createSortedHelpConfig())

  const gatewaySetupNew = gatewaySetup
    .command('new')
    .description('Create a new gateway resource')
    .configureHelp(createSortedHelpConfig())

  const gatewaySetupNewProvider = gatewaySetupNew
    .command('provider')
    .description('Configure a new model provider')
    .configureHelp(createSortedHelpConfig())

  gatewaySetupNewProvider
    .command('api')
    .description('Configure provider API auth; defaults to Codex OAuth')
    .option('--codex', 'Use ChatGPT/Codex OAuth subscription auth')
    .option('--api-key <key>', 'Manual Agent API key to store. Use "-" to read from stdin')
    .option('--generate', 'Generate a local Agent API key when using manual auth')
    .option('--model <model>', 'Provider model alias or id', 'codexplan')
    .option('--host <host>', 'Agent API host')
    .option('--port <port>', 'Agent API port')
    .option('--cwd <dir>', 'Working directory for gateway agent runs')
    .option(
      '--permission-mode <mode>',
      'Permission mode: default, acceptEdits, or bypassPermissions',
    )
    .option('--max-turns <turns>', 'Maximum turns for each gateway agent run')
    .option('--timeout-ms <ms>', 'Timeout for each gateway agent run')
    .option('--disable-tools', 'Run gateway child agents without model tool calls')
    .option('--enable-tools', 'Allow gateway child agents to use configured tools')
    .option('--cors-origins <origins>', 'Comma/space-separated CORS origins')
    .option('--no-browser', 'Print the Codex OAuth URL without opening a browser')
    .option('--show-key', 'Reveal stored/generated credentials in output')
    .option('--no-activate', 'Save Codex credentials without switching this session')
    .option('--disable-api', 'Save credentials but leave the Agent API disabled')
    .option('--json', 'Output as JSON')
    .action(async (options: {
      codex?: boolean
      apiKey?: string
      generate?: boolean
      model?: string
      host?: string
      port?: string
      cwd?: string
      permissionMode?: string
      maxTurns?: string
      timeoutMs?: string
      disableTools?: boolean
      enableTools?: boolean
      corsOrigins?: string
      noBrowser?: boolean
      showKey?: boolean
      noActivate?: boolean
      disableApi?: boolean
      json?: boolean
    }) => {
      const { agentGatewaySetupNewProviderApiHandler } = await import(
        '../../cli/handlers/agentGateway.js'
      )
      await agentGatewaySetupNewProviderApiHandler(options)
    })

  const gatewayAuth = gateway
    .command('auth')
    .description('Manage agent gateway API authentication')
    .configureHelp(createSortedHelpConfig())

  gatewayAuth
    .command('login')
    .description('Configure Bearer authentication for the Agent API')
    .option('--api-key <key>', 'API key to store. Use "-" to read from stdin')
    .option('--generate', 'Generate a new API key')
    .option('--show-key', 'Reveal the stored/generated key in output')
    .option('--host <host>', 'Agent API host')
    .option('--port <port>', 'Agent API port')
    .option('--model <model>', 'OpenAI-compatible model name exposed by the gateway')
    .option('--cwd <dir>', 'Working directory for gateway agent runs')
    .option(
      '--permission-mode <mode>',
      'Permission mode: default, acceptEdits, or bypassPermissions',
    )
    .option('--max-turns <turns>', 'Maximum turns for each gateway agent run')
    .option('--timeout-ms <ms>', 'Timeout for each gateway agent run')
    .option('--disable-tools', 'Run gateway child agents without model tool calls')
    .option('--enable-tools', 'Allow gateway child agents to use configured tools')
    .option('--cors-origins <origins>', 'Comma/space-separated CORS origins')
    .option('--disable-api', 'Save the key but leave the Agent API disabled')
    .option('--json', 'Output as JSON')
    .action(async (options: {
      apiKey?: string
      generate?: boolean
      showKey?: boolean
      host?: string
      port?: string
      model?: string
      cwd?: string
      permissionMode?: string
      maxTurns?: string
      timeoutMs?: string
      disableTools?: boolean
      enableTools?: boolean
      corsOrigins?: string
      disableApi?: boolean
      json?: boolean
    }) => {
      const { agentGatewayAuthLoginHandler } = await import(
        '../../cli/handlers/agentGateway.js'
      )
      await agentGatewayAuthLoginHandler(options)
    })

  gatewayAuth
    .command('logout')
    .description('Remove the stored Agent API key')
    .option('--disable-api', 'Also disable the Agent API')
    .option('--json', 'Output as JSON')
    .action(async (options: {
      disableApi?: boolean
      json?: boolean
    }) => {
      const { agentGatewayAuthLogoutHandler } = await import(
        '../../cli/handlers/agentGateway.js'
      )
      await agentGatewayAuthLogoutHandler(options)
    })

  const gatewayCodex = gateway
    .command('codex')
    .description('Manage Codex OAuth provider authentication')
    .configureHelp(createSortedHelpConfig())

  gatewayCodex
    .command('login')
    .description('Sign in with ChatGPT/Codex OAuth and configure the gateway provider')
    .option('--model <model>', 'Codex model alias or id', 'codexplan')
    .option('--no-browser', 'Print the OAuth URL without opening a browser')
    .option('--show-key', 'Reveal the resolved Codex API token in output')
    .option('--no-activate', 'Save credentials without switching this session')
    .option('--json', 'Output as JSON')
    .action(async (options: {
      model?: string
      noBrowser?: boolean
      showKey?: boolean
      noActivate?: boolean
      json?: boolean
    }) => {
      const { agentGatewayCodexLoginHandler } = await import(
        '../../cli/handlers/agentGateway.js'
      )
      await agentGatewayCodexLoginHandler(options)
    })

  gatewayCodex
    .command('status')
    .description('Show Codex OAuth provider credential status')
    .option('--show-key', 'Reveal the resolved Codex API token')
    .option('--json', 'Output as JSON')
    .action(async (options: {
      showKey?: boolean
      json?: boolean
    }) => {
      const { agentGatewayCodexStatusHandler } = await import(
        '../../cli/handlers/agentGateway.js'
      )
      await agentGatewayCodexStatusHandler(options)
    })

  gatewayCodex
    .command('logout')
    .description('Clear stored Codex OAuth credentials')
    .option('--keep-profile', 'Keep the provider/startup profile files')
    .option('--json', 'Output as JSON')
    .action(async (options: {
      keepProfile?: boolean
      json?: boolean
    }) => {
      const { agentGatewayCodexLogoutHandler } = await import(
        '../../cli/handlers/agentGateway.js'
      )
      await agentGatewayCodexLogoutHandler(options)
    })

  gateway
    .command('configure')
    .description('Update agent gateway runtime settings')
    .option('--enable-api', 'Enable the Agent API')
    .option('--disable-api', 'Disable the Agent API')
    .option('--host <host>', 'Agent API host')
    .option('--port <port>', 'Agent API port')
    .option('--model <model>', 'OpenAI-compatible model name exposed by the gateway')
    .option('--api-key <key>', 'Agent API key to store. Use "-" to read from stdin')
    .option('--cors-origins <origins>', 'Comma/space-separated CORS origins')
    .option('--cwd <dir>', 'Working directory for gateway agent runs')
    .option(
      '--permission-mode <mode>',
      'Permission mode: default, acceptEdits, or bypassPermissions',
    )
    .option('--max-turns <turns>', 'Maximum turns for each gateway agent run')
    .option('--timeout-ms <ms>', 'Timeout for each gateway agent run')
    .option('--disable-tools', 'Run gateway child agents without model tool calls')
    .option('--enable-tools', 'Allow gateway child agents to use configured tools')
    .option('--tools <tools>', 'Comma/space-separated available tool names')
    .option('--disallowed-tools <tools>', 'Comma/space-separated denied tool names')
    .option('--enable-telegram', 'Enable the Telegram bridge')
    .option('--disable-telegram', 'Disable the Telegram bridge')
    .option('--telegram-bot-token <token>', 'Telegram bot token')
    .option('--telegram-home-chat-id <id>', 'Telegram home chat ID')
    .option('--telegram-allowed-chat-ids <ids>', 'Comma/space-separated allowed chat IDs')
    .option('--telegram-allowed-user-ids <ids>', 'Comma/space-separated allowed user IDs')
    .option('--enable-cron', 'Enable cron scheduler')
    .option('--disable-cron', 'Disable cron scheduler')
    .option('--enable-memory', 'Enable MEMORY.md project memory injection')
    .option('--disable-memory', 'Disable MEMORY.md project memory injection')
    .option('--enable-user-profile', 'Enable USER.md user profile injection')
    .option('--disable-user-profile', 'Disable USER.md user profile injection')
    .option('--memory-approval', 'Stage agent memory writes for approval')
    .option('--no-memory-approval', 'Apply valid agent memory writes immediately')
    .option('--json', 'Output as JSON')
    .action(async (options: {
      enableApi?: boolean
      disableApi?: boolean
      host?: string
      port?: string
      model?: string
      apiKey?: string
      corsOrigins?: string
      cwd?: string
      permissionMode?: string
      maxTurns?: string
      timeoutMs?: string
      disableTools?: boolean
      enableTools?: boolean
      tools?: string
      disallowedTools?: string
      enableTelegram?: boolean
      disableTelegram?: boolean
      telegramBotToken?: string
      telegramHomeChatId?: string
      telegramAllowedChatIds?: string
      telegramAllowedUserIds?: string
      enableCron?: boolean
      disableCron?: boolean
      enableMemory?: boolean
      disableMemory?: boolean
      enableUserProfile?: boolean
      disableUserProfile?: boolean
      memoryApproval?: boolean
      json?: boolean
    }) => {
      const { agentGatewayConfigureHandler } = await import(
        '../../cli/handlers/agentGateway.js'
      )
      await agentGatewayConfigureHandler(options)
    })

  const gatewayMemory = gateway
    .command('memory')
    .description('Manage Hermes-style bounded gateway memory')
    .configureHelp(createSortedHelpConfig())

  gatewayMemory
    .command('status')
    .description('Show MEMORY.md / USER.md usage and paths')
    .option('--json', 'Output as JSON')
    .action(async (options: { json?: boolean }) => {
      const { agentGatewayMemoryStatusHandler } = await import(
        '../../cli/handlers/agentGateway.js'
      )
      await agentGatewayMemoryStatusHandler(options)
    })

  gatewayMemory
    .command('list')
    .description('List curated memories')
    .option('--kind <kind>', 'memory or user')
    .option('--json', 'Output as JSON')
    .action(async (options: { kind?: string; json?: boolean }) => {
      const { agentGatewayMemoryListHandler } = await import(
        '../../cli/handlers/agentGateway.js'
      )
      await agentGatewayMemoryListHandler(options)
    })

  gatewayMemory
    .command('add')
    .description('Add a curated memory entry')
    .argument('[content...]', 'Memory text. If omitted, stdin is used')
    .option('--kind <kind>', 'memory or user', 'memory')
    .option('--tags <tags>', 'Comma/space-separated tags')
    .option('--source <source>', 'Memory source label', 'cli')
    .option('--json', 'Output as JSON')
    .action(async (
      contentParts: string[] | undefined,
      options: {
        kind?: string
        tags?: string
        source?: string
        json?: boolean
      },
    ) => {
      const { agentGatewayMemoryAddHandler } = await import(
        '../../cli/handlers/agentGateway.js'
      )
      await agentGatewayMemoryAddHandler(contentParts?.join(' '), options)
    })

  gatewayMemory
    .command('tool')
    .description('Apply a Hermes-style memory tool action')
    .requiredOption('--action <action>', 'add, replace, or remove')
    .option('--kind <kind>', 'memory or user', 'memory')
    .option('--target <kind>', 'Alias for --kind')
    .option('--content <text>', 'Memory content or replacement text. If omitted for add/replace, stdin is used')
    .option('--old-text <text>', 'Exact substring to replace or remove')
    .option('--tags <tags>', 'Comma/space-separated tags')
    .option('--source <source>', 'Memory source label', 'cli-tool')
    .option('--force', 'Bypass configured write approval')
    .option('--json', 'Output as JSON')
    .action(async (options: {
      action?: string
      kind?: string
      target?: string
      content?: string
      oldText?: string
      tags?: string
      source?: string
      force?: boolean
      json?: boolean
    }) => {
      const { agentGatewayMemoryToolHandler } = await import(
        '../../cli/handlers/agentGateway.js'
      )
      await agentGatewayMemoryToolHandler({
        ...options,
        kind: options.kind || options.target,
      })
    })

  gatewayMemory
    .command('replace')
    .description('Replace a curated memory entry')
    .argument('<id>', 'Memory entry id')
    .argument('[content...]', 'Replacement text. If omitted, stdin is used')
    .option('--tags <tags>', 'Comma/space-separated replacement tags')
    .option('--json', 'Output as JSON')
    .action(async (
      id: string,
      contentParts: string[] | undefined,
      options: {
        tags?: string
        json?: boolean
      },
    ) => {
      const { agentGatewayMemoryReplaceHandler } = await import(
        '../../cli/handlers/agentGateway.js'
      )
      await agentGatewayMemoryReplaceHandler(id, contentParts?.join(' '), options)
    })

  gatewayMemory
    .command('replace-text')
    .description('Replace a unique exact substring in MEMORY.md / USER.md')
    .argument('<old_text>', 'Exact substring to replace')
    .argument('[content...]', 'Replacement text. If omitted, stdin is used')
    .option('--kind <kind>', 'memory or user')
    .option('--tags <tags>', 'Comma/space-separated replacement tags')
    .option('--json', 'Output as JSON')
    .action(async (
      oldText: string,
      contentParts: string[] | undefined,
      options: {
        kind?: string
        tags?: string
        json?: boolean
      },
    ) => {
      const { agentGatewayMemoryReplaceTextHandler } = await import(
        '../../cli/handlers/agentGateway.js'
      )
      await agentGatewayMemoryReplaceTextHandler(
        oldText,
        contentParts?.join(' '),
        options,
      )
    })

  gatewayMemory
    .command('remove')
    .description('Remove a curated memory entry')
    .alias('rm')
    .argument('<id>', 'Memory entry id')
    .option('--json', 'Output as JSON')
    .action(async (id: string, options: { json?: boolean }) => {
      const { agentGatewayMemoryRemoveHandler } = await import(
        '../../cli/handlers/agentGateway.js'
      )
      await agentGatewayMemoryRemoveHandler(id, options)
    })

  gatewayMemory
    .command('remove-text')
    .alias('rm-text')
    .description('Remove a unique exact substring from MEMORY.md / USER.md')
    .argument('<old_text>', 'Exact substring to remove')
    .option('--kind <kind>', 'memory or user')
    .option('--json', 'Output as JSON')
    .action(async (
      oldText: string,
      options: { kind?: string; json?: boolean },
    ) => {
      const { agentGatewayMemoryRemoveTextHandler } = await import(
        '../../cli/handlers/agentGateway.js'
      )
      await agentGatewayMemoryRemoveTextHandler(oldText, options)
    })

  gatewayMemory
    .command('search')
    .description('Search curated memory or gateway session logs')
    .argument('[query...]', 'Search text. If omitted, stdin is used')
    .option('--kind <kind>', 'memory or user')
    .option('--sessions', 'Search persisted gateway chat/run logs instead')
    .option('--limit <n>', 'Maximum results', '20')
    .option('--json', 'Output as JSON')
    .action(async (
      queryParts: string[] | undefined,
      options: {
        kind?: string
        sessions?: boolean
        limit?: string
        json?: boolean
      },
    ) => {
      const { agentGatewayMemorySearchHandler } = await import(
        '../../cli/handlers/agentGateway.js'
      )
      await agentGatewayMemorySearchHandler(queryParts?.join(' '), options)
    })

  gatewayMemory
    .command('pending')
    .description('List staged memory writes waiting for approval')
    .option('--json', 'Output as JSON')
    .action(async (options: { json?: boolean }) => {
      const { agentGatewayMemoryPendingHandler } = await import(
        '../../cli/handlers/agentGateway.js'
      )
      await agentGatewayMemoryPendingHandler(options)
    })

  gatewayMemory
    .command('approve')
    .description('Approve a staged memory write, or all pending writes')
    .argument('[id]', 'Pending memory action id, defaults to all')
    .option('--json', 'Output as JSON')
    .action(async (id: string | undefined, options: { json?: boolean }) => {
      const { agentGatewayMemoryApproveHandler } = await import(
        '../../cli/handlers/agentGateway.js'
      )
      await agentGatewayMemoryApproveHandler(id, options)
    })

  gatewayMemory
    .command('reject')
    .description('Reject a staged memory write, or all pending writes')
    .argument('[id]', 'Pending memory action id, defaults to all')
    .option('--json', 'Output as JSON')
    .action(async (id: string | undefined, options: { json?: boolean }) => {
      const { agentGatewayMemoryRejectHandler } = await import(
        '../../cli/handlers/agentGateway.js'
      )
      await agentGatewayMemoryRejectHandler(id, options)
    })

  gatewayMemory
    .command('approval')
    .description('Show or change memory write approval mode')
    .argument('[mode]', 'on, off, or status', 'status')
    .option('--json', 'Output as JSON')
    .action(async (mode: string | undefined, options: { json?: boolean }) => {
      const { agentGatewayMemoryApprovalHandler } = await import(
        '../../cli/handlers/agentGateway.js'
      )
      await agentGatewayMemoryApprovalHandler(mode, options)
    })

  gateway
    .command('health')
    .description('Check a running agent gateway HTTP server')
    .option('--url <url>', 'Gateway base URL, with or without /v1')
    .option('--api-key <key>', 'Override Bearer API key')
    .option('--timeout-ms <ms>', 'Request timeout')
    .option('--json', 'Output as JSON')
    .action(async (options: {
      url?: string
      apiKey?: string
      timeoutMs?: string
      json?: boolean
    }) => {
      const { agentGatewayHealthHandler } = await import(
        '../../cli/handlers/agentGateway.js'
      )
      await agentGatewayHealthHandler(options)
    })

  gateway
    .command('run')
    .description('Send a prompt to a running agent gateway via the Responses API')
    .argument('[prompt...]', 'Prompt text. If omitted, stdin is used')
    .option('--url <url>', 'Gateway base URL, with or without /v1')
    .option('--api-key <key>', 'Override Bearer API key')
    .option('--instructions <text>', 'Responses API instructions')
    .option('--conversation <id>', 'Conversation id for server-side response chaining')
    .option('--timeout-ms <ms>', 'Request timeout')
    .option('--json', 'Output raw JSON')
    .action(async (
      promptParts: string[] | undefined,
      options: {
        url?: string
        apiKey?: string
        instructions?: string
        conversation?: string
        timeoutMs?: string
        json?: boolean
      },
    ) => {
      const { agentGatewayRunHandler } = await import(
        '../../cli/handlers/agentGateway.js'
      )
      await agentGatewayRunHandler(promptParts?.join(' '), options)
    })

  gateway
    .command('serve')
    .description('Start the configured local agent gateway and keep it running')
    .action(async () => {
      const { agentGatewayServeHandler } = await import(
        '../../cli/handlers/agentGateway.js'
      )
      await agentGatewayServeHandler()
    })
}
