#!/usr/bin/env node

import { realpathSync, statSync } from 'node:fs'
import { extname, isAbsolute, relative, resolve } from 'node:path'

function readOption(name) {
  const exact = process.argv.indexOf(`--${name}`)
  if (exact >= 0) return process.argv[exact + 1] || ''
  const prefix = `--${name}=`
  return process.argv.find(value => value.startsWith(prefix))?.slice(prefix.length) || ''
}

function inferKind(path) {
  const extension = extname(path).toLowerCase()
  if (['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(extension)) return 'image'
  if (['.mp3', '.m4a', '.aac', '.ogg', '.oga', '.opus', '.wav', '.flac'].includes(extension)) {
    return 'audio'
  }
  return 'document'
}

const requestedPath = readOption('path')
if (!requestedPath) {
  console.error('Usage: openclaude-artifact --path <file> [--kind image|audio|document] [--caption text]')
  process.exit(2)
}

const root = realpathSync(resolve(process.env.OPENCLAUDE_ARTIFACT_ROOT || process.cwd()))
const candidate = realpathSync(isAbsolute(requestedPath)
  ? requestedPath
  : resolve(root, requestedPath))
const relativePath = relative(root, candidate)
if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
  console.error(`Artifact must stay under ${root}`)
  process.exit(2)
}

const stats = statSync(candidate)
if (!stats.isFile()) {
  console.error(`Artifact is not a file: ${candidate}`)
  process.exit(2)
}

const requestedKind = readOption('kind').trim().toLowerCase()
const kind = ['image', 'audio', 'document'].includes(requestedKind)
  ? requestedKind
  : inferKind(candidate)
const caption = readOption('caption').trim().slice(0, 1_024)

console.log(`OPENCLAUDE_ARTIFACT ${JSON.stringify({
  path: candidate,
  kind,
  ...(caption ? { caption } : {}),
  bytes: stats.size,
})}`)
