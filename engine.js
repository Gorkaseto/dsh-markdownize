// Conversion engines: the bundled pure-JS port (convert.js) and, when it is installed, Microsoft's
// MarkItDown CLI (Python). The choice is persisted per dsh home and edited from the plugin's page.
//   auto       — MarkItDown when detected, else JS
//   markitdown — MarkItDown only (fails when it is not available)
//   js         — the bundled port only
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { SUPPORTED, convertBuffer, extOf } from './convert.js'

export const ENGINES = ['auto', 'markitdown', 'js']
// Formats only MarkItDown reads; the JS port rejects them.
export const MARKITDOWN_EXTRA = ['xls', 'epub', 'ipynb', 'msg']

const DEFAULT_COMMANDS = [['markitdown'], ['py', '-m', 'markitdown'], ['python', '-m', 'markitdown'], ['python3', '-m', 'markitdown']]
const DETECT_TIMEOUT_MS = 20_000
const CONVERT_TIMEOUT_MS = 180_000
// Python on Windows writes the console code page unless told otherwise.
const PY_ENV = { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }

/** Split a user-typed command line; double quotes group a path with spaces. */
export function parseCommand(line) {
  return [...String(line ?? '').matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2])
}

function run(argv, timeout, signal) {
  return new Promise((resolvePromise, reject) => {
    execFile(argv[0], argv.slice(1), { env: PY_ENV, timeout, signal, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const detail = String(stderr || '').trim().split(/\r?\n/).slice(-3).join(' ') || error.message
        reject(new Error(detail))
      } else resolvePromise(String(stdout))
    })
  })
}

export function createEngines({ settingsPath }) {
  let settings = { engine: 'auto', command: '' }
  let loaded = null
  let detection = null // Promise<{ argv, version } | null>

  const load = () => (loaded ??= readFile(settingsPath, 'utf8').then(
    (text) => {
      const raw = JSON.parse(text)
      settings = {
        engine: ENGINES.includes(raw?.engine) ? raw.engine : 'auto',
        command: typeof raw?.command === 'string' ? raw.command : '',
      }
    },
    () => {},
  ))

  async function save() {
    await mkdir(dirname(settingsPath), { recursive: true })
    const tmp = `${settingsPath}.${process.pid}.tmp`
    await writeFile(tmp, JSON.stringify(settings, null, 2), 'utf8')
    await rename(tmp, settingsPath)
  }

  async function probe() {
    await load()
    const candidates = settings.command.trim() ? [parseCommand(settings.command)] : DEFAULT_COMMANDS
    for (const argv of candidates) {
      try {
        const out = await run([...argv, '--version'], DETECT_TIMEOUT_MS)
        return { argv, version: out.trim().replace(/^markitdown\s*/i, '') || 'unknown' }
      } catch { /* next candidate */ }
    }
    return null
  }

  const detect = (force = false) => {
    if (force || detection === null) detection = probe()
    return detection
  }

  async function status() {
    await load()
    const found = await detect()
    return {
      engine: settings.engine,
      command: settings.command,
      markitdown: found ? { version: found.version, command: found.argv.join(' ') } : null,
      active: settings.engine === 'js' || (settings.engine === 'auto' && !found) ? 'js' : found ? 'markitdown' : null,
    }
  }

  /** The engine a conversion runs on now; throws when MarkItDown is required but absent. */
  async function pick() {
    await load()
    if (settings.engine === 'js') return { kind: 'js' }
    const found = await detect()
    if (found) return { kind: 'markitdown', argv: found.argv }
    if (settings.engine === 'markitdown') {
      throw new Error('MarkItDown (Python) is selected but was not found. Install it with: pip install "markitdown[all]"')
    }
    return { kind: 'js' }
  }

  function checkFormat(kind, name) {
    const ext = extOf(name)
    const ok = SUPPORTED.includes(ext) || (kind === 'markitdown' && MARKITDOWN_EXTRA.includes(ext))
    if (!ok) {
      const list = kind === 'markitdown' ? [...SUPPORTED, ...MARKITDOWN_EXTRA] : SUPPORTED
      throw new Error(`unsupported format ".${ext}". Supported: ${list.join(', ')}`)
    }
  }

  async function viaMarkItDown(argv, file, signal) {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-markdownize-'))
    try {
      const out = join(dir, 'out.md')
      await run([...argv, file, '-o', out], CONVERT_TIMEOUT_MS, signal)
      return await readFile(out, 'utf8')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }

  return {
    status,
    async configure(engine, command) {
      await load()
      if (!ENGINES.includes(engine)) throw new Error(`engine must be one of ${ENGINES.join(', ')}`)
      const commandChanged = typeof command === 'string' && command.trim() !== settings.command
      settings = { engine, command: typeof command === 'string' ? command.trim() : settings.command }
      await save()
      if (commandChanged) detect(true)
      return status()
    },
    async redetect() {
      await detect(true)
      return status()
    },

    /** Convert a file on disk. `buf` may be passed when already read. */
    async convertFile(path, { buf, signal } = {}) {
      const engine = await pick()
      checkFormat(engine.kind, path)
      if (engine.kind === 'markitdown') return { md: await viaMarkItDown(engine.argv, path, signal), engine: 'markitdown' }
      return { md: await convertBuffer(buf ?? await readFile(path, { signal }), path), engine: 'js' }
    },

    /** Convert in-memory bytes named `leaf` (a browser attachment). */
    async convertBytes(buf, leaf) {
      const engine = await pick()
      checkFormat(engine.kind, leaf)
      if (engine.kind === 'js') return { md: await convertBuffer(buf, leaf), engine: 'js' }
      // MarkItDown picks its converter from the extension, so keep the real file name.
      const dir = await mkdtemp(join(tmpdir(), 'dsh-markdownize-in-'))
      try {
        const file = join(dir, leaf)
        await writeFile(file, buf)
        return { md: await viaMarkItDown(engine.argv, file), engine: 'markitdown' }
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    },
  }
}
