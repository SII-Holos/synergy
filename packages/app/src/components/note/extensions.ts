import { type CommandProps, type Editor, Node, mergeAttributes } from "@tiptap/core"
import { FileHandler } from "@tiptap/extension-file-handler"
import mermaid from "mermaid"

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

mermaid.initialize({ startOnLoad: false, theme: "neutral" })

let mermaidCounter = 0

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
        "background: #0d1117",
        "color: #e6edf3",
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

      async function renderDiagram(code: string) {
        try {
          const id = `mermaid-${++mermaidCounter}`
          const { svg } = await mermaid.render(id, code)
          preview.innerHTML = svg
        } catch {
          preview.innerHTML = `<span style="color: var(--text-diff-delete-base); font-size: 0.8125rem;">Invalid diagram</span>`
        }
      }

      codeArea.addEventListener("input", () => {
        clearTimeout(renderTimeout)
        renderTimeout = setTimeout(() => {
          const pos = typeof getPos === "function" ? getPos() : 0
          if (pos === undefined) return
          editor.view.dispatch(
            editor.view.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, content: codeArea.value }),
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
          if (codeArea.value !== updatedNode.attrs.content) {
            codeArea.value = updatedNode.attrs.content
            renderDiagram(updatedNode.attrs.content)
          }
          return true
        },
        destroy: () => clearTimeout(renderTimeout),
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

export function createFileUpload(serverUrl: string) {
  async function uploadFile(file: File): Promise<{ url: string; mime: string }> {
    const form = new FormData()
    form.append("file", file)
    const res = await fetch(`${serverUrl}/asset`, { method: "POST", body: form })
    if (!res.ok) throw new Error(`Upload failed (${res.status}): ${res.statusText}`)
    const data = (await res.json()) as { id: string }
    return { url: `${serverUrl}/asset/${data.id}`, mime: file.type }
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
