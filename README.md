# dsh-markdownize

A DeepSeek Harness (dsh) plugin that converts documents to Markdown so an LLM
can read them.

Models work best with plain text. A PDF, a Word file or a spreadsheet read as
raw bytes is noise to them. Markdown keeps the structure (headings, lists,
tables, slides, pages) while staying compact and easy to read. This plugin
gives the agent a `convert_to_markdown` tool that does that conversion
locally. You can also preview a conversion yourself before anything is sent
to the model.

## What it does

- **`convert_to_markdown` tool.** The model calls it with a local file path
  and gets the document back as Markdown, truncated to `max_chars`
  (100,000 by default).
- **Two conversion engines.** You pick one on the plugin's page:
  - its **own engine**, a pure-JavaScript port of MarkItDown's offline
    converters, bundled with the plugin and always available;
  - **Microsoft MarkItDown** (Python), used when it is installed.
- **Debug mode.** Preview the Markdown a file turns into from the web
  composer (**Ctrl+Shift+M**). Nothing is sent to the model.

## Supported formats

| Format | Own engine (JS) | Microsoft MarkItDown |
|---|---|---|
| PDF | yes (text per page) | yes |
| Word `.docx` | yes | yes |
| PowerPoint `.pptx` | yes (text and notes per slide) | yes |
| Excel `.xlsx` | yes (one table per sheet) | yes |
| HTML / HTM | yes | yes |
| CSV / TSV | yes (as a table) | yes |
| JSON / XML | yes (fenced code block) | yes |
| TXT / MD | yes (as is) | yes |
| ZIP | yes (each supported file inside) | yes |
| Excel 97 `.xls`, EPUB, Jupyter `.ipynb`, Outlook `.msg` | no | yes |

## Conversion engines

### Own engine (JavaScript)

`convert.js` mirrors MarkItDown's offline converters with Node libraries:

- `mammoth` for DOCX;
- `exceljs` for XLSX;
- `unpdf` (pdf.js) for PDF;
- `turndown` with GFM tables for HTML;
- `jszip` and `fast-xml-parser` for PPTX and ZIP.

It needs no Python, no network and no child processes. The libraries ship
pre-bundled in `vendor/`, so the plugin has no runtime npm dependencies. This
matters because dsh installs local plugins as `link:` dependencies, and pnpm
never installs a linked package's dependencies.

### Microsoft MarkItDown

[MarkItDown](https://github.com/microsoft/markitdown) is Microsoft's Python
tool for the same job. It gives the reference output and reads a few more
formats. Install it with:

```bash
pip install "markitdown[all]"
```

The plugin looks for it on `PATH` as `markitdown`, `py -m markitdown`,
`python -m markitdown` or `python3 -m markitdown`. If it lives somewhere else,
such as a virtualenv's `markitdown.exe`, set its command on the plugin's page.
Use double quotes around paths with spaces.

### Choosing the engine

Open **Plugins → dsh-markdownize**. The page shows which engines were found.
When both are available, choose:

- **Automatic** (the default): MarkItDown when it is found, otherwise the
  JavaScript engine.
- **Always MarkItDown**: conversions fail if it is missing.
- **Always JavaScript**.

The choice and the custom command are saved in
`<dshHome>/storages/dsh-markdownize/settings.json`. They apply to both the
tool and debug mode. MarkItDown is detected once per Host start; press
**Search again** after installing it.

## Install

The plugin needs no build step and no Python. For a `web` profile:

```bash
dsh plugin --profile web add ./dsh-markdownize
```

```bash
dsh --profile web --dump-config
```

The dump should show a `# == dsh-markdownize` layer. Then start the client:

```bash
dsh web
```

On the `desktop` profile, add it from the app's plugin manager as a local
folder.

## Debug mode (web client)

1. Attach a compatible file to the composer, or mention one with `@`.
2. Press **Ctrl+Shift+M**.

Each compatible attachment and `@file` reference is converted on the Host.
`@file` paths are resolved against the Session's workspace. The full output,
with no truncation, is written to `<os tmpdir>/dsh-markdownize-debug/` and
opened in the right Sidebar preview. A composer notice reports its size, path
and the engine used.

Nothing is sent to the model, and the draft is left as it was. Images and
unsupported formats are skipped.

## Limits and safety

- Only local files: URLs are rejected (use the web tools for those).
- Files are read with the privileges of the dsh process.
- Files are capped at 50 MB.
- ZIPs are capped at 200 entries and 50 MB uncompressed, and nest at most one
  level deep.
- Tool output is truncated at 100,000 characters by default.

**Not covered:** OCR of scanned documents, audio transcription, YouTube,
image captioning, Azure Document Intelligence, and the legacy `.doc` and
`.ppt` formats.

## Structure

- `index.js` — the Host half. It registers the `convert_to_markdown` tool and
  the `markdownize` service (`convert`, `convertPath`, `status`, `configure`,
  `redetect`), served through the Gateway's SRC fallback.
- `engine.js` — engine selection, MarkItDown detection and invocation, and
  the saved settings.
- `convert.js` — the JavaScript engine.
- `client.js` — the Client half: the engine page under **Plugins**, the
  debug-mode shortcut, and the `en` / `es` / `zh` UI strings.
- `locale/` — the plugin's localized title and description.
- `cordis.patch.yml` — inserts the `dsh-markdownize` plugin row.
- `vendor/` — the bundled converter libraries (generated; committed).
- `build-vendor.mjs` — rebuilds `vendor/`.

## Rebuilding vendor/

After changing a converter's version in `devDependencies`:

```bash
npm install && npm run build
```

Commit the regenerated `vendor/` files: the plugin loads them at runtime.

## License

Copyright 2026 gorkaseto. Licensed under the
[Apache License, Version 2.0](LICENSE); see [NOTICE](NOTICE) for the bundled
third-party libraries and their licenses.
