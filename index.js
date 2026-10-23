import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { SUPPORTED, extOf } from './convert.js'
import { MARKITDOWN_EXTRA, createEngines } from './engine.js'
import { OUTPUT_SCHEMA, imagesAsText, imagesInline, renderValue, truncateMarkdown } from './images.js'

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
// Debug output never reaches a model, so embedded images always show as text markers.
async function writeDebugMarkdown({ md: raw, images, engine }, leaf) {
  const md = imagesAsText(raw, images)
  await mkdir(DEBUG_DIR, { recursive: true })
  const stem = leaf.replace(/[^\w.-]+/g, '_')
  const path = join(DEBUG_DIR, `${stem}.${Date.now().toString(36)}.md`)
  await writeFile(path, md, 'utf8')
  return { path, chars: md.length, engine, images: images.length }
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

  /**
   * @param images - `inline` (images reach image-capable models) or `none` (text markers only).
   * @param maxImages - most images sent per conversion.
   */
  async configureImages(images, maxImages) {
    return this.engines.configureImages(images, maxImages)
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
    methods: Object.freeze(['convert', 'convertPath', 'status', 'configure', 'configureImages', 'redetect']
      .map((method) => Object.freeze({ method, invocation: Object.freeze({ kind: 'direct' }) }))),
  }),
})

/**
 * Why the calling model cannot take images, or undefined when it can. Same route resolution as the
 * harness's `read_image`: the session's latest request header, then the agent options.
 */
async function imageRefusal(ctx, exec) {
  if (ctx.get('attachments') === undefined) return 'no attachment service is mounted'
  const routed = exec.agent?.session.requestHeader()?.config
  const provider = routed?.provider ?? exec.agent?.options.provider
  const model = routed?.model ?? exec.agent?.options.model
  const llm = ctx.get('llm')
  if (provider === undefined || model === undefined || llm === undefined) return 'the current model could not be resolved'
  try {
    const info = await llm.resolveModelInfo(provider, model, exec.signal)
    if (!info.inputModalities?.includes('image')) return `model "${model}" does not accept image input`
  } catch {
    return `model "${model}" could not be checked for image input`
  }
}

export function apply(ctx) {
  const home = ctx.get('profileContext')?.home ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const engines = createEngines({ settingsPath: join(home, 'storages', 'dsh-markdownize', 'settings.json') })
  const service = new MarkdownizeService(engines)
  service.typertRemote = Object.freeze({ service, serviceKey: 'markdownize', namespace: 'markdownize' })
  ctx.provide('markdownize', service)

  ctx.tools.register(defineTool({
    name: 'convert_to_markdown',
    description:
      `For any supported local document, call this tool to extract its readable content as Markdown. Do not use another Office/document plugin or read the file as raw bytes when this tool is available. Supported: ${SUPPORTED.join(', ')} ` +
      `(also ${MARKITDOWN_EXTRA.join(', ')} when Microsoft MarkItDown is installed and selected). ` +
      'Use this for PDF, Word, PowerPoint, Excel, HTML, CSV and ZIP files instead of reading them as raw bytes. ' +
      'URLs are not supported; use the web tools for those. ' +
      'Images embedded in DOCX/PPTX appear as [Image N: alt text] markers; when the current model accepts images ' +
      'and the plugin settings allow it, each image follows its marker. Pass include_images: false when only the text matters.',
    parameters: {
      path: { type: 'string', required: true, description: 'Path to the file (absolute, or relative to the working directory)' },
      max_chars: { type: 'number', description: `Truncate the result to this many characters (default ${DEFAULT_MAX_CHARS})` },
      include_images: { type: 'boolean', description: 'Include embedded images when the model and the plugin settings allow it (default true). false returns text markers only.' },
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => renderValue(value),
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
      const { md: full, images } = await engines.convertFile(abs, { signal: exec.signal })
      const limit = Math.max(1, Math.floor(args.max_chars ?? DEFAULT_MAX_CHARS))
      const { md, cut } = truncateMarkdown(full, limit)
      const tail = cut ? `\n\n[truncated: ${cut} more characters. Call again with a larger max_chars.]` : ''
      if (!images.length) return md + tail
      const settings = await engines.imageSettings()
      if (settings.images === 'none') return imagesAsText(md, images, 'disabled in the plugin settings') + tail
      if (args.include_images === false) return imagesAsText(md, images) + tail
      const refusal = await imageRefusal(ctx, exec)
      if (refusal) return imagesAsText(md, images, refusal) + tail
      const value = await imagesInline(md, images, { attachments: ctx.get('attachments'), max: settings.maxImages })
      return typeof value === 'string' ? value + tail : { ...value, markdown: value.markdown + tail }
    },
  }))
}
