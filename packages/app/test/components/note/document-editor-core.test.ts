import { afterEach, describe, expect, test } from "bun:test"
import { setupI18n } from "@lingui/core"
import type { I18nContext } from "@lingui/solid"
import { Editor } from "@tiptap/core"
import { Fragment as TiptapFragment } from "@tiptap/pm/model"
import { Fragment as ProseMirrorFragment } from "prosemirror-model"
import type { SynergyClient } from "@ericsanchezok/synergy-sdk/client"
import { createDocumentEditorExtensions } from "../../../src/components/note/document-editor-core"

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
})
