import { Command } from '@commander-js/extra-typings'
import { describe, expect, test } from 'bun:test'
import { registerAgentGatewayCommand } from './cliCommand.js'

describe('registerAgentGatewayCommand', () => {
  test('registers the gateway command tree', () => {
    const program = new Command()
    registerAgentGatewayCommand(program, () => ({
      sortOptions: true,
      sortSubcommands: true,
    }))

    const gateway = program.commands.find(command =>
      command.aliases().includes('gateway'),
    )
    expect(gateway?.name()).toBe('agent-gateway')
    expect(gateway?.commands.map(command => command.name()).sort()).toEqual([
      'auth',
      'codex',
      'configure',
      'health',
      'memory',
      'model',
      'run',
      'serve',
      'setup',
      'status',
    ])

    const auth = gateway?.commands.find(command => command.name() === 'auth')
    expect(auth?.commands.map(command => command.name()).sort()).toEqual([
      'login',
      'logout',
    ])

    const codex = gateway?.commands.find(command => command.name() === 'codex')
    expect(codex?.commands.map(command => command.name()).sort()).toEqual([
      'login',
      'logout',
      'status',
    ])

    const setup = gateway?.commands.find(command => command.name() === 'setup')
    const setupNew = setup?.commands.find(command => command.name() === 'new')
    const setupProvider = setupNew?.commands.find(command =>
      command.name() === 'provider',
    )
    expect(setupProvider?.commands.map(command => command.name())).toEqual([
      'api',
    ])

    const memory = gateway?.commands.find(command => command.name() === 'memory')
    expect(memory?.commands.map(command => command.name()).sort()).toEqual([
      'add',
      'approval',
      'approve',
      'list',
      'pending',
      'reject',
      'remove',
      'remove-text',
      'replace',
      'replace-text',
      'search',
      'status',
      'tool',
    ])
  })
})
