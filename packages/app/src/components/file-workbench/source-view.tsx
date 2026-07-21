import { createEffect, createSignal, onCleanup, onMount } from "solid-js"
import { useLingui } from "@lingui/solid"
import { Spinner } from "@ericsanchezok/synergy-ui/spinner"
import { resolveThemeColor, useTheme, type ResolvedTheme } from "@ericsanchezok/synergy-ui/theme"
import { useFile } from "@/context/file"
import { useSDK } from "@/context/sdk"
import { getFileSourceModel, pruneFileSourceModels, setFileSourceModel } from "./source-model-cache"
import { fileWorkbench as F } from "@/locales/messages"

type Monaco = typeof import("monaco-editor")
let monacoPromise: Promise<Monaco> | undefined

function loadMonaco() {
  if (monacoPromise) return monacoPromise
  monacoPromise = Promise.all([
    import("monaco-editor/esm/vs/editor/editor.api.js"),
    import("monaco-editor/esm/vs/editor/editor.worker?worker"),
    Promise.all([
      import("monaco-editor/esm/vs/basic-languages/cpp/cpp.contribution.js"),
      import("monaco-editor/esm/vs/basic-languages/css/css.contribution.js"),
      import("monaco-editor/esm/vs/basic-languages/go/go.contribution.js"),
      import("monaco-editor/esm/vs/basic-languages/html/html.contribution.js"),
      import("monaco-editor/esm/vs/basic-languages/ini/ini.contribution.js"),
      import("monaco-editor/esm/vs/basic-languages/java/java.contribution.js"),
      import("monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution.js"),
      import("monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution.js"),
      import("monaco-editor/esm/vs/basic-languages/python/python.contribution.js"),
      import("monaco-editor/esm/vs/basic-languages/rust/rust.contribution.js"),
      import("monaco-editor/esm/vs/basic-languages/shell/shell.contribution.js"),
      import("monaco-editor/esm/vs/basic-languages/sql/sql.contribution.js"),
      import("monaco-editor/esm/vs/basic-languages/xml/xml.contribution.js"),
      import("monaco-editor/esm/vs/basic-languages/yaml/yaml.contribution.js"),
    ]),
  ]).then(([monaco, worker]) => {
    ;(self as typeof self & { MonacoEnvironment?: unknown }).MonacoEnvironment = {
      getWorker: () => new worker.default(),
    }
    return monaco as unknown as Monaco
  })
  return monacoPromise
}

function languageForPath(path: string) {
  const extension = path.split(".").at(-1)?.toLowerCase()
  const languages: Record<string, string> = {
    c: "c",
    cc: "cpp",
    cpp: "cpp",
    css: "css",
    go: "go",
    html: "html",
    java: "java",
    js: "javascript",
    json: "javascript",
    jsonc: "javascript",
    jsx: "javascript",
    md: "markdown",
    mdx: "markdown",
    py: "python",
    rs: "rust",
    sh: "shell",
    sql: "sql",
    svg: "xml",
    toml: "ini",
    ts: "javascript",
    tsx: "javascript",
    xml: "xml",
    yaml: "yaml",
    yml: "yaml",
  }
  return extension ? (languages[extension] ?? "plaintext") : "plaintext"
}

function defineSourceTheme(monaco: Monaco, tokens: ResolvedTheme, mode: "light" | "dark") {
  const dark = mode === "dark"
  const theme = dark ? "synergy-file-readonly-dark" : "synergy-file-readonly-light"
  monaco.editor.defineTheme(theme, {
    base: dark ? "vs-dark" : "vs",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": resolveThemeColor(tokens, "surface-raised-base"),
      "editor.foreground": resolveThemeColor(tokens, "text-base"),
      "editorLineNumber.foreground": resolveThemeColor(tokens, "text-weaker"),
      "editorLineNumber.activeForeground": resolveThemeColor(tokens, "text-strong"),
      "editor.selectionBackground": resolveThemeColor(tokens, "surface-info-base"),
      "editor.lineHighlightBackground": resolveThemeColor(tokens, "surface-raised-base-hover"),
      "editorCursor.foreground": resolveThemeColor(tokens, "text-strong"),
    },
  })
  return theme
}

export function FileSourceView(props: { path: string; content: string }) {
  const file = useFile()
  const sdk = useSDK()
  const theme = useTheme()
  const lingui = useLingui()
  const [loading, setLoading] = createSignal(true)
  let host!: HTMLDivElement
  let monacoInstance: Monaco | undefined
  let editor: import("monaco-editor").editor.IStandaloneCodeEditor | undefined
  let disposed = false
  let currentContent = props.content

  onMount(() => {
    void loadMonaco().then((monaco) => {
      if (disposed) return
      monacoInstance = monaco
      const scope = encodeURIComponent(sdk.scopeKey)
      const uri = monaco.Uri.parse(`synergy-file://${scope}/${props.path.split("/").map(encodeURIComponent).join("/")}`)
      const key = uri.toString()
      let cached = getFileSourceModel(key)
      if (!cached || cached.model.isDisposed()) {
        const model = monaco.editor.createModel(props.content, languageForPath(props.path), uri)
        cached = { model, bytes: new Blob([props.content]).size, touched: Date.now() }
        setFileSourceModel(key, cached)
      } else {
        cached.touched = Date.now()
        if (cached.model.getValue() !== props.content) cached.model.setValue(props.content)
      }

      const style = getComputedStyle(host)
      const sourceTheme = defineSourceTheme(monaco, theme.tokens(), theme.mode())
      editor = monaco.editor.create(host, {
        model: cached.model,
        theme: sourceTheme,
        readOnly: true,
        domReadOnly: true,
        minimap: { enabled: false },
        automaticLayout: true,
        folding: true,
        lineNumbers: "on",
        glyphMargin: false,
        renderLineHighlight: "line",
        scrollBeyondLastLine: false,
        smoothScrolling: true,
        wordWrap: "off",
        quickSuggestions: false,
        suggest: { showWords: false },
        fontFamily: style.getPropertyValue("--font-mono").trim() || "monospace",
        fontSize: 14,
        lineHeight: 22,
        padding: { top: 12, bottom: 18 },
        scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
      })
      editor.setScrollPosition({
        scrollTop: file.view.sourceScrollTop(props.path) ?? 0,
        scrollLeft: file.view.sourceScrollLeft(props.path) ?? 0,
      })
      const selected = file.view.selectedLines(props.path)
      if (selected) {
        editor.setSelection({
          startLineNumber: selected.start,
          startColumn: 1,
          endLineNumber: selected.end,
          endColumn: cached.model.getLineMaxColumn(selected.end),
        })
      }
      editor.onDidScrollChange((event) => {
        file.view.setSourceScroll(props.path, event.scrollTop, event.scrollLeft)
      })
      editor.onDidChangeCursorSelection((event) => {
        const selection = event.selection
        file.view.setSelectedLines(props.path, {
          start: selection.startLineNumber,
          end: selection.endLineNumber,
        })
      })
      pruneFileSourceModels(key)
      setLoading(false)
    })
  })

  createEffect(() => {
    if (props.content === currentContent) return
    currentContent = props.content
    const model = editor?.getModel()
    if (!model || model.getValue() === props.content) return
    const state = editor?.saveViewState()
    model.setValue(props.content)
    if (state) editor?.restoreViewState(state)
  })

  createEffect(() => {
    const mode = theme.mode()
    const tokens = theme.tokens()
    if (!monacoInstance || !editor) return
    monacoInstance.editor.setTheme(defineSourceTheme(monacoInstance, tokens, mode))
  })

  onCleanup(() => {
    disposed = true
    editor?.dispose()
  })

  return (
    <div class="file-source-view">
      <div ref={host} class="file-source-view-editor" />
      {loading() && (
        <div class="file-workbench-loading">
          <Spinner class="size-5" />
          <span>{lingui._({ id: F.loadingSourceViewer.id, message: F.loadingSourceViewer.message })}</span>
        </div>
      )}
    </div>
  )
}
