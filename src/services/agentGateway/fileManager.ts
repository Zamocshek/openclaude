import { createReadStream, createWriteStream } from 'fs'
import {
  lstat,
  mkdir,
  readdir,
  realpath,
  rename,
  rm,
  stat,
} from 'fs/promises'
import { basename, relative, resolve, sep } from 'path'
import { pipeline } from 'stream/promises'
import type { IncomingMessage, ServerResponse } from 'http'

export type FileManagerEntry = {
  name: string
  path: string
  kind: 'directory' | 'file' | 'symlink' | 'other'
  size: number
  modifiedAt: string
}

export class FileManagerError extends Error {
  constructor(
    readonly code: 'invalid_path' | 'not_found' | 'conflict' | 'forbidden',
    message: string,
  ) {
    super(message)
    this.name = 'FileManagerError'
  }
}

export async function listFileManagerDirectory(
  root: string,
  requestedPath = '',
): Promise<{ root: string; path: string; entries: FileManagerEntry[] }> {
  const { rootPath, targetPath, relativePath } = await resolveManagedPath(
    root,
    requestedPath,
  )
  const targetStat = await stat(targetPath).catch(error => {
    throw mapFileError(error, requestedPath)
  })
  if (!targetStat.isDirectory()) {
    throw new FileManagerError('invalid_path', 'Path is not a directory')
  }
  const entries = await readdir(targetPath, { withFileTypes: true })
  const described = await Promise.all(entries.map(async entry => {
    const entryPath = resolve(targetPath, entry.name)
    const entryRelative = relative(rootPath, entryPath).split(sep).join('/')
    const info = await lstat(entryPath)
    const kind: FileManagerEntry['kind'] = entry.isDirectory()
      ? 'directory'
      : entry.isFile()
        ? 'file'
        : entry.isSymbolicLink()
          ? 'symlink'
          : 'other'
    return {
      name: entry.name,
      path: entryRelative,
      kind,
      size: kind === 'file' ? info.size : 0,
      modifiedAt: info.mtime.toISOString(),
    }
  }))
  described.sort((left, right) => {
    const leftRank = left.kind === 'directory' ? 0 : 1
    const rightRank = right.kind === 'directory' ? 0 : 1
    return leftRank - rightRank || left.name.localeCompare(right.name)
  })
  return { root: rootPath, path: relativePath, entries: described }
}

export async function createFileManagerDirectory(
  root: string,
  requestedPath: string,
): Promise<void> {
  const { targetPath } = await resolveManagedPath(root, requestedPath, {
    allowMissing: true,
  })
  const rootPath = await realpath(resolve(root)).catch(error => {
    throw mapFileError(error, root)
  })
  await ensureParentWithinRoot(rootPath, targetPath)
  await mkdir(targetPath, { recursive: false }).catch(error => {
    throw mapFileError(error, requestedPath)
  })
}

export async function renameFileManagerEntry(
  root: string,
  from: string,
  to: string,
): Promise<void> {
  const source = await resolveExistingEntry(root, from)
  const destination = await resolveManagedPath(root, to, { allowMissing: true })
  if (source.targetPath === source.rootPath || destination.targetPath === source.rootPath) {
    throw new FileManagerError('forbidden', 'The workspace root cannot be renamed')
  }
  await ensureParentWithinRoot(destination.rootPath, destination.targetPath)
  await rename(source.targetPath, destination.targetPath).catch(error => {
    throw mapFileError(error, from)
  })
}

export async function removeFileManagerEntry(
  root: string,
  requestedPath: string,
): Promise<void> {
  const resolved = await resolveExistingEntry(root, requestedPath)
  if (resolved.targetPath === resolved.rootPath) {
    throw new FileManagerError('forbidden', 'The workspace root cannot be deleted')
  }
  await rm(resolved.targetPath, { recursive: true, force: false }).catch(error => {
    throw mapFileError(error, requestedPath)
  })
}

export async function streamFileManagerUpload(
  root: string,
  directory: string,
  filename: string,
  request: IncomingMessage,
): Promise<{ path: string; size: number }> {
  const safeName = validateFileName(filename)
  const targetDirectory = await resolveManagedPath(root, directory)
  const directoryStat = await stat(targetDirectory.targetPath).catch(error => {
    throw mapFileError(error, directory)
  })
  if (!directoryStat.isDirectory()) {
    throw new FileManagerError('invalid_path', 'Upload destination is not a directory')
  }
  const targetPath = resolve(targetDirectory.targetPath, safeName)
  await ensureParentWithinRoot(targetDirectory.rootPath, targetPath)
  const output = createWriteStream(targetPath, { flags: 'wx' })
  try {
    await pipeline(request, output)
  } catch (error) {
    await rm(targetPath, { force: true }).catch(() => {})
    throw mapFileError(error, safeName)
  }
  const uploaded = await stat(targetPath)
  return {
    path: relative(targetDirectory.rootPath, targetPath).split(sep).join('/'),
    size: uploaded.size,
  }
}

export async function streamFileManagerDownload(
  root: string,
  requestedPath: string,
  response: ServerResponse,
): Promise<void> {
  const resolved = await resolveManagedPath(root, requestedPath)
  const info = await stat(resolved.targetPath).catch(error => {
    throw mapFileError(error, requestedPath)
  })
  if (!info.isFile()) {
    throw new FileManagerError('invalid_path', 'Path is not a file')
  }
  response.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': String(info.size),
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(basename(resolved.targetPath))}`,
    'X-Content-Type-Options': 'nosniff',
  })
  await pipeline(createReadStream(resolved.targetPath), response)
}

async function resolveManagedPath(
  root: string,
  requestedPath: string,
  options: { allowMissing?: boolean } = {},
): Promise<{ rootPath: string; targetPath: string; relativePath: string }> {
  const rootPath = await realpath(resolve(root)).catch(error => {
    throw mapFileError(error, root)
  })
  const candidate = resolve(rootPath, requestedPath || '.')
  if (!isWithinRoot(rootPath, candidate)) {
    throw new FileManagerError('forbidden', 'Path is outside the agent workspace')
  }
  if (!options.allowMissing) {
    const canonical = await realpath(candidate).catch(error => {
      throw mapFileError(error, requestedPath)
    })
    if (!isWithinRoot(rootPath, canonical)) {
      throw new FileManagerError('forbidden', 'Symlinks outside the agent workspace are blocked')
    }
    return {
      rootPath,
      targetPath: canonical,
      relativePath: relative(rootPath, canonical).split(sep).join('/'),
    }
  }
  return {
    rootPath,
    targetPath: candidate,
    relativePath: relative(rootPath, candidate).split(sep).join('/'),
  }
}

async function resolveExistingEntry(
  root: string,
  requestedPath: string,
): Promise<{ rootPath: string; targetPath: string }> {
  const rootPath = await realpath(resolve(root)).catch(error => {
    throw mapFileError(error, root)
  })
  const targetPath = resolve(rootPath, requestedPath || '.')
  if (!isWithinRoot(rootPath, targetPath)) {
    throw new FileManagerError('forbidden', 'Path is outside the agent workspace')
  }
  const info = await lstat(targetPath).catch(error => {
    throw mapFileError(error, requestedPath)
  })
  if (!info.isSymbolicLink()) {
    const canonical = await realpath(targetPath).catch(error => {
      throw mapFileError(error, requestedPath)
    })
    if (!isWithinRoot(rootPath, canonical)) {
      throw new FileManagerError('forbidden', 'Symlinks outside the agent workspace are blocked')
    }
  }
  return { rootPath, targetPath }
}

async function ensureParentWithinRoot(rootPath: string, targetPath: string): Promise<void> {
  const parent = await realpath(resolve(targetPath, '..')).catch(error => {
    throw mapFileError(error, targetPath)
  })
  if (!isWithinRoot(rootPath, parent)) {
    throw new FileManagerError('forbidden', 'Destination is outside the agent workspace')
  }
}

function isWithinRoot(rootPath: string, targetPath: string): boolean {
  return targetPath === rootPath || targetPath.startsWith(`${rootPath}${sep}`)
}

function validateFileName(value: string): string {
  const name = value.trim()
  if (!name || name === '.' || name === '..' || basename(name) !== name) {
    throw new FileManagerError('invalid_path', 'A plain file name is required')
  }
  return name
}

function mapFileError(error: unknown, target: string): FileManagerError {
  if (error instanceof FileManagerError) return error
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  if (code === 'ENOENT') return new FileManagerError('not_found', `Not found: ${target}`)
  if (code === 'EEXIST') return new FileManagerError('conflict', `Already exists: ${target}`)
  if (code === 'EACCES' || code === 'EPERM') {
    return new FileManagerError('forbidden', `Access denied: ${target}`)
  }
  return new FileManagerError('invalid_path', error instanceof Error ? error.message : String(error))
}
