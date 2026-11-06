import { createSignal, onCleanup, onMount, Show } from "solid-js"
import { useLingui } from "@lingui/solid"
import { Dialog } from "@ericsanchezok/synergy-ui/dialog"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { browser as B } from "@/locales/messages"
import type { DialogRequest } from "./browser-store"

const titles = {
  prompt: { id: "app.browser.dialog.prompt", message: "Page requests input" },
  confirm: { id: "app.browser.dialog.confirm", message: "Page requests confirmation" },
  alert: { id: "app.browser.dialog.alert", message: "Page message" },
  beforeunload: { id: "app.browser.dialog.beforeunload", message: "Leave this page?" },
}
const inputLabel = { id: "app.browser.dialog.input", message: "Response" }

export function BrowserPageDialog(props: {
  request: DialogRequest
  onRespond(accept: boolean, promptText?: string): void
}) {
  const dialog = useDialog()
  const { _ } = useLingui()
  const request = props.request
  const [value, setValue] = createSignal(request.defaultValue ?? "")
  let id: string | undefined
  let settled = false
  const respond = (accept: boolean) => {
    if (settled) return
    settled = true
    const promptText = request.type === "prompt" && accept ? value() : undefined
    if (id) dialog.close(id)
    props.onRespond(accept, promptText)
  }
  onMount(() => {
    id = dialog.push(
      () => (
        <Dialog
          size="compact"
          title={_(
            request.type === "prompt"
              ? titles.prompt
              : request.type === "confirm"
                ? titles.confirm
                : request.type === "beforeunload"
                  ? titles.beforeunload
                  : titles.alert,
          )}
          description={request.message}
        >
          <form
            class="flex flex-col gap-4 p-4"
            onSubmit={(event) => {
              event.preventDefault()
              respond(true)
            }}
          >
            <Show when={request.type === "prompt"}>
              <label class="flex flex-col gap-2 text-12-medium">
                {_(inputLabel)}
                <input
                  autofocus
                  class="rounded-md border border-border-weak-base bg-background-base px-3 py-2 text-text-base"
                  value={value()}
                  onInput={(event) => setValue(event.currentTarget.value)}
                  onFocus={(event) => event.currentTarget.select()}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && event.isComposing) event.preventDefault()
                  }}
                />
              </label>
            </Show>
            <div class="flex justify-end gap-2">
              <Show when={request.type !== "alert"}>
                <Button variant="ghost" onClick={() => respond(false)}>
                  {_(B.cancel)}
                </Button>
              </Show>
              <Button type="submit" variant="primary" autofocus={request.type !== "prompt"}>
                {_(B.ok)}
              </Button>
            </div>
          </form>
        </Dialog>
      ),
      () => respond(request.type === "alert"),
    )
  })
  onCleanup(() => {
    settled = true
    if (id) dialog.close(id)
  })
  return null
}
