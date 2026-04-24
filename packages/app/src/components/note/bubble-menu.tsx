import BubbleMenuExtension from "@tiptap/extension-bubble-menu"
import type { Editor } from "@tiptap/core"
import { Show, For } from "solid-js"
import { Icon } from "@ericsanchezok/synergy-ui/icon"

export function createBubbleMenu(element: HTMLElement) {
  return BubbleMenuExtension.configure({
    element,
    pluginKey: "noteBubbleMenu",
    updateDelay: 100,
    shouldShow: ({ state, editor }) => {
      const { empty } = state.selection
      if (empty) return false
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

function BubbleButton(props: { active?: boolean; onMouseDown: (e: MouseEvent) => void; title: string; children: any }) {
  return (
    <button
      type="button"
      classList={{
        "size-7 flex items-center justify-center rounded text-12-medium transition-colors": true,
        "text-text-interactive-base bg-surface-interactive-base/15": props.active,
        "text-text-weak hover:text-text-strong hover:bg-surface-raised-base-hover": !props.active,
      }}
      onMouseDown={props.onMouseDown}
      title={props.title}
    >
      {props.children}
    </button>
  )
}

function TextFormatMenu(props: { editor: Editor }) {
  const isActive = (name: string) => props.editor.isActive(name)

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
    <>
      <BubbleButton active={isActive("bold")} onMouseDown={toggle("bold")} title="Bold">
        <span class="font-bold">B</span>
      </BubbleButton>
      <BubbleButton active={isActive("italic")} onMouseDown={toggle("italic")} title="Italic">
        <span class="italic">I</span>
      </BubbleButton>
      <BubbleButton active={isActive("strike")} onMouseDown={toggle("strike")} title="Strikethrough">
        <span class="line-through">S</span>
      </BubbleButton>
      <BubbleButton active={isActive("code")} onMouseDown={toggle("code")} title="Code">
        <span class="font-mono text-11">&lt;&gt;</span>
      </BubbleButton>
      <div class="w-px h-4 bg-border-base/30 mx-0.5" />
      <BubbleButton active={isActive("link")} onMouseDown={toggle("link")} title="Link">
        <span class="text-13">🔗</span>
      </BubbleButton>
    </>
  )
}

function TableMenu(props: { editor: Editor }) {
  type Action = {
    label: string
    symbol: string
    action: () => void
    canRun?: () => boolean
  }

  const actions: Action[] = [
    {
      label: "Add row before",
      symbol: "↑+",
      action: () => props.editor.chain().focus().addRowBefore().run(),
    },
    {
      label: "Add row after",
      symbol: "↓+",
      action: () => props.editor.chain().focus().addRowAfter().run(),
    },
    {
      label: "Add column before",
      symbol: "←+",
      action: () => props.editor.chain().focus().addColumnBefore().run(),
    },
    {
      label: "Add column after",
      symbol: "→+",
      action: () => props.editor.chain().focus().addColumnAfter().run(),
    },
    {
      label: "Delete row",
      symbol: "−⃗",
      action: () => props.editor.chain().focus().deleteRow().run(),
    },
    {
      label: "Delete column",
      symbol: "−⃖",
      action: () => props.editor.chain().focus().deleteColumn().run(),
    },
    {
      label: "Delete table",
      symbol: "✕",
      action: () => props.editor.chain().focus().deleteTable().run(),
      canRun: () => {
        try {
          return props.editor.can().deleteTable()
        } catch {
          return false
        }
      },
    },
    {
      label: "Merge cells",
      symbol: "⊞",
      action: () => props.editor.chain().focus().mergeCells().run(),
      canRun: () => {
        try {
          return props.editor.can().mergeCells()
        } catch {
          return false
        }
      },
    },
    {
      label: "Split cell",
      symbol: "⊟",
      action: () => props.editor.chain().focus().splitCell().run(),
      canRun: () => {
        try {
          return props.editor.can().splitCell()
        } catch {
          return false
        }
      },
    },
    {
      label: "Toggle header row",
      symbol: "H",
      action: () => props.editor.chain().focus().toggleHeaderRow().run(),
    },
  ]

  return (
    <For each={actions.filter((a) => !a.canRun || a.canRun())}>
      {(item) => (
        <BubbleButton
          onMouseDown={(e) => {
            e.preventDefault()
            item.action()
          }}
          title={item.label}
        >
          <span class="text-11-medium">{item.symbol}</span>
        </BubbleButton>
      )}
    </For>
  )
}

export function BubbleMenuContent(props: { editor: Editor }) {
  const inTable = () => {
    const { $from } = props.editor.state.selection
    for (let d = $from.depth; d > 0; d--) {
      if ($from.node(d).type.name === "table") return true
    }
    return false
  }

  return (
    <div class="flex items-center gap-0.5 rounded-lg border border-border-base/50 bg-surface-raised-stronger-non-alpha shadow-lg px-1 py-0.5">
      <TextFormatMenu editor={props.editor} />
      <Show when={inTable()}>
        <div class="w-px h-4 bg-border-base/30 mx-0.5" />
        <TableMenu editor={props.editor} />
      </Show>
    </div>
  )
}
