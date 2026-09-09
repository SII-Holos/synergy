import { createSignal } from "solid-js"
import { render } from "solid-js/web"
import { setupI18n } from "@lingui/core"
import { I18nProvider } from "@lingui/solid"
import { DialogProvider, useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { Dialog } from "@ericsanchezok/synergy-ui/dialog"
import { useConfirm } from "../../../src/components/dialog/confirm-dialog"
import { UIStyleProvider } from "@ericsanchezok/synergy-ui/context/ui-style"

function Fixture() {
  const dialog = useDialog()
  const confirm = useConfirm()
  const [result, setResult] = createSignal("pending")
  let own: string | undefined
  return (
    <>
      <button
        id="confirm"
        onClick={() =>
          confirm.show({
            title: "Confirm fixture",
            description: "Choose",
            confirmLabel: "Accept",
            tone: "neutral",
            onConfirm() {},
            onConfirmed: () => setResult("accepted"),
            onDismiss: () => setResult("dismissed"),
          })
        }
      >
        Confirm
      </button>
      <output id="result">{result()}</output>
      <button
        id="outer"
        onClick={() => {
          own = dialog.push(() => (
            <Dialog title="Outer">
              <button
                id="inner"
                onClick={() =>
                  dialog.push(() => (
                    <Dialog title="Inner">
                      <button id="close-outer" onClick={() => dialog.close(own)}>
                        Release outer
                      </button>
                    </Dialog>
                  ))
                }
              >
                Inner
              </button>
            </Dialog>
          ))
        }}
      >
        Outer
      </button>
    </>
  )
}
const i18n = setupI18n({ locale: "en", messages: { en: {} } })
render(
  () => (
    <I18nProvider i18n={i18n}>
      <DialogProvider>
        <UIStyleProvider pluginId="fixture" skinId="fixture-skin">
          <Fixture />
        </UIStyleProvider>
      </DialogProvider>
    </I18nProvider>
  ),
  document.getElementById("root")!,
)
