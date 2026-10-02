import { I18nProvider } from "@lingui/solid"
import { setupI18n } from "@lingui/core"
import { MarkedProvider } from "@ericsanchezok/synergy-ui/context/marked"
import type { PluginInputService } from "@ericsanchezok/synergy-plugin"
import { Show, createSignal, onCleanup } from "solid-js"
import { render } from "solid-js/web"
import { DefaultComposer } from "../../../src/plugin/default-composer"
import {
  ComposerPresentation,
  bindComposerPresentation,
} from "../../../src/components/prompt-input/composer-presentation"
import "../../../src/index.css"

function Fixture() {
  const state = new ComposerPresentation()
  const [text, setText] = createSignal(
    Array.from({ length: 60 }, (_, index) => `第 ${index + 1} 行：长消息编辑草稿。`).join("\n"),
  )
  const [revision, setRevision] = createSignal(0)
  const [mounted, setMounted] = createSignal(0)
  const [visible, setVisible] = createSignal(true)
  let editor: HTMLDivElement | undefined
  const input: PluginInputService = {
    editor: {
      label: () => "Message",
      mount(element) {
        editor = element
        element.textContent = text()
        setMounted((value) => value + 1)
        return () => {
          editor = undefined
        }
      },
      beforeInput() {},
      input() {
        setText(editor?.textContent ?? "")
        setRevision((value) => value + 1)
      },
      async paste() {},
      keyDown(event) {
        if (event.key === "Escape") state.collapse()
      },
      completion: () => undefined,
      placeholder: () => undefined,
    },
    current: () => ({ revision: revision(), text: text(), selection: { start: 0, end: 0 }, mode: "normal" }),
    readOnly: () => false,
    composing: () => false,
    primaryAction: () => "submit",
    ready: () => true,
    canSubmit: () => true,
    submitting: () => false,
    stopping: () => false,
    dragging: () => false,
    className: () => undefined,
    async applyEdits() {
      return input.current()
    },
    select() {},
    setComposing() {},
    setMode() {},
    async submit() {},
    async stop() {},
    attachments: () => [],
    async addAttachments() {},
    removeAttachment() {},
    agents: () => [],
    agent: () => undefined,
    selectAgent() {},
    models: () => [],
    model: () => undefined,
    selectModel() {},
    variants: () => [],
    variant: () => undefined,
    selectVariant() {},
    render(part) {
      if (part === "context")
        return (
          <div class="motion-attachments" role="group" aria-label="Attachments">
            <button type="button">notes.md</button>
            <button type="button">data.xlsx</button>
          </div>
        )
      if (part === "toolbar")
        return (
          <div class="motion-toolbar">
            <button type="submit">Send</button>
          </div>
        )
    },
    dragOver() {},
    dragLeave() {},
    async drop() {},
  }
  onCleanup(bindComposerPresentation(input, { state, preview: () => ({ text: text(), references: [] }) }))
  return (
    <I18nProvider
      i18n={setupI18n({
        locale: "en",
        messages: {
          en: {
            "prompt.long.expand": "Expand editor",
            "prompt.long.collapse": "Collapse editor",
            "prompt.long.resize": "Resize editor",
            "prompt.long.edit": "Edit",
            "prompt.long.preview": "Preview",
            "prompt.long.view": "Editor view",
            "prompt.long.format": "Markdown formatting",
          },
        },
      })}
    >
      <MarkedProvider>
        <style>{`html,body,#root{height:100%;margin:0}.fixture-actions{height:40px;display:flex;gap:12px}.frame{position:relative;height:calc(100% - 40px);overflow:hidden}.topbar{height:48px}.messages{height:200px;overflow:auto}.message{height:1000px}.session-prompt-dock{position:absolute;inset-inline:0;bottom:0}.motion-attachments{height:64px;display:flex;gap:8px;align-items:center;padding-inline:12px}.motion-toolbar{height:48px;display:flex;justify-content:flex-end;align-items:center;padding-inline:12px}.motion-toolbar button{height:32px}.composer-long-preview{overflow-wrap:anywhere}`}</style>
        <div class="fixture-actions">
          <button type="button" onClick={() => setVisible(!visible())}>
            Toggle surface
          </button>
          <button type="button" onClick={() => state.setHeight(180)}>
            Resize body
          </button>
          <output id="mounts">{mounted()}</output>
        </div>
        <div class="frame session-workbench-pane">
          <div data-ui-part="conversation">
            <div class="topbar">Conversation</div>
            <div class="messages">
              <div class="message">Retained conversation</div>
            </div>
          </div>
          <div class="session-prompt-dock">
            <div class="session-prompt-dock-content session-content-column">
              <Show when={visible()}>
                <DefaultComposer context={{ input }} />
              </Show>
              <div class="session-prompt-dock-footer" />
            </div>
          </div>
        </div>
      </MarkedProvider>
    </I18nProvider>
  )
}
render(() => <Fixture />, document.getElementById("root")!)
