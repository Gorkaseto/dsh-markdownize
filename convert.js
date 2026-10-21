// Core document → Markdown conversion. No Python, no network, no child processes.
// Mirrors MarkItDown's offline converters: DOCX, PPTX, XLSX, PDF, HTML, CSV/JSON/XML/text, ZIP.
// Third-party libs come pre-bundled (see build-vendor.mjs): local plugins are installed as
// `link:` symlinks, so their npm dependencies are never installed.
import { JSZip, mammoth, TurndownService, gfm, XMLParser, ExcelJS } from './vendor/deps.js'

const MAX_ZIP_ENTRIES = 200
const MAX_ZIP_BYTES = 50 * 1024 * 1024 // total uncompressed budget (zip-bomb guard)

const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-' })
td.use(gfm)
td.remove(['script', 'style'])

const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', preserveOrder: false })

export const SUPPORTED = ['pdf', 'docx', 'pptx', 'xlsx', 'html', 'htm', 'csv', 'tsv', 'json', 'xml', 'txt', 'md', 'zip']

export function extOf(name) {
  const m = /\.([A-Za-z0-9]+)$/.exec(name)
  return m ? m[1].toLowerCase() : ''
}

const esc = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim()

export function rowsToMarkdown(rows) {
  rows = rows.filter((r) => r.length)
  if (!rows.length) return ''
  const width = Math.max(...rows.map((r) => r.length))
  const pad = (r) => Array.from({ length: width }, (_, i) => esc(r[i]))
  const [head, ...body] = rows.map(pad)
  return [
    `| ${head.join(' | ')} |`,
    `| ${head.map(() => '---').join(' | ')} |`,
    ...body.map((r) => `| ${r.join(' | ')} |`),
  ].join('\n')
}

function parseDelimited(text, delim) {
  const rows = []
  let row = [], cell = '', q = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++ }
      else if (c === '"') q = false
      else cell += c
    } else if (c === '"') q = true
    else if (c === delim) { row.push(cell); cell = '' }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(cell); rows.push(row); row = []; cell = ''
    } else cell += c
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row) }
  return rows
}

// mammoth emits header-less tables with <p> in cells; GFM needs a header row and inline cell content.
function normalizeTables(html) {
  return html.replace(/<table>([\s\S]*?)<\/table>/g, (_, inner) => {
    inner = inner.replace(/<\/?p>/g, '').replace(/<\/?tbody>/g, '')
    let first = true
    inner = inner.replace(/<tr>([\s\S]*?)<\/tr>/g, (_m, row) => {
      if (first) { first = false; row = row.replace(/<td>/g, '<th>').replace(/<\/td>/g, '</th>') }
      return `<tr>${row}</tr>`
    })
    return `<table>${inner}</table>`
  })
}

async function docx(buf) {
  const { value: html } = await mammoth.convertToHtml({ buffer: buf })
  return td.turndown(normalizeTables(html))
}

async function xlsx(buf) {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(buf)
  const out = []
  wb.eachSheet((ws) => {
    const rows = []
    ws.eachRow({ includeEmpty: false }, (row) => {
      const vals = row.values.slice(1).map((v) => {
        if (v == null) return ''
        if (v instanceof Date) return v.toISOString().slice(0, 10)
        if (typeof v === 'object') {
          if ('formula' in v || 'sharedFormula' in v) return v.result ?? `=${v.formula ?? ''}`
          if ('richText' in v) return v.richText.map((t) => t.text).join('')
          if ('text' in v) return v.text
          if ('error' in v) return v.error
          return JSON.stringify(v)
        }
        return v
      })
      rows.push(vals)
    })
    out.push(`## ${ws.name}\n\n${rowsToMarkdown(rows)}`)
  })
  return out.join('\n\n')
}

const arr = (x) => (x == null ? [] : Array.isArray(x) ? x : [x])

function collectText(node, acc = []) {
  if (node == null || typeof node !== 'object') return acc
  for (const [k, v] of Object.entries(node)) {
    if (k === 'a:t') arr(v).forEach((t) => acc.push(typeof t === 'object' ? (t['#text'] ?? '') : String(t)))
    else if (k === 'a:p') arr(v).forEach((p) => { collectText(p, acc); acc.push('\n') })
    else if (typeof v === 'object') arr(v).forEach((c) => collectText(c, acc))
  }
  return acc
}

async function pptx(buf) {
  const zip = await JSZip.loadAsync(buf)
  const slides = Object.keys(zip.files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => parseInt(a.match(/(\d+)\.xml/)[1]) - parseInt(b.match(/(\d+)\.xml/)[1]))
  const out = []
  for (const [i, name] of slides.entries()) {
    const doc = xml.parse(await zip.files[name].async('string'))
    const text = collectText(doc).join('').replace(/\n{2,}/g, '\n').trim()
    const notesName = `ppt/notesSlides/notesSlide${name.match(/(\d+)\.xml/)[1]}.xml`
    let notes = ''
    if (zip.files[notesName]) {
      notes = collectText(xml.parse(await zip.files[notesName].async('string'))).join('').replace(/\n{2,}/g, '\n').trim()
    }
    out.push(`<!-- Slide number: ${i + 1} -->\n${text}${notes ? `\n\n### Notes:\n${notes}` : ''}`)
  }
  return out.join('\n\n')
}

async function pdf(buf) {
  const { extractText, getDocumentProxy } = await import('./vendor/unpdf.js')
  const doc = await getDocumentProxy(new Uint8Array(buf))
  const { text } = await extractText(doc, { mergePages: false })
  return text.map((t, i) => `<!-- Page ${i + 1} -->\n${t.trim()}`).join('\n\n')
}

async function zipFile(buf, depth) {
  const zip = await JSZip.loadAsync(buf)
  const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir)
  if (names.length > MAX_ZIP_ENTRIES) throw new Error(`zip has ${names.length} entries (limit ${MAX_ZIP_ENTRIES})`)
  let budget = MAX_ZIP_BYTES
  const out = []
  for (const n of names) {
    if (n.includes('..') || n.startsWith('/')) continue // path traversal guard (we never write to disk anyway)
    const ext = extOf(n)
    if (!SUPPORTED.includes(ext) || (ext === 'zip' && depth >= 1)) continue
    const data = await zip.files[n].async('nodebuffer')
    budget -= data.length
    if (budget < 0) throw new Error('zip uncompressed size budget exceeded')
    out.push(`## File: ${n}\n\n${await convertBuffer(data, n, depth + 1)}`)
  }
  return out.join('\n\n')
}

/** Convert an in-memory file to Markdown. `name` only supplies the extension. */
export async function convertBuffer(buf, name, depth = 0) {
  const ext = extOf(name)
  switch (ext) {
    case 'docx': return docx(buf)
    case 'xlsx': return xlsx(buf)
    case 'pptx': return pptx(buf)
    case 'pdf': return pdf(buf)
    case 'zip': return zipFile(buf, depth)
    case 'html': case 'htm': return td.turndown(buf.toString('utf8'))
    case 'csv': return rowsToMarkdown(parseDelimited(buf.toString('utf8'), ','))
    case 'tsv': return rowsToMarkdown(parseDelimited(buf.toString('utf8'), '\t'))
    case 'json': {
      const text = buf.toString('utf8')
      try { return '```json\n' + JSON.stringify(JSON.parse(text), null, 2) + '\n```' } catch { return text }
    }
    case 'xml': return '```xml\n' + buf.toString('utf8') + '\n```'
    case 'txt': case 'md': return buf.toString('utf8')
    default: throw new Error(`unsupported format ".${ext}". Supported: ${SUPPORTED.join(', ')}`)
  }
}
