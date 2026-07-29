import { afterEach, describe, expect, test } from "bun:test"
import { Editor } from "@tiptap/core"
import StarterKit from "@tiptap/starter-kit"

let editor: Editor | undefined

afterEach(() => {
  editor?.destroy()
  editor = undefined
  document.body.replaceChildren()
})

describe("Note document editor", () => {
  test("splits ordinary paragraph text when Enter is pressed", () => {
    const element = document.createElement("div")
    document.body.append(element)
    editor = new Editor({
      element,
      extensions: [StarterKit],
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
})
