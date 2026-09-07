import { createEffect, createSignal, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { render } from "solid-js/web"
import { Router, Route, useNavigate, useParams } from "@solidjs/router"
import { PromptProvider, usePrompt } from "../../../src/context/prompt"
import { usePromptEditor } from "../../../src/components/prompt-input/editor-hook"
import { ComposerDocumentController } from "../../../src/components/prompt-input/composer-document"
import type { PromptInputStore } from "../../../src/components/prompt-input/types"

function Editor() {
  const prompt = usePrompt()
  const navigate = useNavigate()
  const params = useParams()
  const [node, setNode] = createSignal<HTMLDivElement>()
  const [mounted, setMounted] = createSignal(false)
  const [revision, setRevision] = createSignal(0)
  const [store, setStore] = createStore<PromptInputStore>({
    mode: "normal",
    popover: null,
    dragging: false,
    historyIndex: -1,
    savedPrompt: null,
    placeholder: 0,
    applyingHistory: false,
    switchingProfile: false,
  })
  const editor = usePromptEditor({
    editor: node,
    uploadedAttachments: () => [],
    noteAttachments: () => [],
    sessionAttachments: () => [],
    store,
    setStore,
    atOnInput() {},
    slashOnInput() {},
    queueScroll() {},
    onDocumentChange: () => controller.changed(),
  })
  const controller = new ComposerDocumentController({
    read: () => ({
      text: editor.documentText(),
      selection: editor.documentSelection(),
      mode: store.mode,
      sessionId: params.id,
    }),
    applyEdits: editor.applyDocumentEdits,
    isEditableRange: editor.isEditableRange,
  })
  onCleanup(controller.subscribe(() => setRevision((value) => value + 1)))
  onCleanup(() => controller.dispose())
  createEffect(() => {
    params.id
    controller.changed()
  })
  let captured: ReturnType<typeof prompt.capture> | undefined
  let submittedRevision = 0
  onCleanup(() => captured?.release())
  return (
    <>
      <output id="session">{params.id}</output>
      <output id="value">
        {prompt
          .current()
          .map((part) => ("content" in part ? part.content : ""))
          .join("")}
      </output>
      <output id="selection">
        {revision() && ""}
        {JSON.stringify(editor.documentSelection())}
      </output>
      <button id="seed" onClick={() => prompt.set([{ type: "text", content: "hello", start: 0, end: 5 }], 5)}>
        Seed
      </button>
      <button
        id="capture"
        onClick={() => {
          captured?.release()
          captured = prompt.capture()
        }}
      >
        Capture
      </button>
      <button
        id="submit"
        onClick={() => {
          captured?.release()
          captured = prompt.capture()
          captured.draft.resetDraft()
          submittedRevision = captured.draft.revision()
        }}
      >
        Submit
      </button>
      <button
        id="fail-submit"
        onClick={() =>
          captured?.draft.restoreIfUnchanged(submittedRevision, {
            prompt: [{ type: "text", content: "submitted", start: 0, end: 9 }],
            context: { items: [] },
          })
        }
      >
        Fail submit
      </button>
      <button
        id="restore"
        onClick={() => captured?.draft.set([{ type: "text", content: "restored A", start: 0, end: 10 }], 10)}
      >
        Restore
      </button>
      <button id="a" onClick={() => navigate("/scope/session/a")}>
        A
      </button>
      <button id="b" onClick={() => navigate("/scope/session/b")}>
        B
      </button>
      <button id="mount" onClick={() => setMounted(!mounted())}>
        Mount
      </button>
      <button
        id="select"
        onClick={() => {
          editor.setSelection({ start: 1, end: 4 })
          controller.selectionChanged()
          setRevision((v) => v + 1)
        }}
      >
        Select
      </button>
      <button
        id="edit"
        onClick={async () => {
          await controller.applyEdits({
            revision: controller.current().revision,
            edits: [{ range: { start: 1, end: 4 }, text: "你好" }],
          })
          setRevision((v) => v + 1)
        }}
      >
        Edit
      </button>
      <Show when={mounted()}>
        <div
          id="editor"
          contentEditable
          ref={(el) => {
            setNode(el)
            onCleanup(() => setNode(undefined))
          }}
          onInput={editor.handleInput}
        />
      </Show>
    </>
  )
}

render(
  () => (
    <Router>
      <Route
        path="/:dir/session/:id"
        component={() => (
          <PromptProvider>
            <Editor />
          </PromptProvider>
        )}
      />
    </Router>
  ),
  document.getElementById("root")!,
)
