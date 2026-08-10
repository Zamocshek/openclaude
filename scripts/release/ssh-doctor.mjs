#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { lookup } from 'node:dns/promises'
import { realpathSync } from 'node:fs'
import { Socket } from 'node:net'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const DEFAULT_PORT = 22
const DEFAULT_TIMEOUT_MS = 5_000
const MIN_TIMEOUT_MS = 500
const MAX_TIMEOUT_MS = 30_000

export function parseSshDoctorArgs(argv) {
  const positional = []
  let json = false
  let strict = false
  let timeoutMs = Number(process.env.OPENCLAUDE_SSH_CONNECT_TIMEOUT_MS || DEFAULT_TIMEOUT_MS)

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === '--json') {
      json = true
      continue
    }
    if (value === '--strict') {
      strict = true
      continue
    }
    if (value === '--timeout-ms') {
      timeoutMs = Number(argv[index + 1])
      index += 1
      continue
    }
    if (value?.startsWith('--timeout-ms=')) {
      timeoutMs = Number(value.slice('--timeout-ms='.length))
      continue
    }
    if (value === '--help' || value === '-h') {
      return { help: true, json: false, strict: false, host: '', port: DEFAULT_PORT, timeoutMs: DEFAULT_TIMEOUT_MS }
    }
    if (value?.startsWith('-')) throw new Error(`Unknown option: ${value}`)
    positional.push(value)
  }

  const host = String(positional[0] || '').trim()
  if (!host) throw new Error('SSH host is required')
  if (positional.length > 2) throw new Error('Too many positional arguments')

  const port = Number(positional[1] || DEFAULT_PORT)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('SSH port must be an integer from 1 to 65535')
  }
  if (!Number.isFinite(timeoutMs)) throw new Error('Timeout must be a number')

  return {
    help: false,
    json,
    strict,
    host,
    port,
    timeoutMs: Math.max(MIN_TIMEOUT_MS, Math.min(MAX_TIMEOUT_MS, Math.floor(timeoutMs))),
  }
}

function probeCommand(command, args) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    timeout: 3_000,
    windowsHide: true,
  })
  const output = `${result.stdout || ''}\n${result.stderr || ''}`.trim()
  return {
    available: !result.error && result.status === 0,
    version: output.split(/\r?\n/u).find(Boolean)?.slice(0, 240) || null,
    error: result.error?.code || (result.status === 0 ? null : `exit-${result.status}`),
  }
}

export function probeTcp(host, port, timeoutMs) {
  return new Promise(resolveProbe => {
    const socket = new Socket()
    const startedAt = Date.now()
    let settled = false
    const finish = (reachable, error = null) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolveProbe({
        reachable,
        latencyMs: Date.now() - startedAt,
        error,
      })
    }

    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false, 'ETIMEDOUT'))
    socket.once('error', error => finish(false, error.code || error.message))
    socket.connect(port, host)
  })
}

export async function diagnoseSshTarget({ host, port = DEFAULT_PORT, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const checkedAt = new Date().toISOString()
  let addresses = []
  let dnsError = null
  try {
    addresses = await lookup(host, { all: true })
  } catch (error) {
    dnsError = error?.code || error?.message || String(error)
  }

  const ssh = probeCommand('ssh', ['-V'])
  const sshpass = probeCommand('sshpass', ['-V'])
  const tcp = addresses.length > 0
    ? await probeTcp(host, port, timeoutMs)
    : { reachable: false, latencyMs: 0, error: 'DNS_UNRESOLVED' }

  const stage = dnsError
    ? 'dns'
    : !ssh.available
      ? 'client'
      : !tcp.reachable
        ? 'tcp'
        : 'ready'

  return {
    ok: stage === 'ready',
    stage,
    checkedAt,
    target: { host, port },
    dns: {
      ok: !dnsError && addresses.length > 0,
      addresses: addresses.map(item => ({ address: item.address, family: item.family })),
      error: dnsError,
    },
    clients: { ssh, sshpass },
    tcp,
    guidance: stage === 'dns'
      ? 'Fix the hostname or DNS before testing SSH.'
      : stage === 'client'
        ? 'Install an OpenSSH client in this runtime before attempting authentication.'
        : stage === 'tcp'
          ? 'The target resolves but the SSH port is unreachable from this runtime. Check the provider console, security group, host firewall, sshd service, and configured SSH port.'
          : 'TCP and the local SSH client are ready. Continue with host-key and authentication checks.',
  }
}

export function formatSshDoctorReport(report) {
  const addressText = report.dns.addresses.map(item => item.address).join(', ') || 'none'
  return [
    `SSH preflight: ${report.ok ? 'READY' : 'BLOCKED'} (${report.stage})`,
    `Target: ${report.target.host}:${report.target.port}`,
    `DNS: ${report.dns.ok ? `ok (${addressText})` : `failed (${report.dns.error || 'no addresses'})`}`,
    `TCP: ${report.tcp.reachable ? `reachable (${report.tcp.latencyMs}ms)` : `blocked (${report.tcp.error || 'unknown'})`}`,
    `OpenSSH client: ${report.clients.ssh.available ? report.clients.ssh.version || 'available' : `missing (${report.clients.ssh.error || 'unknown'})`}`,
    `sshpass: ${report.clients.sshpass.available ? report.clients.sshpass.version || 'available' : 'not installed (key authentication remains usable)'}`,
    `Next: ${report.guidance}`,
  ].join('\n')
}

function printHelp() {
  console.log([
    'Usage: openclaude-ssh-doctor <host> [port] [--timeout-ms 5000] [--json] [--strict]',
    '',
    'Checks DNS, local SSH tooling, and bounded TCP reachability separately.',
    'It does not read credentials or attempt authentication.',
    'Use --strict when an unavailable target should produce a non-zero exit code.',
  ].join('\n'))
}

async function main() {
  try {
    const options = parseSshDoctorArgs(process.argv.slice(2))
    if (options.help) {
      printHelp()
      return
    }
    const report = await diagnoseSshTarget(options)
    console.log(options.json ? JSON.stringify(report, null, 2) : formatSshDoctorReport(report))
    if (!report.ok && options.strict) process.exitCode = 2
  } catch (error) {
    console.error(`SSH preflight error: ${error?.message || String(error)}`)
    printHelp()
    process.exitCode = 64
  }
}

const invokedPath = process.argv[1]
  ? pathToFileURL(realpathSync(resolve(process.argv[1]))).href
  : ''
if (invokedPath === import.meta.url) await main()
