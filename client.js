/**
 * Client half of dsh-markdownize: debug mode.
 *
 * With a compatible file in the composer (pdf, docx, pptx, xlsx, html, csv…) — attached, or as an
 * `@file` reference chip — press Ctrl+Shift+M: each one is converted to Markdown by the Host half
 * (`markdownize/convert` for attachment bytes, `markdownize/convertPath` for references, written to
 * a temp `.md`) and opened in the right Sidebar preview.
 * Nothing is sent to the model; the draft stays untouched.
 *
 * The composer has no keyboard extension seat, so an invisible entry in the session-scoped
 * `conversation.input.left` list holds the shortcut while its session's composer is mounted.
 * The draft's browser `File` objects come from `ctx.conversation` (input state ids →
 * `resolveDraftAttachments`).
 *
 * The plugin's page (Plugins → dsh-markdownize, `plugins.bundle.config` keyed by the package name)
 * shows which engines are available — the bundled JS port and Microsoft's MarkItDown (Python) —
 * and, when both are, lets the user pick one (`markdownize/status`, `configure`, `redetect`).
 */
window.__ModuleLoader__.load({
  id: 'dsh-markdownize',
  factory(require) {
    const React = require('react')
    const { useCallback, useEffect, useState } = React
    const h = React.createElement

    const SLOT = 'conversation.input.left'
    const CONFIG_SLOT = 'plugins.bundle.config'
    const PACKAGE = 'dsh-markdownize'
    const NS = 'dsh-markdownize'
    // Everything either engine reads; the Host rejects what the engine in force cannot.
    const FORMATS = ['pdf', 'docx', 'pptx', 'xlsx', 'html', 'htm', 'csv', 'tsv', 'json', 'xml', 'txt', 'md', 'zip', 'xls', 'epub', 'ipynb', 'msg']
    const MAX_FILE_BYTES = 50 * 1024 * 1024

    const extOf = (name) => (/\.([A-Za-z0-9]+)$/.exec(name)?.[1] ?? '').toLowerCase()
    const isShortcut = (e) => e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && e.code === 'KeyM'
    const errorText = (error) => (error instanceof Error ? error.message : String(error))

    async function toBase64(file) {
      const bytes = new Uint8Array(await file.arrayBuffer())
      let binary = ''
      for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
      return btoa(binary)
    }

    // Same grammar as fileAddressFor in @deepseek-ai/dsh-util-workspace-path for an absolute path.
    function sessionFileAddress(sessionId, path) {
      const seg = (s) => encodeURIComponent(s).replace(/%3A/gi, ':')
      return `dsh-resource://file/session/${seg(sessionId)}/${path.replace(/\\/g, '/').split('/').map(seg).join('/')}`
    }

    // An `@file` chip's ref is its mention: `@path`, or `@"path"` when the path has spaces.
    function referencePath(ref) {
      const m = /^@"([^"]+)"$/.exec(ref) ?? /^@([^"\s]+)$/.exec(ref)
      return m?.[1]
    }

    // The last mounted composer owns the shortcut (one composer is visible at a time).
    const owners = []

    function ShortcutHolder({ run }) {
      useEffect(() => {
        owners.push(run)
        return () => { owners.splice(owners.lastIndexOf(run), 1) }
      }, [run])
      return null
    }

    // ------------------------------------------------------------ plugin page

    const en = {
      'summary.js': 'Engine: bundled JavaScript port',
      'summary.markitdown': 'Engine: Microsoft MarkItDown {version}',
      'summary.missing': 'Engine: MarkItDown selected but not found',
      'title': 'Conversion engine',
      'loading': 'Checking engines…',
      'error': 'Couldn’t read the engine status: {message}',
      'js.name': 'JavaScript port (bundled)',
      'js.detail': 'Always available. No Python. pdf, docx, pptx, xlsx, html, csv, tsv, json, xml, txt, md, zip.',
      'md.name': 'Microsoft MarkItDown (Python)',
      'md.found': 'Found: version {version} · {command}',
      'md.missing': 'Not found. Install it with:',
      'md.missing.after': 'Then press Search again, or set its command below if it lives in a virtualenv.',
      'copy': 'Copy',
      'copied': 'Copied',
      'md.detail': 'Official output; also reads xls, epub, ipynb, msg.',
      'choice': 'Use',
      'choice.auto': 'Automatic (MarkItDown when available, otherwise JavaScript)',
      'choice.markitdown': 'Always MarkItDown',
      'choice.js': 'Always JavaScript',
      'onlyJs': 'Only the JavaScript port is available, so it is used. Install MarkItDown to choose.',
      'active': 'In use now: {engine}',
      'active.none': 'In use now: none — MarkItDown is selected but missing',
      'command': 'MarkItDown command (optional)',
      'command.hint': 'Empty searches PATH (markitdown, py -m markitdown, python -m markitdown). Use quotes for paths with spaces.',
      'save': 'Save',
      'redetect': 'Search again',
      'saved': 'Saved',
    }
    const es = {
      'summary.js': 'Motor: port JavaScript incluido',
      'summary.markitdown': 'Motor: Microsoft MarkItDown {version}',
      'summary.missing': 'Motor: MarkItDown seleccionado pero no encontrado',
      'title': 'Motor de conversión',
      'loading': 'Comprobando motores…',
      'error': 'No se pudo leer el estado de los motores: {message}',
      'js.name': 'Port JavaScript (incluido)',
      'js.detail': 'Siempre disponible. Sin Python. pdf, docx, pptx, xlsx, html, csv, tsv, json, xml, txt, md, zip.',
      'md.name': 'Microsoft MarkItDown (Python)',
      'md.found': 'Encontrado: versión {version} · {command}',
      'md.missing': 'No encontrado. Instálalo con:',
      'md.missing.after': 'Después pulsa Buscar de nuevo, o indica su comando abajo si está en un virtualenv.',
      'copy': 'Copiar',
      'copied': 'Copiado',
      'md.detail': 'Salida oficial; además lee xls, epub, ipynb y msg.',
      'choice': 'Usar',
      'choice.auto': 'Automático (MarkItDown si está disponible, si no JavaScript)',
      'choice.markitdown': 'Siempre MarkItDown',
      'choice.js': 'Siempre JavaScript',
      'onlyJs': 'Solo está disponible el port JavaScript, así que se usa ese. Instala MarkItDown para poder elegir.',
      'active': 'En uso ahora: {engine}',
      'active.none': 'En uso ahora: ninguno — MarkItDown está seleccionado pero falta',
      'command': 'Comando de MarkItDown (opcional)',
      'command.hint': 'Vacío busca en el PATH (markitdown, py -m markitdown, python -m markitdown). Usa comillas para rutas con espacios.',
      'save': 'Guardar',
      'redetect': 'Buscar de nuevo',
      'saved': 'Guardado',
    }
    const zh = {
      ...en,
      'title': '转换引擎',
      'js.name': 'JavaScript 移植版（内置）',
      'md.name': 'Microsoft MarkItDown（Python）',
      'save': '保存',
      'redetect': '重新检测',
    }

    const S = {
      card: { display: 'flex', flexDirection: 'column', gap: 12, padding: '12px 0', fontSize: 13, lineHeight: '20px', color: 'var(--dsw-alias-label-primary)' },
      title: { fontSize: 14, fontWeight: 600 },
      engine: { display: 'flex', gap: 8, alignItems: 'flex-start' },
      dot: (on) => ({ flex: 'none', width: 8, height: 8, marginTop: 6, borderRadius: 4, background: on ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-label-tertiary)' }),
      muted: { color: 'var(--dsw-alias-label-secondary)' },
      error: { color: 'var(--dsw-alias-state-error-primary)' },
      fieldset: { border: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 },
      radio: { display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer' },
      row: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
      input: { flex: '1 1 260px', minWidth: 0, padding: '5px 8px', borderRadius: 8, border: '1px solid var(--dsw-alias-separator-primary, var(--dsw-alias-label-tertiary))', background: 'transparent', color: 'inherit', font: 'inherit', fontFamily: 'var(--dsw-font-family-mono, monospace)' },
      install: { display: 'flex', alignItems: 'center', gap: 8, margin: '6px 0', padding: '6px 6px 6px 12px', borderRadius: 8, background: 'var(--dsw-alias-bg-secondary, var(--dsw-alias-fill-secondary, rgba(127,127,127,.12)))', border: '1px solid var(--dsw-alias-separator-primary, var(--dsw-alias-label-tertiary))' },
      code: { flex: 1, minWidth: 0, overflowX: 'auto', whiteSpace: 'nowrap', fontFamily: 'var(--dsw-font-family-mono, ui-monospace, Consolas, monospace)', fontSize: 13, fontWeight: 600, color: 'var(--dsw-alias-label-primary)', userSelect: 'all' },
      button: { padding: '5px 12px', borderRadius: 8, border: '1px solid var(--dsw-alias-separator-primary, var(--dsw-alias-label-tertiary))', background: 'transparent', color: 'inherit', font: 'inherit', cursor: 'pointer' },
    }

    const INSTALL_COMMAND = 'pip install "markitdown[all]"'

    function InstallHint({ t }) {
      const [copied, setCopied] = useState(false)
      const copy = () => {
        navigator.clipboard?.writeText(INSTALL_COMMAND).then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        }, () => {})
      }
      return h('div', null,
        h('div', { style: S.muted }, t('md.missing')),
        h('div', { style: S.install },
          h('code', { style: S.code }, INSTALL_COMMAND),
          h('button', { type: 'button', style: S.button, onClick: copy }, copied ? t('copied') : t('copy'))),
        h('div', { style: S.muted }, t('md.missing.after')))
    }

    function EngineConfig({ t, view, api }) {
      const [state, setState] = useState({ loading: true })
      const [command, setCommand] = useState('')
      const [busy, setBusy] = useState(false)
      const [saved, setSaved] = useState(false)

      const apply = useCallback((promise) => {
        setBusy(true)
        setSaved(false)
        return promise.then(
          (status) => { setState({ status }); setCommand(status.command); return status },
          (error) => { setState((s) => ({ ...s, error: errorText(error) })) },
        ).finally(() => setBusy(false))
      }, [])

      useEffect(() => { apply(api.status()) }, [api, apply])

      const { status, error, loading } = state
      if (view === 'summary') {
        if (!status) return null
        if (status.active === 'markitdown') return t('summary.markitdown', { version: status.markitdown.version })
        return status.active === 'js' ? t('summary.js') : t('summary.missing')
      }
      if (loading && !error) return h('div', { style: { ...S.card, ...S.muted } }, t('loading'))
      if (!status) return h('div', { style: { ...S.card, ...S.error } }, t('error', { message: error }))

      const found = status.markitdown
      const choose = (engine) => apply(api.configure(engine, status.command))
      const activeName = status.active === 'markitdown' ? t('md.name') : t('js.name')

      return h('div', { style: S.card },
        h('div', { style: S.title }, t('title')),
        h('div', { style: S.engine }, h('span', { style: S.dot(true) }),
          h('div', null, h('div', null, t('js.name')), h('div', { style: S.muted }, t('js.detail')))),
        h('div', { style: S.engine }, h('span', { style: S.dot(Boolean(found)) }),
          h('div', null, h('div', null, t('md.name')),
            found
              ? h('div', { style: S.muted }, t('md.found', { version: found.version, command: found.command }))
              : h(InstallHint, { t }),
            found && h('div', { style: S.muted }, t('md.detail')))),
        found || status.engine !== 'auto'
          ? h('fieldset', { style: S.fieldset, disabled: busy },
              h('legend', { style: { ...S.muted, padding: 0, marginBottom: 4 } }, t('choice')),
              ['auto', 'markitdown', 'js'].map((engine) => h('label', { key: engine, style: S.radio },
                h('input', { type: 'radio', name: 'dsh-markdownize-engine', checked: status.engine === engine, onChange: () => choose(engine) }),
                t(`choice.${engine}`))))
          : h('div', { style: S.muted }, t('onlyJs')),
        h('div', null, status.active ? t('active', { engine: activeName }) : h('span', { style: S.error }, t('active.none'))),
        h('div', { style: S.fieldset },
          h('label', { htmlFor: 'dsh-markdownize-command', style: S.muted }, t('command')),
          h('div', { style: S.row },
            h('input', { id: 'dsh-markdownize-command', style: S.input, value: command, spellCheck: false, placeholder: 'markitdown', onChange: (e) => { setCommand(e.target.value); setSaved(false) } }),
            h('button', { type: 'button', style: S.button, disabled: busy || command.trim() === status.command,
              onClick: () => apply(api.configure(status.engine, command)).then((s) => { if (s) setSaved(true) }) }, t('save')),
            h('button', { type: 'button', style: S.button, disabled: busy, onClick: () => apply(api.redetect()) }, t('redetect')),
            saved && h('span', { style: S.muted }, t('saved'))),
          h('div', { style: S.muted }, t('command.hint'))),
        error && h('div', { style: S.error }, t('error', { message: error })))
    }

    return {
      inject: ['connection', 'slots', 'locale', 'sessions', 'conversation', 'sidebarRight'],
      apply(ctx) {
        const call = async (endpoint, args) => {
          const result = await ctx.connection.rpc.call('/api', endpoint, { args })
          if (!result.ok) throw new Error(result.error?.message ?? result.error?.code ?? 'unknown failure')
          return result.value
        }

        ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'dsh-markdownize: locale dictionaries')
        ctx.effect(() => {
          try { return ctx.locale.register(NS, 'es', es) } catch { return () => {} }
        }, 'dsh-markdownize: es dictionary')

        const api = {
          status: () => call('markdownize/status', {}),
          configure: (engine, command) => call('markdownize/configure', { engine, command }),
          redetect: () => call('markdownize/redetect', {}),
        }
        ctx.slots.inject(CONFIG_SLOT, () => ctx.slots.register({
          name: CONFIG_SLOT,
          key: PACKAGE,
          locale: NS,
          inject: () => ({ api }),
        }, EngineConfig))

        const busy = new Set()
        async function convertDraft(sessionId) {
          const actx = ctx.sessions.scope(sessionId)
          if (actx === undefined || busy.has(sessionId)) return
          const input = ctx.conversation.input.for(actx)
          const { attachmentIds, occurrences } = input.state.getSnapshot()
          const cwd = ctx.sessions.list.getSnapshot().byId[sessionId]?.cwd ?? ''
          // Draft attachments (browser bytes) and `@file` reference chips (Host paths), in input order.
          const jobs = [
            ...ctx.conversation.resolveDraftAttachments(attachmentIds).map((a) => a.file)
              .filter((f) => FORMATS.includes(extOf(f.name)))
              .map((file) => ({
                name: file.name,
                run: async () => {
                  if (file.size > MAX_FILE_BYTES) throw new Error(`${file.size} bytes (limit ${MAX_FILE_BYTES})`)
                  return call('markdownize/convert', { name: file.name, data: await toBase64(file) })
                },
              })),
            ...occurrences
              .filter((o) => o.source === 'reference' && o.appearance === 'file' && !o.invalid)
              .map((o) => referencePath(o.ref))
              .filter((p) => p !== undefined && FORMATS.includes(extOf(p)))
              .map((path) => ({ name: path, run: () => call('markdownize/convertPath', { path, cwd }) })),
          ]
          if (!jobs.length) {
            input.notify('info', `Markdownize debug: no compatible attachment or @file reference (${FORMATS.join(', ')})`)
            return
          }
          busy.add(sessionId)
          try {
            for (const job of jobs) {
              try {
                const { path, chars, engine } = await job.run()
                ctx.sidebarRight.openResource(sessionFileAddress(sessionId, path))
                input.notify('info', `Markdownize debug [${engine}]: ${job.name} → ${chars} chars (${path})`)
              } catch (error) {
                input.notify('error', `Markdownize debug: ${job.name}: ${errorText(error)}`)
              }
            }
          } finally {
            busy.delete(sessionId)
          }
        }

        ctx.effect(() => {
          const onKey = (e) => {
            if (!isShortcut(e) || !owners.length) return
            e.preventDefault()
            e.stopPropagation()
            owners[owners.length - 1]()
          }
          window.addEventListener('keydown', onKey, true)
          return () => window.removeEventListener('keydown', onKey, true)
        }, 'dsh-markdownize: debug shortcut')

        const runners = new Map()
        ctx.slots.inject(SLOT, () => ctx.slots.register({
          name: SLOT,
          id: 'dsh-markdownize.debug-shortcut',
          inject: (sessionId) => {
            if (!runners.has(sessionId)) runners.set(sessionId, () => { convertDraft(sessionId) })
            return { run: runners.get(sessionId) }
          },
        }, ShortcutHolder))
      },
    }
  },
})
