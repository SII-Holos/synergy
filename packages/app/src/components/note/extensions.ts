import { type CommandProps, type Editor, Extension, Node, mergeAttributes } from "@tiptap/core"
import { Plugin, PluginKey } from "@tiptap/pm/state"
import { CellSelection, tableEditingKey } from "@tiptap/pm/tables"
import { FileHandler } from "@tiptap/extension-file-handler"
import mermaid from "mermaid"
import { assetHttpUrl } from "@/utils/asset-url"
import {
  getAppliedTheme,
  resolveThemeColor,
  THEME_CHANGE_EVENT,
  type ThemeChangeDetail,
  type ThemeTokenName,
} from "@ericsanchezok/synergy-ui/theme"

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    video: {
      setVideo: (options: { src: string; controls?: boolean }) => ReturnType
    }
    mermaid: {
      setMermaid: (attrs?: { content?: string }) => ReturnType
    }
  }
}

const crossCellSelectionKey = new PluginKey("crossCellSelection")

/**
 * Fixes cross-cell drag selection in tables.
 *
 * When the user drags a text selection across table cells, ProseMirror initially
 * creates a TextSelection spanning the drag range. prosemirror-tables' normalizeSelection
 * (in tableEditing's appendTransaction) detects this and compresses it back to the first
 * cell via `TextSelection.create(doc, $from.start(), $from.end())`.
 *
 * This extension uses filterTransaction to block that specific compression. With the
 * compression blocked, the native TextSelection persists momentarily, and
 * handleMouseDown$1's mousemove handler (also in prosemirror-tables) then converts
 * it to a proper CellSelection once the mouse enters a different cell.
 */
export const CrossCellSelection = Extension.create({
  name: "crossCellSelection",

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: crossCellSelectionKey,
        filterTransaction(tr, state) {
          // Only intercept transactions from tableEditing's appendTransaction
          // (identified by the selectingCells meta key)
          if (tr.getMeta(tableEditingKey) == null) return true
          // Never block transactions that fix document structure
          if (tr.docChanged) return true

          const prevSel = state.selection
          const nextSel = tr.selection

          // Allow CellSelection changes
          if (nextSel instanceof CellSelection) return true
          // Allow if previous selection was already empty
          if (prevSel.empty) return true
          // Allow if selection wasn't changed by this transaction
          if (prevSel.eq(nextSel)) return true

          // normalizeSelection compresses cross-cell TextSelection:
          //   isTextSelectionAcrossCells → TextSelection.create(doc, $from.start(), $from.end())
          // This means: the new selection is entirely within the first cell.
          // Detect this pattern and block it.
          const { $from: prevFrom } = prevSel
          let fromCellDepth = -1
          for (let d = prevFrom.depth; d > 0; d--) {
            const role = prevFrom.node(d).type.spec.tableRole
            if (role === "cell" || role === "header_cell") {
              fromCellDepth = d
              break
            }
          }
          if (fromCellDepth < 0) return true

          const cellStart = prevFrom.start(fromCellDepth)
          const cellEnd = prevFrom.end(fromCellDepth)
          if (nextSel.from === cellStart && nextSel.to === cellEnd) {
            // Block the compression — handleMouseDown$1's mousemove will
            // create a proper CellSelection on the next mouse move
            return false
          }

          return true
        },
      }),
    ]
  },
})

let mermaidCounter = 0
let mermaidRenderQueue = Promise.resolve()

export function mermaidThemeVariables(theme: ThemeChangeDetail) {
  const color = (token: ThemeTokenName) => resolveThemeColor(theme.tokens, token)
  const series = Array.from({ length: 9 }, (_, index) => color(`chart-series-${index + 1}` as ThemeTokenName))
  return {
    darkMode: theme.mode === "dark",
    background: color("surface-raised-base"),
    primaryColor: color("surface-interactive-weak"),
    primaryTextColor: color("text-base"),
    primaryBorderColor: color("border-interactive-base"),
    secondaryColor: color("surface-info-weak"),
    secondaryTextColor: color("text-on-info-base"),
    secondaryBorderColor: color("border-info-base"),
    tertiaryColor: color("surface-inset-base"),
    tertiaryTextColor: color("text-base"),
    tertiaryBorderColor: color("border-base"),
    mainBkg: color("surface-raised-base"),
    secondBkg: color("surface-inset-base"),
    tertiaryBkg: color("surface-hover-base"),
    lineColor: color("icon-weak-base"),
    textColor: color("text-base"),
    titleColor: color("text-strong"),
    nodeTextColor: color("text-base"),
    clusterBkg: color("surface-inset-base"),
    clusterBorder: color("border-base"),
    edgeLabelBackground: color("surface-raised-base"),
    noteBkgColor: color("surface-warning-weak"),
    noteTextColor: color("text-on-warning-base"),
    noteBorderColor: color("border-warning-base"),
    actorBkg: color("surface-raised-base"),
    actorBorder: color("border-base"),
    actorTextColor: color("text-base"),
    signalColor: color("icon-base"),
    signalTextColor: color("text-base"),
    labelBoxBkgColor: color("surface-inset-base"),
    labelBoxBorderColor: color("border-base"),
    labelTextColor: color("text-base"),
    loopTextColor: color("text-base"),
    activationBkgColor: color("surface-interactive-weak"),
    activationBorderColor: color("border-interactive-base"),
    sequenceNumberColor: color("text-on-interactive-base"),
    ...Object.fromEntries(series.map((value, index) => [`pie${index + 1}`, value])),
  }
}

async function renderMermaid(code: string) {
  const theme = getAppliedTheme(document)
  if (!theme) throw new Error("Theme is not applied")
  const task = mermaidRenderQueue.then(async () => {
    mermaid.initialize({ startOnLoad: false, theme: "base", themeVariables: mermaidThemeVariables(theme) })
    return mermaid.render(`mermaid-${++mermaidCounter}`, code)
  })
  mermaidRenderQueue = task.then(
    () => undefined,
    () => undefined,
  )
  return task
}

export function subscribeMermaidThemeChanges(
  target: Pick<Document, "addEventListener" | "removeEventListener">,
  listener: (theme: ThemeChangeDetail) => void,
) {
  const handleThemeChange = (event: Event) => {
    const detail = (event as CustomEvent<ThemeChangeDetail>).detail
    if (detail?.tokens) listener(detail)
  }
  target.addEventListener(THEME_CHANGE_EVENT, handleThemeChange)
  return () => target.removeEventListener(THEME_CHANGE_EVENT, handleThemeChange)
}

export const Video = Node.create({
  name: "video",
  group: "block",
  atom: true,
  draggable: true,

  addAttributes() {
    return {
      src: { default: null },
      controls: { default: true },
    }
  },

  parseHTML() {
    return [{ tag: "video[src]" }]
  },

  renderHTML({ HTMLAttributes }) {
    return ["video", mergeAttributes(this.options.HTMLAttributes || {}, HTMLAttributes)]
  },

  addCommands() {
    return {
      setVideo:
        (options: { src: string; controls?: boolean }) =>
        ({ commands }: CommandProps) =>
          commands.insertContent({ type: this.name, attrs: options }),
    }
  },
})

export const Mermaid = Node.create({
  name: "mermaid",
  group: "block",
  atom: true,
  draggable: true,

  addAttributes() {
    return {
      content: { default: "graph TD\n  A --> B" },
    }
  },

  parseHTML() {
    return [{ tag: 'div[data-type="mermaid"]' }]
  },

  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes({ "data-type": "mermaid" }, HTMLAttributes)]
  },

  addNodeView() {
    return ({ node, getPos, editor }) => {
      const dom = document.createElement("div")
      dom.classList.add("mermaid-node")
      dom.style.cssText =
        "border-radius: 0.5rem; overflow: hidden; margin-bottom: 0.75em; border: 1px solid var(--border-weak-base);"

      const codeArea = document.createElement("textarea")
      codeArea.value = node.attrs.content
      codeArea.spellcheck = false
      codeArea.style.cssText = [
        "width: 100%",
        "min-height: 80px",
        "padding: 0.75em",
        "font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
        "font-size: 0.8125rem",
        "background: var(--surface-inset-base)",
        "color: var(--text-base)",
        "border: none",
        "outline: none",
        "resize: vertical",
        "display: block",
      ].join("; ")

      const preview = document.createElement("div")
      preview.style.cssText =
        "padding: 1em; background: var(--surface-raised-base); display: flex; justify-content: center; overflow-x: auto;"

      dom.appendChild(codeArea)
      dom.appendChild(preview)

      let renderTimeout: ReturnType<typeof setTimeout>
      let renderVersion = 0
      let currentNode = node

      async function renderDiagram(code: string) {
        const version = ++renderVersion
        try {
          const { svg } = await renderMermaid(code)
          if (version !== renderVersion) return
          preview.innerHTML = svg
        } catch {
          if (version !== renderVersion) return
          preview.innerHTML = `<span style="color: var(--text-diff-delete-base); font-size: 0.8125rem;">Invalid diagram</span>`
        }
      }

      const unsubscribeTheme = subscribeMermaidThemeChanges(document, () => renderDiagram(codeArea.value))

      codeArea.addEventListener("input", () => {
        clearTimeout(renderTimeout)
        renderTimeout = setTimeout(() => {
          const pos = typeof getPos === "function" ? getPos() : 0
          if (pos === undefined) return
          editor.view.dispatch(
            editor.view.state.tr.setNodeMarkup(pos, undefined, { ...currentNode.attrs, content: codeArea.value }),
          )
          renderDiagram(codeArea.value)
        }, 500)
      })

      renderDiagram(node.attrs.content)

      return {
        dom,
        stopEvent: (event: Event) => event.target === codeArea,
        update: (updatedNode) => {
          if (updatedNode.type.name !== "mermaid") return false
          currentNode = updatedNode
          if (codeArea.value !== updatedNode.attrs.content) {
            codeArea.value = updatedNode.attrs.content
            renderDiagram(updatedNode.attrs.content)
          }
          return true
        },
        destroy: () => {
          clearTimeout(renderTimeout)
          unsubscribeTheme()
        },
      }
    }
  },

  addCommands() {
    return {
      setMermaid:
        (attrs?: { content?: string }) =>
        ({ commands }: CommandProps) =>
          commands.insertContent({ type: this.name, attrs }),
    }
  },
})

export function createFileUpload(
  client: {
    asset: { upload: (params?: { file?: unknown }) => Promise<{ data?: { id?: string; url?: string; mime?: string } }> }
  },
  baseUrl: string,
) {
  async function uploadFile(file: File): Promise<{ url: string; mime: string }> {
    const res = await client.asset.upload({ file })
    const data = res.data as { id?: string; url?: string; mime?: string } | undefined
    return { url: assetHttpUrl(baseUrl, data), mime: data?.mime ?? file.type }
  }

  function insertMedia(editor: Editor, url: string, mime: string, pos?: number) {
    if (mime.startsWith("video/")) {
      const content = { type: "video" as const, attrs: { src: url, controls: true } }
      if (pos !== undefined) {
        editor.chain().focus().insertContentAt(pos, content).run()
      } else {
        editor.chain().focus().insertContent(content).run()
      }
    } else {
      if (pos !== undefined) {
        editor
          .chain()
          .focus()
          .insertContentAt(pos, { type: "image", attrs: { src: url } })
          .run()
      } else {
        editor.chain().focus().setImage({ src: url }).run()
      }
    }
  }

  return FileHandler.configure({
    allowedMimeTypes: [
      "image/png",
      "image/jpeg",
      "image/gif",
      "image/webp",
      "image/svg+xml",
      "video/mp4",
      "video/webm",
    ],

    onPaste: async (editor, files) => {
      for (const file of files) {
        try {
          const { url, mime } = await uploadFile(file)
          insertMedia(editor, url, mime)
        } catch (e) {
          console.error("Failed to upload pasted file:", e)
        }
      }
    },

    onDrop: async (editor, files, pos) => {
      for (const file of files) {
        try {
          const { url, mime } = await uploadFile(file)
          insertMedia(editor, url, mime, pos)
        } catch (e) {
          console.error("Failed to upload dropped file:", e)
        }
      }
    },
  })
}
