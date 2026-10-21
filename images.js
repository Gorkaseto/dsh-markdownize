// Images embedded in converted documents (DOCX, PPTX). Converters record each image in a collector
// and leave a sentinel where it sat in the Markdown; this module turns sentinels into text markers
// (`[Image 3: alt]`) or, when the calling model accepts image input, into image blocks interleaved
// with the text at the same spot. No image decoding happens here: the attachment service validates
// and downscales what it stores.
import { createHash } from 'node:crypto'

export const IMAGE_MODES = ['inline', 'none']
export const DEFAULT_MAX_IMAGES = 10
// Smaller than this on both sides is an icon, bullet or rule: noise that would eat the image budget.
const MIN_SIDE = 32

const SENTINEL = /(\d+)/g
const sentinel = (i) => `${i}`

/**
 * Record one image and return the sentinel to place in the Markdown. A repeated image (the same
 * logo on every slide) points back to its first occurrence instead of being sent again.
 */
export function addImage(images, data, alt = '') {
  const hash = createHash('sha1').update(data).digest('hex')
  const first = images.find((img) => img.hash === hash && img.sameAs === undefined)
  images.push(first
    ? { hash, sameAs: first.index, alt: cleanAlt(alt), index: images.length + 1 }
    : { hash, data, alt: cleanAlt(alt), index: images.length + 1, ...sniff(data) })
  return sentinel(images.length - 1)
}

const cleanAlt = (alt) => String(alt ?? '').replace(/\s+/g, ' ').replace(/[[\]]/g, '').trim()

/** Media type and intrinsic size from the file header; `mediaType` is undefined for EMF, TIFF… */
export function sniff(b) {
  const at = (s, o = 0) => b.length >= o + s.length && [...s].every((c, i) => b[o + i] === c.charCodeAt(0))
  if (b.length >= 24 && b[0] === 0x89 && at('PNG', 1)) return { mediaType: 'image/png', width: b.readUInt32BE(16), height: b.readUInt32BE(20) }
  if (b.length >= 10 && (at('GIF87a') || at('GIF89a'))) return { mediaType: 'image/gif', width: b.readUInt16LE(6), height: b.readUInt16LE(8) }
  if (b.length >= 30 && at('RIFF') && at('WEBP', 8)) {
    if (at('VP8 ', 12)) return { mediaType: 'image/webp', width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff }
    if (at('VP8L', 12)) {
      const v = b.readUInt32LE(21)
      return { mediaType: 'image/webp', width: (v & 0x3fff) + 1, height: ((v >> 14) & 0x3fff) + 1 }
    }
    if (at('VP8X', 12)) return { mediaType: 'image/webp', width: b.readUIntLE(24, 3) + 1, height: b.readUIntLE(27, 3) + 1 }
    return { mediaType: 'image/webp' }
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    // Walk the segments to the first start-of-frame (SOF0–SOF15 except DHT, JPG, DAC).
    for (let o = 2; o + 9 < b.length;) {
      if (b[o] !== 0xff) { o++; continue }
      const m = b[o + 1]
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        return { mediaType: 'image/jpeg', width: b.readUInt16BE(o + 7), height: b.readUInt16BE(o + 5) }
      }
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { o += 2; continue }
      o += 2 + b.readUInt16BE(o + 2)
    }
    return { mediaType: 'image/jpeg' }
  }
  return {}
}

const isTiny = (img) => img.width !== undefined && img.width < MIN_SIDE && img.height < MIN_SIDE

function marker(img, note) {
  const label = img.alt ? `Image ${img.index}: ${img.alt}` : `Image ${img.index}`
  return `[${label}${note ? ` — ${note}` : ''}]`
}

// Remove the sentinels of icons with no alt text (and unknown indices), plus the paragraph break
// an icon alone in its paragraph would leave doubled.
function dropIcons(md, images) {
  const gone = (img) => !img || (isTiny(img) && !img.alt)
  return md
    .replace(SENTINEL, (all, i) => (gone(images[Number(i)]) ? '' : all))
    .replace(/\n\n(?=\n\n)/g, '')
    .replace(//g, '')
}

function fixedNote(img) {
  if (img.sameAs !== undefined) return `same as image ${img.sameAs}`
  if (!img.mediaType) return 'format not supported'
  return undefined
}

/** Cut Markdown that may hold sentinels without leaving half of one at the end. */
export function truncateMarkdown(md, limit) {
  if (md.length <= limit) return { md, cut: 0 }
  const head = md.slice(0, limit).replace(/\d*$/, '')
  return { md: head, cut: md.length - head.length }
}

/**
 * Replace every sentinel with a text marker. `why` (optional) explains, once at the end, why the
 * images themselves are not included.
 */
export function imagesAsText(md, images, why) {
  let shown = 0
  const out = dropIcons(md, images).replace(SENTINEL, (_, i) => {
    const img = images[Number(i)]
    if (img.sameAs === undefined && img.mediaType && !isTiny(img)) shown++
    return marker(img, fixedNote(img))
  })
  return why && shown ? `${out}\n\n[${shown} image(s) not included: ${why}]` : out
}

/**
 * Store up to `max` images as attachments and return the tool value: the Markdown with text
 * markers, plus each stored image and the character offset its block follows.
 */
export async function imagesInline(md, images, { attachments, max }) {
  const limits = attachments.imageLimits
  const cap = Math.min(max, limits.maxImagesPerMessage)
  const byteCap = Math.min(limits.maxImageBytes, limits.maxMessageImageBytes)
  let bytes = 0
  const stored = []
  let markdown = ''
  let last = 0
  md = dropIcons(md, images)
  for (const m of md.matchAll(SENTINEL)) {
    markdown += md.slice(last, m.index)
    last = m.index + m[0].length
    const img = images[Number(m[1])]
    let note = fixedNote(img)
    if (!note && isTiny(img)) note = 'icon, not included'
    if (!note && !limits.mediaTypes.includes(img.mediaType)) note = `${img.mediaType} not accepted`
    if (!note && stored.length >= cap) note = `not included: image limit (${cap}) reached`
    if (!note && (img.data.length > byteCap || bytes + img.data.length > limits.maxMessageImageBytes)) note = 'not included: too large'
    let ref
    if (!note) {
      try {
        ref = await attachments.saveImage({ data: new Uint8Array(img.data), mediaType: img.mediaType, name: `image-${img.index}` })
        bytes += img.data.length
      } catch (error) {
        note = `not included: ${error?.code ?? error?.message ?? 'could not be stored'}`
      }
    }
    markdown += marker(img, note)
    if (ref) stored.push({ offset: markdown.length, image: imageValue(ref) })
  }
  markdown += md.slice(last)
  return stored.length ? { markdown, images: stored } : markdown
}

function imageValue(ref) {
  return {
    attachmentId: String(ref.attachmentId),
    mediaType: ref.mediaType,
    bytes: ref.bytes,
    width: ref.width,
    height: ref.height,
    ...(ref.name === undefined ? {} : { name: ref.name }),
    ...(ref.originalDimensions === undefined ? {} : { originalDimensions: { ...ref.originalDimensions } }),
  }
}

const IMAGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    attachmentId: { type: 'string', required: true },
    mediaType: { type: 'string', required: true },
    bytes: { type: 'integer', required: true },
    width: { type: 'integer', required: true },
    height: { type: 'integer', required: true },
    name: { type: 'string' },
    originalDimensions: {
      type: 'object',
      additionalProperties: false,
      properties: { width: { type: 'integer', required: true }, height: { type: 'integer', required: true } },
    },
  },
}

/** Tool output: plain Markdown, or Markdown with images to interleave. */
export const OUTPUT_SCHEMA = {
  oneOf: [
    { type: 'string' },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        markdown: { type: 'string', required: true },
        images: {
          type: 'array',
          required: true,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: { offset: { type: 'integer', required: true }, image: { ...IMAGE_SCHEMA, required: true } },
          },
        },
      },
    },
  ],
}

/** Content blocks for the tool value: text, then each image right after its marker. */
export function renderValue(value) {
  if (typeof value === 'string') return [{ type: 'text', text: value }]
  const blocks = []
  let last = 0
  for (const { offset, image } of value.images) {
    if (offset > last) blocks.push({ type: 'text', text: value.markdown.slice(last, offset) })
    blocks.push({ type: 'image', attachment: { ...image } })
    last = offset
  }
  if (last < value.markdown.length) blocks.push({ type: 'text', text: value.markdown.slice(last) })
  return blocks
}
