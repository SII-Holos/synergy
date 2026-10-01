import { I18nProvider } from "@lingui/solid"
import { createSignal, onCleanup } from "solid-js"
import { render } from "solid-js/web"
import "../../../src/index.css"
import { setupI18n } from "@lingui/core"
import { ComposerResizeControls } from "../../../src/components/prompt-input/composer-resize-controls"
import { ComposerExpandButton } from "../../../src/components/prompt-input/composer-expand-button"
import {
  ComposerPresentation,
  bindComposerPresentation,
} from "../../../src/components/prompt-input/composer-presentation"

function Fixture() {
  const state = new ComposerPresentation()
  const [version, setVersion] = createSignal(0)
  onCleanup(state.subscribe(() => setVersion((value) => value + 1)))
  const input = { current: () => ({ revision: 0, text: "", selection: { start: 0, end: 0 }, mode: "normal" as const }) }
  onCleanup(bindComposerPresentation(input, { state, preview: () => ({ text: "", references: [] }) }))
  const height = () => {
    version()
    return state.manualHeight ?? 96
  }
  return (
    <I18nProvider
      i18n={setupI18n({
        locale: "en",
        messages: {
          en: {
            "prompt.long.resize": "Resize editor",
            "prompt.long.size": "Editor size",
            "prompt.long.autoSize": "Automatic height",
            "prompt.long.tallSize": "Taller editor",
            "prompt.long.expand": "Expand editor",
            "prompt.long.collapse": "Collapse editor",
            "prompt.long.releaseExpand": "Release to expand",
            "prompt.long.continueExpand": "Continue dragging to expand",
          },
        },
      })}
    >
      <style>{`body {margin:0} .frame {position:relative;width:min(320px,100%);height:500px} form {position:absolute;bottom:0;width:100%;margin:0} .footer{height:36px}`}</style>
      <div class="frame session-composer" data-expanded={(version(), state.expanded) ? "" : undefined}>
        <form class="prompt-input-shell">
          <ComposerResizeControls input={input} availableHeight={500} />
          <ComposerExpandButton input={input} />
          <div class="session-composer-editor" style={{ height: `${height()}px`, "max-height": "none" }} />
          <div class="footer" />
        </form>
      </div>
      <output id="expanded">{(version(), String(state.expanded))}</output>
    </I18nProvider>
  )
}
render(() => <Fixture />, document.getElementById("root")!)
