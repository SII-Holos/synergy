// Mirrors @tiptap/extension-blockquote@3.27.2 because its published ESM bundle inlines
// prosemirror-model and creates a second Fragment identity. Keep this file and the Vite alias
// together; remove both only after the upstream production bundle contains one model implementation.
import { type Editor, mergeAttributes, Node, wrappingInputRule } from "@tiptap/core"
import type { NodeType } from "@tiptap/pm/model"
import { TextSelection } from "@tiptap/pm/state"

export interface BlockquoteOptions {
  HTMLAttributes: Record<string, unknown>
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    blockQuote: {
      setBlockquote: () => ReturnType
      toggleBlockquote: () => ReturnType
      unsetBlockquote: () => ReturnType
    }
  }
}

export const blockquoteInputRegex = /^\s*>\s$/

function handleBackspace(editor: Editor, type: NodeType) {
  const { state, view } = editor
  const { selection } = state
  if (!selection.empty) return false

  const { $from } = selection
  if ($from.parentOffset !== 0) return false

  const parentDepth = $from.depth - 1
  const parent = $from.node(parentDepth)
  const index = $from.index(parentDepth)
  if (index === 0) return false
  if (parent.type === type) return editor.commands.lift(type.name)

  const previous = parent.child(index - 1)
  if (previous.type !== type || !previous.lastChild?.isTextblock) return false

  const blockStart = $from.before()
  const targetPos = blockStart - 2
  const { tr } = state
  tr.delete(blockStart, $from.after()).insert(targetPos, $from.parent.content)
  tr.setSelection(TextSelection.create(tr.doc, targetPos))
  view.dispatch(tr.scrollIntoView())
  return true
}

export const Blockquote = Node.create<BlockquoteOptions>({
  name: "blockquote",

  addOptions() {
    return {
      HTMLAttributes: {},
    }
  },

  content: "block+",
  group: "block",
  defining: true,

  parseHTML() {
    return [{ tag: "blockquote" }]
  },

  renderHTML({ HTMLAttributes }) {
    return ["blockquote", mergeAttributes(this.options.HTMLAttributes, HTMLAttributes), 0]
  },

  parseMarkdown(token, helpers) {
    const parseBlockChildren = helpers.parseBlockChildren ?? helpers.parseChildren
    return helpers.createNode("blockquote", undefined, parseBlockChildren(token.tokens ?? []))
  },

  renderMarkdown(node, helpers) {
    if (!node.content) return ""

    const prefix = ">"
    const result: string[] = []
    node.content.forEach((child, index) => {
      const childContent = helpers.renderChild?.(child, index) ?? helpers.renderChildren([child])
      const lines = childContent.split("\n")
      result.push(lines.map((line) => (line.trim() === "" ? prefix : `${prefix} ${line}`)).join("\n"))
    })
    return result.join(`\n${prefix}\n`)
  },

  addCommands() {
    return {
      setBlockquote:
        () =>
        ({ commands }) =>
          commands.wrapIn(this.name),
      toggleBlockquote:
        () =>
        ({ commands }) =>
          commands.toggleWrap(this.name),
      unsetBlockquote:
        () =>
        ({ commands }) =>
          commands.lift(this.name),
    }
  },

  addKeyboardShortcuts() {
    return {
      "Mod-Shift-b": () => this.editor.commands.toggleBlockquote(),
      Backspace: () => handleBackspace(this.editor, this.type),
    }
  },

  addInputRules() {
    return [
      wrappingInputRule({
        find: blockquoteInputRegex,
        type: this.type,
      }),
    ]
  },
})

export default Blockquote
