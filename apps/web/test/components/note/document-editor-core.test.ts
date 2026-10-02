import { afterEach, describe, expect, test } from "bun:test"
import { setupI18n } from "@lingui/core"
import type { I18nContext } from "@lingui/solid"
import { Editor } from "@tiptap/core"
import { Fragment as TiptapFragment } from "@tiptap/pm/model"
import { Fragment as ProseMirrorFragment } from "prosemirror-model"
import type { SynergyClient } from "@ericsanchezok/synergy-sdk/client"
import {
  createDocumentEditorExtensions,
  mountDocumentEditor,
  unmountDocumentEditor,
  type DocumentEditorRetention,
} from "../../../src/components/note/document-editor-core"

let editor: Editor | undefined

const i18n = setupI18n({ locale: "en" })
i18n.loadAndActivate({ locale: "en", messages: {} })
const lingui = {
  i18n: () => i18n,
  _: i18n._.bind(i18n),
} as I18nContext

function createExtensions() {
  const bubbleRef = document.createElement("div")
  document.body.append(bubbleRef)
  return createDocumentEditorExtensions({
    sdkClient: {
      asset: { upload: async () => ({ data: undefined }) },
    } as unknown as SynergyClient,
    sdkUrl: "http://127.0.0.1",
    onUploadFile: async () => "",
    bubbleRef,
    lingui,
  })
}

afterEach(() => {
  editor?.destroy()
  editor = undefined
  document.body.replaceChildren()
})

describe("Note document editor", () => {
  test("retained documents preserve selection and undo when remounted into another tab view", () => {
    const retained: DocumentEditorRetention = { scroll: 0 }
    const first = document.createElement("div")
    const second = document.createElement("div")
    document.body.append(first, second)
    const config = {
      sdkClient: { asset: { upload: async () => ({ data: undefined }) } } as unknown as SynergyClient,
      sdkUrl: "http://localhost",
      onUploadFile: async () => "",
      bubbleRef: document.createElement("div"),
      lingui,
    }
    editor = mountDocumentEditor({ element: first, config, content: "<p>Base</p>", retained, onUpdate: () => {} })
    expect(retained.hasHistory?.()).toBe(false)
    editor.commands.setTextSelection(5)
    editor.commands.insertContent(" edited")
    const selection = editor.state.selection.from
    const previousView = editor.view
    const lateTransaction = previousView.state.tr.setMeta("decoration", true)
    unmountDocumentEditor(editor)
    expect(retained.hasHistory?.()).toBe(true)
    const restoredBubble = document.createElement("div")
    editor = mountDocumentEditor({
      element: second,
      config: { ...config, bubbleRef: restoredBubble },
      content: "<p>Ignored</p>",
      retained,
      onUpdate: () => {},
    })
    expect(restoredBubble.style.visibility).toBe("hidden")
    expect(restoredBubble.style.position).toBe("absolute")
    expect(editor.getText()).toBe("Base edited")
    expect(editor.state.selection.from).toBe(selection)
    expect(editor.commands.undo()).toBe(true)
    expect(retained.hasHistory?.()).toBe(true)
    expect(editor.getText()).toBe("Base")
    expect(() => previousView.dispatch(lateTransaction)).not.toThrow()
    expect(editor.getText()).toBe("Base")
  })

  test("uses one ProseMirror model identity across direct and Tiptap imports", () => {
    expect(TiptapFragment).toBe(ProseMirrorFragment)
  })

  test("splits ordinary paragraph text when Enter is pressed", () => {
    const element = document.createElement("div")
    document.body.append(element)
    editor = new Editor({
      element,
      extensions: createExtensions(),
      content: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "hello" }],
          },
        ],
      },
    })
    editor.commands.setTextSelection(6)

    expect(() => editor?.commands.keyboardShortcut("Enter")).not.toThrow()
    expect(editor.state.doc.childCount).toBe(2)
    expect(editor.state.doc.child(0).textContent).toBe("hello")
    expect(editor.state.doc.child(1).textContent).toBe("")
  })

  test("keeps blockquote commands available", () => {
    const element = document.createElement("div")
    document.body.append(element)
    editor = new Editor({
      element,
      extensions: createExtensions(),
      content: "<p>quoted</p>",
    })

    expect(editor.commands.setBlockquote()).toBe(true)
    expect(editor.state.doc.firstChild?.type.name).toBe("blockquote")
    expect(editor.state.doc.firstChild?.textContent).toBe("quoted")
  })

  test("loads markdown-like note JSON that includes blockId attrs", () => {
    const element = document.createElement("div")
    document.body.append(element)
    editor = new Editor({
      element,
      extensions: createExtensions(),
      content: {
        type: "doc",
        content: [
          {
            type: "heading",
            attrs: { level: 1, blockId: "blk_heading_1" },
            content: [{ type: "text", text: "Goal and Requirements" }],
          },
          {
            type: "paragraph",
            attrs: { blockId: "blk_para_1" },
            content: [{ type: "text", text: "为 chatgame 设计并落地剧本格式。" }],
          },
          {
            type: "bulletList",
            attrs: { blockId: "blk_list_1" },
            content: [
              {
                type: "listItem",
                attrs: { blockId: "blk_item_1" },
                content: [
                  {
                    type: "paragraph",
                    attrs: { blockId: "blk_item_para_1" },
                    content: [{ type: "text", text: "pure config" }],
                  },
                ],
              },
            ],
          },
          {
            type: "codeBlock",
            attrs: { language: "yaml", blockId: "blk_code_1" },
            content: [{ type: "text", text: "id: emberfall" }],
          },
          {
            type: "table",
            attrs: { blockId: "blk_table_1" },
            content: [
              {
                type: "tableRow",
                attrs: { blockId: "blk_row_1" },
                content: [
                  {
                    type: "tableHeader",
                    attrs: { blockId: "blk_th_1" },
                    content: [
                      {
                        type: "paragraph",
                        attrs: { blockId: "blk_th_para_1" },
                        content: [{ type: "text", text: "A" }],
                      },
                    ],
                  },
                  {
                    type: "tableHeader",
                    attrs: { blockId: "blk_th_2" },
                    content: [
                      {
                        type: "paragraph",
                        attrs: { blockId: "blk_th_para_2" },
                        content: [{ type: "text", text: "B" }],
                      },
                    ],
                  },
                ],
              },
              {
                type: "tableRow",
                attrs: { blockId: "blk_row_2" },
                content: [
                  {
                    type: "tableCell",
                    attrs: { blockId: "blk_td_1" },
                    content: [
                      {
                        type: "paragraph",
                        attrs: { blockId: "blk_td_para_1" },
                        content: [{ type: "text", text: "1" }],
                      },
                    ],
                  },
                  {
                    type: "tableCell",
                    attrs: { blockId: "blk_td_2" },
                    content: [
                      {
                        type: "paragraph",
                        attrs: { blockId: "blk_td_para_2" },
                        content: [{ type: "text", text: "2" }],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    })

    expect(editor.state.doc.childCount).toBeGreaterThan(1)
    expect(editor.getText()).toContain("Goal and Requirements")
    expect(editor.getText()).toContain("pure config")
    expect(editor.getText()).toContain("emberfall")
  })
})
