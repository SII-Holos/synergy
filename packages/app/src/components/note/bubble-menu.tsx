import BubbleMenuExtension from "@tiptap/extension-bubble-menu"
import type { Editor } from "@tiptap/core"
import { createEffect, createSignal, For, onCleanup, onMount, Show } from "solid-js"

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

type SelectedMath = {
  pos: number
  nodeSize: number
  latex: string
  display: boolean
}

function selectedMath(editor: Editor): SelectedMath | null {
  const selection = editor.state.selection as any
  const node = selection.node
  if (node?.type?.name !== "inlineMath") return null
  return {
    pos: selection.from,
    nodeSize: node.nodeSize,
    latex: node.attrs?.latex ?? "",
    display: node.attrs?.display === "yes",
  }
}

function mathAt(editor: Editor, fallback: SelectedMath): SelectedMath | null {
  const current = selectedMath(editor)
  const target = current ?? fallback
  const node = editor.state.doc.nodeAt(target.pos)
  if (!node || node.type.name !== "inlineMath") return null
  return {
    pos: target.pos,
    nodeSize: node.nodeSize,
    latex: node.attrs?.latex ?? "",
    display: node.attrs?.display === "yes",
  }
}

function updateMath(editor: Editor, math: SelectedMath, attrs: { latex?: string; display?: boolean }) {
  const target = mathAt(editor, math)
  if (!target) return null
  const node = editor.state.doc.nodeAt(target.pos)
  if (!node || node.type.name !== "inlineMath") return null
  editor.view.dispatch(
    editor.state.tr.setNodeMarkup(target.pos, undefined, {
      ...node.attrs,
      latex: attrs.latex ?? node.attrs.latex,
      display: attrs.display === undefined ? node.attrs.display : attrs.display ? "yes" : "no",
      evaluate: node.attrs.evaluate ?? "no",
    }),
  )
  return target
}

function finishFormulaEdit(editor: Editor, math: SelectedMath) {
  const target = mathAt(editor, math)
  if (!target) return
  const nextPos = Math.min(target.pos + target.nodeSize, editor.state.doc.content.size)
  editor.chain().focus().setTextSelection(nextPos).run()
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

function FormulaMenu(props: { editor: Editor; selected: SelectedMath; onSync: () => void }) {
  const [draft, setDraft] = createSignal(props.selected.latex)
  const [display, setDisplay] = createSignal(props.selected.display)

  createEffect(() => {
    setDraft(props.selected.latex)
    setDisplay(props.selected.display)
  })

  function updateLatex(value: string) {
    setDraft(value)
    if (!updateMath(props.editor, props.selected, { latex: value })) return
    props.onSync()
  }

  function toggleDisplay(e: MouseEvent) {
    e.preventDefault()
    const next = !display()
    setDisplay(next)
    if (!updateMath(props.editor, props.selected, { display: next })) return
    props.onSync()
  }

  function deleteFormula(e: MouseEvent) {
    e.preventDefault()
    const target = mathAt(props.editor, props.selected)
    if (!target) return
    props.editor
      .chain()
      .focus()
      .deleteRange({ from: target.pos, to: target.pos + target.nodeSize })
      .run()
    props.onSync()
  }

  function finishInput(e?: KeyboardEvent | MouseEvent) {
    e?.preventDefault()
    finishFormulaEdit(props.editor, props.selected)
    props.onSync()
  }

  return (
    <div class="w-[min(28rem,calc(100vw-2rem))] rounded-xl border border-border-base/55 bg-surface-raised-stronger-non-alpha p-3 shadow-[0_18px_60px_-30px_rgba(28,34,48,0.45)]">
      <div class="mb-2 flex items-center gap-2">
        <span class="text-11-medium text-text-weak">LaTeX</span>
        <span class="flex-1" />
        <button
          type="button"
          class="rounded-md px-2 py-1 text-11-medium text-text-weak transition-colors hover:bg-surface-raised-base-hover hover:text-text-strong"
          classList={{ "bg-surface-interactive-base/12 text-text-interactive-base": display() }}
          onMouseDown={toggleDisplay}
          title="Toggle block formula"
        >
          {display() ? "Block" : "Inline"}
        </button>
        <button
          type="button"
          class="rounded-md px-2 py-1 text-11-medium text-text-weak transition-colors hover:bg-surface-raised-base-hover hover:text-text-strong"
          onMouseDown={deleteFormula}
          title="Delete formula"
        >
          Delete
        </button>
        <button
          type="button"
          class="rounded-md bg-surface-interactive-base/12 px-2 py-1 text-11-medium text-text-interactive-base transition-colors hover:bg-surface-interactive-base/18"
          onMouseDown={finishInput}
          title="Finish editing formula"
        >
          Done
        </button>
      </div>
      <textarea
        class="min-h-20 w-full resize-y rounded-lg border border-border-base/55 bg-surface-inset-base/52 px-3 py-2 font-mono text-12-regular leading-relaxed text-text-base outline-none transition-colors focus:border-text-interactive-base/45 focus:bg-surface-inset-base/72"
        value={draft()}
        spellcheck={false}
        onInput={(e) => updateLatex(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") finishInput(e)
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) finishInput(e)
        }}
        onMouseDown={(e) => e.stopPropagation()}
      />
      <div class="mt-2 flex items-center gap-2 text-11-regular text-text-weaker">
        <span>Esc moves the cursor after the formula</span>
        <span class="flex-1" />
        <span>⌘/Ctrl + Enter also works</span>
      </div>
    </div>
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
  const [math, setMath] = createSignal<SelectedMath | null>(selectedMath(props.editor))

  function syncMathSelection() {
    setMath(selectedMath(props.editor))
  }

  const inTable = () => {
    const { $from } = props.editor.state.selection
    for (let d = $from.depth; d > 0; d--) {
      if ($from.node(d).type.name === "table") return true
    }
    return false
  }

  onMount(() => {
    props.editor.on("selectionUpdate", syncMathSelection)
    props.editor.on("transaction", syncMathSelection)
  })

  onCleanup(() => {
    props.editor.off("selectionUpdate", syncMathSelection)
    props.editor.off("transaction", syncMathSelection)
  })

  return (
    <Show
      when={math()}
      fallback={
        <div class="flex items-center gap-0.5 rounded-lg border border-border-base/50 bg-surface-raised-stronger-non-alpha px-1 py-0.5 shadow-lg">
          <TextFormatMenu editor={props.editor} />
          <Show when={inTable()}>
            <div class="mx-0.5 h-4 w-px bg-border-base/30" />
            <TableMenu editor={props.editor} />
          </Show>
        </div>
      }
    >
      {(selected) => <FormulaMenu editor={props.editor} selected={selected()} onSync={syncMathSelection} />}
    </Show>
  )
}
