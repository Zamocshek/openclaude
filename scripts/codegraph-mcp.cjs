#!/usr/bin/env node
'use strict'

const { existsSync } = require('node:fs')
const { resolve } = require('node:path')

const packageShim = 'node_modules/@colbymchenry/codegraph/npm-shim.js'
const candidates = [
  process.env.OPENCLAUDE_CODEGRAPH_SHIM,
  '/app/' + packageShim,
  resolve(__dirname, '..', packageShim),
  resolve(process.cwd(), packageShim),
].filter(Boolean)

const shim = candidates.find(candidate => existsSync(candidate))
if (!shim) {
  process.stderr.write(
    'CodeGraph is not installed. Run `bun install` or rebuild the Docker image.\n',
  )
  process.exit(1)
}

process.env.CODEGRAPH_TELEMETRY ||= '0'
require(shim)
