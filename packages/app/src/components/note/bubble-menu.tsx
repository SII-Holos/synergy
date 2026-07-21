import { useLingui } from "@lingui/solid"
import BubbleMenuExtension from "@tiptap/extension-bubble-menu"
import type { Editor } from "@tiptap/core"
import { createEffect, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { bubbleMenu as B } from "@/locales/messages"

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
        "text-text-strong bg-surface-raised-base-hover": props.active,
        "text-text-weak hover:text-text-strong hover:bg-surface-raised-base-hover": !props.active,
      }}
      onMouseDown={props.onMouseDown}
      title={props.title}
    >
      {props.children}
    </button>
  )
}

function TextFormatMenu(props: { editor: Editor; lingui: ReturnType<typeof useLingui> }) {
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
      <BubbleButton
        active={isActive("bold")}
        onMouseDown={toggle("bold")}
        title={props.lingui._({ id: B.bold.id, message: B.bold.message })}
      >
        <span class="font-bold">{props.lingui._({ id: B.boldSymbol.id, message: B.boldSymbol.message })}</span>
      </BubbleButton>
      <BubbleButton
        active={isActive("italic")}
        onMouseDown={toggle("italic")}
        title={props.lingui._({ id: B.italic.id, message: B.italic.message })}
      >
        <span class="italic">{props.lingui._({ id: B.italicSymbol.id, message: B.italicSymbol.message })}</span>
      </BubbleButton>
      <BubbleButton
        active={isActive("strike")}
        onMouseDown={toggle("strike")}
        title={props.lingui._({ id: B.strikethrough.id, message: B.strikethrough.message })}
      >
        <span class="line-through">
          {props.lingui._({ id: B.strikethroughSymbol.id, message: B.strikethroughSymbol.message })}
        </span>
      </BubbleButton>
      <BubbleButton
        active={isActive("code")}
        onMouseDown={toggle("code")}
        title={props.lingui._({ id: B.code.id, message: B.code.message })}
      >
        <span class="font-mono text-11">{props.lingui._({ id: B.codeSymbol.id, message: B.codeSymbol.message })}</span>
      </BubbleButton>
      <div class="w-px h-4 bg-border-base/30 mx-0.5" />
      <BubbleButton
        active={isActive("link")}
        onMouseDown={toggle("link")}
        title={props.lingui._({ id: B.link.id, message: B.link.message })}
      >
        <span class="text-13">🔗</span>
      </BubbleButton>
    </>
  )
}

function FormulaMenu(props: {
  editor: Editor
  selected: SelectedMath
  onSync: () => void
  lingui: ReturnType<typeof useLingui>
}) {
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
    <div class="w-[min(28rem,calc(100vw-2rem))] rounded-xl border border-border-base/55 bg-surface-raised-stronger-non-alpha p-3 shadow-lg">
      <div class="mb-2 flex items-center gap-2">
        <span class="text-11-medium text-text-weak">
          {props.lingui._({ id: B.latex.id, message: B.latex.message })}
        </span>
        <span class="flex-1" />
        <button
          type="button"
          class="rounded-md px-2 py-1 text-11-medium text-text-weak transition-colors hover:bg-surface-raised-base-hover hover:text-text-strong"
          classList={{ "bg-surface-raised-base-hover text-text-strong": display() }}
          onMouseDown={toggleDisplay}
          title={props.lingui._({ id: B.toggleBlockFormula.id, message: B.toggleBlockFormula.message })}
        >
          {display()
            ? props.lingui._({ id: B.block.id, message: B.block.message })
            : props.lingui._({ id: B.inline.id, message: B.inline.message })}
        </button>
        <button
          type="button"
          class="rounded-md px-2 py-1 text-11-medium text-text-weak transition-colors hover:bg-surface-raised-base-hover hover:text-text-strong"
          onMouseDown={deleteFormula}
          title={props.lingui._({ id: B.deleteFormula.id, message: B.deleteFormula.message })}
        >
          {props.lingui._({ id: B.delete.id, message: B.delete.message })}
        </button>
        <button
          type="button"
          class="rounded-md bg-surface-raised-base-hover px-2 py-1 text-11-medium text-text-strong transition-colors hover:bg-surface-raised-base-hover"
          onMouseDown={finishInput}
          title={props.lingui._({ id: B.finishEditing.id, message: B.finishEditing.message })}
        >
          {props.lingui._({ id: B.done.id, message: B.done.message })}
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
        <span>{props.lingui._({ id: B.escHint.id, message: B.escHint.message })}</span>
        <span class="flex-1" />
        <span>{props.lingui._({ id: B.ctrlEnterHint.id, message: B.ctrlEnterHint.message })}</span>
      </div>
    </div>
  )
}

function TableMenu(props: { editor: Editor; lingui: ReturnType<typeof useLingui> }) {
  type Action = {
    label: string
    symbol: string
    action: () => void
    canRun?: () => boolean
  }

  const actions: Action[] = [
    {
      label: props.lingui._({ id: B.addRowBefore.id, message: B.addRowBefore.message }),
      symbol: "↑+",
      action: () => props.editor.chain().focus().addRowBefore().run(),
    },
    {
      label: props.lingui._({ id: B.addRowAfter.id, message: B.addRowAfter.message }),
      symbol: "↓+",
      action: () => props.editor.chain().focus().addRowAfter().run(),
    },
    {
      label: props.lingui._({ id: B.addColumnBefore.id, message: B.addColumnBefore.message }),
      symbol: "←+",
      action: () => props.editor.chain().focus().addColumnBefore().run(),
    },
    {
      label: props.lingui._({ id: B.addColumnAfter.id, message: B.addColumnAfter.message }),
      symbol: "→+",
      action: () => props.editor.chain().focus().addColumnAfter().run(),
    },
    {
      label: props.lingui._({ id: B.deleteRow.id, message: B.deleteRow.message }),
      symbol: "−⃗",
      action: () => props.editor.chain().focus().deleteRow().run(),
    },
    {
      label: props.lingui._({ id: B.deleteColumn.id, message: B.deleteColumn.message }),
      symbol: "−⃖",
      action: () => props.editor.chain().focus().deleteColumn().run(),
    },
    {
      label: props.lingui._({ id: B.deleteTable.id, message: B.deleteTable.message }),
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
      label: props.lingui._({ id: B.mergeCells.id, message: B.mergeCells.message }),
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
      label: props.lingui._({ id: B.splitCell.id, message: B.splitCell.message }),
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
      label: props.lingui._({ id: B.toggleHeaderRow.id, message: B.toggleHeaderRow.message }),
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
  const lingui = useLingui()

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
      keyed
      fallback={
        <div class="flex items-center gap-0.5 rounded-lg border border-border-base/50 bg-surface-raised-stronger-non-alpha px-1 py-0.5 shadow-lg">
          <TextFormatMenu editor={props.editor} lingui={lingui} />
          <Show when={inTable()}>
            <div class="mx-0.5 h-4 w-px bg-border-base/30" />
            <TableMenu editor={props.editor} lingui={lingui} />
          </Show>
        </div>
      }
    >
      {(selected) => (
        <FormulaMenu editor={props.editor} selected={selected} onSync={syncMathSelection} lingui={lingui} />
      )}
    </Show>
  )
}
