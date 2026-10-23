import { render } from "solid-js/web"
import { I18nProvider } from "@lingui/solid"
import { setupI18n } from "@lingui/core"
import { DialogProvider } from "@ericsanchezok/synergy-ui/context/dialog"
import { MarkedProvider } from "@ericsanchezok/synergy-ui/context/marked"
import { ThemeProvider } from "@ericsanchezok/synergy-ui/theme"
import { setExternalComposerSlotLookup } from "@ericsanchezok/synergy-ui/composer-slots"
import "@ericsanchezok/synergy-ui/styles"
import "@/index.css"
import { createPromptInputController } from "@/components/prompt-input/prompt-controller"
import { DefaultComposer } from "@/plugin/default-composer"

const Slot = () => <div data-fixture-slot="composer.above">Plugin contribution</div>
setExternalComposerSlotLookup((slot) => (slot === "composer.above" ? [{ id: "fixture", component: Slot }] : []))

function App() {
  const controller = createPromptInputController({})
  return (
    <div
      class="synergy-workbench-canvas"
      data-default-shell
      style={{ height: "100dvh", display: "flex", "flex-direction": "column" }}
    >
      <div
        class="session-workbench-pane synergy-workbench-canvas"
        style={{
          flex: "1",
          "min-height": "0",
          display: "flex",
          "flex-direction": "column",
          "justify-content": "flex-end",
        }}
      >
        <div class="session-prompt-dock-content session-content-column" style={{ position: "relative" }}>
          <DefaultComposer context={{ input: controller.input }} />
        </div>
      </div>
    </div>
  )
}

const i18n = setupI18n({ locale: "en", messages: {} })

render(
  () => (
    <I18nProvider i18n={i18n}>
      <ThemeProvider>
        <MarkedProvider>
          <DialogProvider>
            <App />
          </DialogProvider>
        </MarkedProvider>
      </ThemeProvider>
    </I18nProvider>
  ),
  document.getElementById("root")!,
)
