import { afterEach, describe, expect, test } from 'bun:test'
import { createServer } from 'node:net'
import {
  diagnoseSshTarget,
  formatSshDoctorReport,
  parseSshDoctorArgs,
} from './ssh-doctor.mjs'

const servers = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve))))
})

describe('SSH doctor', () => {
  test('parses and bounds target options', () => {
    expect(parseSshDoctorArgs(['example.com', '2222', '--timeout-ms', '50'])).toEqual({
      help: false,
      json: false,
      strict: false,
      host: 'example.com',
      port: 2222,
      timeoutMs: 500,
    })
    expect(() => parseSshDoctorArgs(['example.com', '70000'])).toThrow('SSH port')
  })

  test('separates DNS and TCP reachability from client availability', async () => {
    const server = createServer(socket => socket.end('SSH-2.0-test\r\n'))
    servers.push(server)
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing TCP test address')

    const report = await diagnoseSshTarget({
      host: '127.0.0.1',
      port: address.port,
      timeoutMs: 1_000,
    })

    expect(report.dns.ok).toBe(true)
    expect(report.tcp.reachable).toBe(true)
    expect(report.stage).toBe(report.clients.ssh.available ? 'ready' : 'client')
    expect(formatSshDoctorReport(report)).toContain('TCP: reachable')
  })
})
