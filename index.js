import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { SUPPORTED, extOf } from './convert.js'
import { MARKITDOWN_EXTRA, createEngines } from './engine.js'

export const name = 'dsh-markdownize'
export const inject = ['tools']

const MAX_FILE_BYTES = 50 * 1024 * 1024
const DEFAULT_MAX_CHARS = 100_000
const DEBUG_DIR = join(tmpdir(), 'dsh-markdownize-debug')
const REMOTE_MARK = '@deepseek-ai/dsh-typert-protocol/remote-methods'
const ALL_FORMATS = [...SUPPORTED, ...MARKITDOWN_EXTRA]

// Debug mode: the Client names a draft attachment (bytes) or an `@file` reference (path), we
// convert it and write the full Markdown (no truncation) to a temp file the Client opens in the
// right Sidebar preview. The plugin page reads and sets the engine through the same service.
// Served by the Gateway's SRC fallback (plain service + remote-methods marker).
async function writeDebugMarkdown({ md, engine }, leaf) {
  await mkdir(DEBUG_DIR, { recursive: true })
  const stem = leaf.replace(/[^\w.-]+/g, '_')
  const path = join(DEBUG_DIR, `${stem}.${Date.now().toString(36)}.md`)
  await writeFile(path, md, 'utf8')
  return { path, chars: md.length, engine }
}

function leafOf(name) {
  const leaf = basename(name.replace(/\\/g, '/'))
  if (!ALL_FORMATS.includes(extOf(leaf))) throw new Error(`unsupported format ".${extOf(leaf)}". Supported: ${ALL_FORMATS.join(', ')}`)
  return leaf
}

async function checkedFile(abs) {
  const info = await stat(abs)
  if (!info.isFile()) throw new Error('not a regular file')
  if (info.size > MAX_FILE_BYTES) throw new Error(`file is ${info.size} bytes (limit ${MAX_FILE_BYTES})`)
}

class MarkdownizeService {
  constructor(engines) {
    this.engines = engines
  }

  /**
   * @param name - browser file name; only its basename and extension are used.
   * @param data - file bytes, base64.
   * @returns the absolute path of the written `.md`, its length in characters, and the engine used.
   */
  async convert(name, data) {
    if (typeof name !== 'string' || typeof data !== 'string') throw new Error('name and data must be strings')
    const leaf = leafOf(name)
    const buf = Buffer.from(data, 'base64')
    if (buf.length > MAX_FILE_BYTES) throw new Error(`file is ${buf.length} bytes (limit ${MAX_FILE_BYTES})`)
    return writeDebugMarkdown(await this.engines.convertBytes(buf, leaf), leaf)
  }

  /**
   * @param path - absolute, or relative to `cwd` (an `@file` reference's path).
   * @param cwd - the Session's workspace root; may be empty when `path` is absolute.
   * @returns the absolute path of the written `.md`, its length in characters, and the engine used.
   */
  async convertPath(path, cwd) {
    if (typeof path !== 'string' || !path || typeof cwd !== 'string') throw new Error('path and cwd must be strings')
    const leaf = leafOf(path)
    const abs = resolve(cwd, path)
    await checkedFile(abs)
    return writeDebugMarkdown(await this.engines.convertFile(abs), leaf)
  }

  /** Selected engine, saved custom command, MarkItDown detection, and the engine in force. */
  async status() {
    return this.engines.status()
  }

  /**
   * @param engine - `auto`, `markitdown` or `js`.
   * @param command - custom MarkItDown command line; empty searches PATH.
   */
  async configure(engine, command) {
    return this.engines.configure(engine, command)
  }

  /** Search for MarkItDown again (after installing it). */
  async redetect() {
    return this.engines.redetect()
  }
}
Object.defineProperty(MarkdownizeService.prototype, REMOTE_MARK, {
  configurable: true,
  value: Object.freeze({
    version: 1,
    methods: Object.freeze(['convert', 'convertPath', 'status', 'configure', 'redetect']
      .map((method) => Object.freeze({ method, invocation: Object.freeze({ kind: 'direct' }) }))),
  }),
})

export function apply(ctx) {
  const home = ctx.get('profileContext')?.home ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const engines = createEngines({ settingsPath: join(home, 'storages', 'dsh-markdownize', 'settings.json') })
  const service = new MarkdownizeService(engines)
  service.typertRemote = Object.freeze({ service, serviceKey: 'markdownize', namespace: 'markdownize' })
  ctx.provide('markdownize', service)

  ctx.tools.register(defineTool({
    name: 'convert_to_markdown',
    description:
      `Convert a LOCAL document to Markdown so it can be read as text. Supported: ${SUPPORTED.join(', ')} ` +
      `(also ${MARKITDOWN_EXTRA.join(', ')} when Microsoft MarkItDown is installed and selected). ` +
      'Use this for PDF, Word, PowerPoint, Excel, HTML, CSV and ZIP files instead of reading them as raw bytes. ' +
      'URLs are not supported; use the web tools for those.',
    parameters: {
      path: { type: 'string', required: true, description: 'Path to the file (absolute, or relative to the working directory)' },
      max_chars: { type: 'number', description: `Truncate the result to this many characters (default ${DEFAULT_MAX_CHARS})` },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    // Pure function of args: runs on live streaming AND on session-log replay.
    presentCall: (args) => ({
      card: 'generic',
      title: `Convert to Markdown: ${String(args?.path ?? '')}`,
      kind: 'read',
      locations: args?.path ? [{ path: String(args.path) }] : [],
    }),
    async execute(args, exec) {
      const p = args.path.trim()
      if (!p) throw new Error('path must not be empty')
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(p)) throw new Error('URLs are not supported; pass a local file path')
      const abs = resolve(p)
      await checkedFile(abs)
      const { md } = await engines.convertFile(abs, { signal: exec.signal })
      const limit = Math.max(1, Math.floor(args.max_chars ?? DEFAULT_MAX_CHARS))
      return md.length > limit
        ? `${md.slice(0, limit)}\n\n[truncated: ${md.length - limit} more characters. Call again with a larger max_chars.]`
        : md
    },
  }))
}
