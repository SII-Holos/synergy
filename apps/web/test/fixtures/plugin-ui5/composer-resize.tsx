import { I18nProvider } from "@lingui/solid"
import { createSignal, onCleanup } from "solid-js"
import { render } from "solid-js/web"
import "@ericsanchezok/synergy-ui/styles"
import { setupI18n } from "@lingui/core"
import { ComposerResizeControls } from "../../../src/components/prompt-input/composer-resize-controls"
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
            "prompt.long.releaseExpand": "Release to expand",
          },
        },
      })}
    >
      <style>{`body {margin:0} .frame {position:relative;width:320px;height:500px} form {position:absolute;bottom:0;width:100%;margin:0} .composer-resize-controls{height:24px;position:relative;display:flex;justify-content:center} .composer-resize-handle{width:64px;height:24px;touch-action:none} .composer-size-menu{position:absolute;right:40px;top:0;width:32px;height:24px;display:flex;align-items:center;justify-content:center} .session-composer-editor{height:96px} .footer{height:36px}`}</style>
      <div class="frame">
        <form>
          <ComposerResizeControls input={input} availableHeight={500} />
          <div class="session-composer-editor" style={{ height: `${height()}px` }} />
          <div class="footer" />
        </form>
      </div>
      <output id="expanded">{(version(), String(state.expanded))}</output>
    </I18nProvider>
  )
}
render(() => <Fixture />, document.getElementById("root")!)
