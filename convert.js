// Core document → Markdown conversion. No Python, no network, no child processes.
// Mirrors MarkItDown's offline converters: DOCX, PPTX, XLSX, PDF, HTML, CSV/JSON/XML/text, ZIP.
// Images embedded in DOCX and PPTX are collected (see images.js) and leave a sentinel in the text.
// Third-party libs come pre-bundled (see build-vendor.mjs): local plugins are installed as
// `link:` symlinks, so their npm dependencies are never installed.
import { posix } from 'node:path'
import { JSZip, mammoth, TurndownService, gfm, XMLParser, ExcelJS } from './vendor/deps.js'
import { addImage } from './images.js'

const MAX_ZIP_ENTRIES = 200
const MAX_ZIP_BYTES = 50 * 1024 * 1024 // total uncompressed budget (zip-bomb guard)

const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-' })
td.use(gfm)
td.remove(['script', 'style'])
// DOCX images arrive as <img src="dsh-image:SENTINEL"> (see docx below); keep the sentinel as is.
td.addRule('dsh-image', {
  filter: (node) => node.nodeName === 'IMG' && (node.getAttribute('src') ?? '').startsWith('dsh-image:'),
  replacement: (_content, node) => node.getAttribute('src').slice('dsh-image:'.length),
})

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

async function docx(buf, images) {
  // Without convertImage mammoth inlines every image as a base64 data URI.
  const convertImage = mammoth.images.imgElement(async (image) => ({
    src: `dsh-image:${addImage(images, await image.read(), image.altText)}`,
  }))
  const { value: html } = await mammoth.convertToHtml({ buffer: buf }, { convertImage })
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

// Every <p:pic> under `node` (pictures may sit inside group shapes).
function collectPictures(node, acc = []) {
  if (node == null || typeof node !== 'object') return acc
  for (const [k, v] of Object.entries(node)) {
    if (k === 'p:pic') arr(v).forEach((pic) => acc.push({
      alt: pic?.['p:nvPicPr']?.['p:cNvPr']?.['@_descr'] ?? '',
      rel: pic?.['p:blipFill']?.['a:blip']?.['@_r:embed'],
    }))
    else if (typeof v === 'object') arr(v).forEach((c) => collectPictures(c, acc))
  }
  return acc
}

// Relationship id → zip path, from one slide's `_rels` file.
async function slideTargets(zip, slideName) {
  const relsName = `${posix.dirname(slideName)}/_rels/${posix.basename(slideName)}.rels`
  const targets = new Map()
  if (!zip.files[relsName]) return targets
  const rels = xml.parse(await zip.files[relsName].async('string'))
  for (const r of arr(rels?.Relationships?.Relationship)) {
    if (r['@_TargetMode'] === 'External' || !r['@_Target']) continue
    targets.set(r['@_Id'], posix.normalize(posix.join(posix.dirname(slideName), r['@_Target'])))
  }
  return targets
}

async function slideImages(zip, slideName, doc, images) {
  const pictures = collectPictures(doc)
  if (!pictures.length) return ''
  const targets = await slideTargets(zip, slideName)
  const marks = []
  for (const { alt, rel } of pictures) {
    const file = zip.files[targets.get(rel)]
    if (file) marks.push(addImage(images, await file.async('nodebuffer'), alt))
  }
  return marks.join('\n')
}

async function pptx(buf, images) {
  const zip = await JSZip.loadAsync(buf)
  const slides = Object.keys(zip.files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => parseInt(a.match(/(\d+)\.xml/)[1]) - parseInt(b.match(/(\d+)\.xml/)[1]))
  const out = []
  for (const [i, name] of slides.entries()) {
    const doc = xml.parse(await zip.files[name].async('string'))
    const text = collectText(doc).join('').replace(/\n{2,}/g, '\n').trim()
    const pictures = await slideImages(zip, name, doc, images)
    const notesName = `ppt/notesSlides/notesSlide${name.match(/(\d+)\.xml/)[1]}.xml`
    let notes = ''
    if (zip.files[notesName]) {
      notes = collectText(xml.parse(await zip.files[notesName].async('string'))).join('').replace(/\n{2,}/g, '\n').trim()
    }
    out.push(`<!-- Slide number: ${i + 1} -->\n${text}${pictures ? `\n\n${pictures}` : ''}${notes ? `\n\n### Notes:\n${notes}` : ''}`)
  }
  return out.join('\n\n')
}

async function pdf(buf) {
  const { extractText, getDocumentProxy } = await import('./vendor/unpdf.js')
  const doc = await getDocumentProxy(new Uint8Array(buf))
  const { text } = await extractText(doc, { mergePages: false })
  return text.map((t, i) => `<!-- Page ${i + 1} -->\n${t.trim()}`).join('\n\n')
}

async function zipFile(buf, depth, images) {
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
    out.push(`## File: ${n}\n\n${await convertTo(data, n, depth + 1, images)}`)
  }
  return out.join('\n\n')
}

/**
 * Convert an in-memory file to Markdown. `name` only supplies the extension.
 * @returns the Markdown, with one sentinel per embedded image, and the collected `images`.
 */
export async function convertBuffer(buf, name) {
  const images = []
  return { md: await convertTo(buf, name, 0, images), images }
}

async function convertTo(buf, name, depth, images) {
  const ext = extOf(name)
  switch (ext) {
    case 'docx': return docx(buf, images)
    case 'xlsx': return xlsx(buf)
    case 'pptx': return pptx(buf, images)
    case 'pdf': return pdf(buf)
    case 'zip': return zipFile(buf, depth, images)
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
