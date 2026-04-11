import BubbleMenuExtension from "@tiptap/extension-bubble-menu"
import type { Editor } from "@tiptap/core"

export function createBubbleMenu(element: HTMLElement) {
  return BubbleMenuExtension.configure({
    element,
    pluginKey: "noteBubbleMenu",
    updateDelay: 100,
    shouldShow: ({ state, editor }) => {
      const { empty } = state.selection
      if (empty) return false
      if (editor.isActive("image")) return false
      if (editor.isActive("codeBlock")) return false
      if (editor.isActive("mermaid")) return false
      return true
    },
    options: {
      placement: "top" as const,
      offset: 8,
      flip: true,
    },
  })
}

function BubbleButton(props: {
  active: boolean
  onMouseDown: (e: MouseEvent) => void
  label: string
  title: string
  bold?: boolean
  italic?: boolean
  strike?: boolean
  mono?: boolean
}) {
  return (
    <button
      type="button"
      classList={{
        "size-7 flex items-center justify-center rounded text-12-medium transition-colors": true,
        "text-text-interactive-base bg-surface-interactive-base/15": props.active,
        "text-text-weak hover:text-text-strong hover:bg-surface-raised-base-hover": !props.active,
        "font-bold": props.bold,
        italic: props.italic,
        "line-through": props.strike,
        "font-mono": props.mono,
      }}
      onMouseDown={props.onMouseDown}
      title={props.title}
    >
      {props.label}
    </button>
  )
}

export function BubbleMenuContent(props: { editor: Editor }) {
  const isActive = (name: string, attrs?: Record<string, any>) => props.editor.isActive(name, attrs)

  function toggle(name: string) {
    return (e: MouseEvent) => {
      e.preventDefault()
      switch (name) {
        case "bold":
          props.editor.chain().focus().toggleBold().run()
          break
        case "italic":
          props.editor.chain().focus().toggleItalic().run()
          break
        case "strike":
          props.editor.chain().focus().toggleStrike().run()
          break
        case "code":
          props.editor.chain().focus().toggleCode().run()
          break
        case "link": {
          if (isActive("link")) {
            props.editor.chain().focus().unsetLink().run()
          } else {
            const url = window.prompt("Enter URL")
            if (url) props.editor.chain().focus().setLink({ href: url }).run()
          }
          break
        }
      }
    }
  }

  return (
    <div class="flex items-center gap-0.5 rounded-lg border border-border-base/50 bg-surface-raised-stronger-non-alpha shadow-lg px-1 py-0.5">
      <BubbleButton active={isActive("bold")} onMouseDown={toggle("bold")} label="B" title="Bold" bold />
      <BubbleButton active={isActive("italic")} onMouseDown={toggle("italic")} label="I" title="Italic" italic />
      <BubbleButton active={isActive("strike")} onMouseDown={toggle("strike")} label="S" title="Strikethrough" strike />
      <BubbleButton active={isActive("code")} onMouseDown={toggle("code")} label="<>" title="Code" mono />
      <div class="w-px h-4 bg-border-base/30 mx-0.5" />
      <BubbleButton active={isActive("link")} onMouseDown={toggle("link")} label="🔗" title="Link" />
    </div>
  )
}
