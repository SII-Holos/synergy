import { For, Show, createSignal, onMount } from "solid-js"
import { useNavigate } from "@solidjs/router"
import { useLingui } from "@lingui/solid"
import { Dialog } from "@ericsanchezok/synergy-ui/dialog"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { createSynergyClient, type SessionTransferState } from "@ericsanchezok/synergy-sdk/client"
import { base64Encode } from "@ericsanchezok/synergy-util/encode"
import { generateUUID } from "@ericsanchezok/synergy-util/uuid"
import { useGlobalSDK } from "@/context/global-sdk"
import { useServer, serverDisplayName } from "@/context/server"
import { usePlatform } from "@/context/platform"
import { migratePausedSession, type TransferProgress } from "@/components/session/session-transfer"
import "./dialog-session-export.css"

export const transferCopy = {
  failed: { id: "session.transfer.failed", message: "Session transfer failed" },
  title: { id: "session.transfer.title", message: "Move to another device" },
  description: {
    id: "session.transfer.description",
    message:
      "Move this paused task and its files to another connected device. It will stay paused until you continue it there.",
  },
  destination: { id: "session.transfer.destination", message: "Destination device" },
  empty: { id: "session.transfer.empty", message: "Add another device in the server selector first." },
  select: { id: "session.transfer.select", message: "Choose a device" },
  move: { id: "session.transfer.move", message: "Move task" },
  retry: { id: "session.transfer.retry", message: "Retry transfer" },
  cancel: { id: "session.transfer.cancel", message: "Cancel transfer" },
  open: { id: "session.transfer.open", message: "Open on destination" },
  preparing: { id: "session.transfer.preparing", message: "Preparing task and files…" },
  copying: { id: "session.transfer.copying", message: "Copying and verifying…" },
  committing: { id: "session.transfer.committing", message: "Handing over task…" },
  activating: { id: "session.transfer.activating", message: "Finishing on destination…" },
  completed: {
    id: "session.transfer.completed",
    message: "Moved. Continue the paused task on the destination device.",
  },
  committedHint: {
    id: "session.transfer.committedHint",
    message: "The source is locked. Retry to finish on the selected destination.",
  },
}

function message(error: unknown) {
  if (error && typeof error === "object" && "data" in error) {
    const data = error.data
    if (data && typeof data === "object" && "message" in data && typeof data.message === "string") return data.message
  }
  return error instanceof Error ? error.message : undefined
}

export function DialogSessionTransfer(props: { sessionID: string; scopeID: string }) {
  const { _ } = useLingui()
  const server = useServer()
  const platform = usePlatform()
  const source = useGlobalSDK().client
  const dialog = useDialog()
  const navigate = useNavigate()
  const destinations = () => server.list.filter((url) => url !== server.url)
  const [selected, setSelected] = createSignal("")
  const [state, setState] = createSignal<SessionTransferState | null>()
  const [busy, setBusy] = createSignal(false)
  const [loading, setLoading] = createSignal(true)
  const [error, setError] = createSignal("")
  const [progress, setProgress] = createSignal<TransferProgress>()
  const target = () => createSynergyClient({ baseUrl: selected(), fetch: platform.fetch, throwOnError: true })
  const refresh = async () => setState((await source.sessionTransfer.status(props)).data)
  onMount(async () => {
    try {
      await refresh()
      if (state() && state()!.phase !== "cancelled") {
        const matches = await Promise.all(
          destinations().map(async (url) => {
            const client = createSynergyClient({ baseUrl: url, fetch: platform.fetch, throwOnError: true })
            const identity = await client.sessionTransfer
              .host({}, { signal: AbortSignal.timeout(3000) })
              .catch(() => undefined)
            return identity?.data?.id === state()!.targetID ? url : undefined
          }),
        )
        setSelected(matches.find(Boolean) ?? "")
      }
    } catch (error) {
      setError(message(error) ?? _(transferCopy.failed))
    } finally {
      setLoading(false)
    }
  })
  function progressLabel(phase: TransferProgress) {
    switch (phase) {
      case "preparing":
        return _(transferCopy.preparing)
      case "copying":
        return _(transferCopy.copying)
      case "committing":
        return _(transferCopy.committing)
      case "activating":
        return _(transferCopy.activating)
      case "completed":
        return _(transferCopy.completed)
    }
  }
  async function move() {
    if (busy() || !selected()) return
    setBusy(true)
    setError("")
    try {
      await migratePausedSession({
        source,
        target: target(),
        ...props,
        migrationID: generateUUID(),
        progress: setProgress,
      })
    } catch (error) {
      setError(message(error) ?? _(transferCopy.failed))
    } finally {
      await refresh().catch(() => {})
      setBusy(false)
    }
  }
  async function cancel() {
    setBusy(true)
    setError("")
    try {
      const proof = (await source.sessionTransfer.cancel(props)).data
      const current = state()
      if (selected() && current && proof)
        await target()
          .sessionTransfer.discard({ migrationID: current.migrationID, sessionTransferCancellation: proof })
          .catch(() => {})
      await refresh()
      setProgress(undefined)
    } catch (error) {
      setError(message(error) ?? _(transferCopy.failed))
    } finally {
      setBusy(false)
    }
  }
  function open() {
    server.setActive(selected())
    dialog.close()
    navigate(`/${base64Encode(props.scopeID)}/session/${props.sessionID}`)
  }
  return (
    <Dialog title={_(transferCopy.title)} size="wide" class="dialog-session-export">
      <div class="session-export-body">
        <p class="text-14-regular text-text-weak">{_(transferCopy.description)}</p>
        <label class="session-export-label" for="session-transfer-destination">
          {_(transferCopy.destination)}
        </label>
        <select
          id="session-transfer-destination"
          value={selected()}
          onChange={(event) => setSelected(event.currentTarget.value)}
          disabled={busy() || loading() || (!!state() && state()!.phase !== "cancelled")}
          class="rounded-md border border-border-base bg-background-base p-2 text-text-base"
        >
          <option value="">{_(transferCopy.select)}</option>
          <For each={destinations()}>{(url) => <option value={url}>{serverDisplayName(url)}</option>}</For>
        </select>
        <Show when={!destinations().length}>
          <p>{_(transferCopy.empty)}</p>
        </Show>
        <Show when={progress()}>{(phase) => <p role="status">{progressLabel(phase())}</p>}</Show>
        <Show when={state()?.phase === "committed"}>
          <p>{_(transferCopy.committedHint)}</p>
        </Show>
        <Show when={error()}>
          <p role="alert" class="text-text-base">
            {error()}
          </p>
        </Show>
        <div class="flex justify-end gap-2">
          <Show when={state() && ["preparing", "prepared"].includes(state()!.phase)}>
            <Button disabled={busy()} onClick={cancel}>
              {_(transferCopy.cancel)}
            </Button>
          </Show>
          <Show
            when={state()?.phase === "completed" || progress() === "completed"}
            fallback={
              <Button variant="primary" disabled={!selected() || busy() || loading()} onClick={move}>
                {state() && state()!.phase !== "cancelled" ? _(transferCopy.retry) : _(transferCopy.move)}
              </Button>
            }
          >
            <Button variant="primary" disabled={!selected()} onClick={open}>
              {_(transferCopy.open)}
            </Button>
          </Show>
        </div>
      </div>
    </Dialog>
  )
}
