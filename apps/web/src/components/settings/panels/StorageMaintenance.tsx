import { createSignal, onCleanup, onMount, Show } from "solid-js"
import { useLingui } from "@lingui/solid"
import type { StorageMaintenanceStatus } from "@ericsanchezok/synergy-sdk"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { SettingRow } from "@ericsanchezok/synergy-ui/setting-row"
import type { DesktopServerBridge, DesktopServerStatus } from "@/context/platform"
import { requestErrorMessage } from "@/utils/error"
import { SettingsSection } from "../components/SettingsPrimitives"

const title = { id: "settings.storage.format.status.title", message: "Database maintenance" }
const ready = { id: "settings.storage.format.ready", message: "Saved data is ready" }
const pending = { id: "settings.storage.format.pending", message: "Storage optimization available" }
const description = {
  id: "settings.storage.format.status.description",
  message: "You can keep using Synergy. Optimize storage when convenient; large databases may take a while.",
}
const maintenance = { id: "settings.storage.format.start", message: "Optimize storage" }
const resume = { id: "settings.storage.format.resume", message: "Continue optimization" }
const running = { id: "settings.storage.format.running", message: "Optimizing saved data…" }
const returnLabel = { id: "settings.storage.format.return", message: "Return to Synergy" }
const stopping = { id: "settings.storage.format.stopping", message: "Saving progress and returning…" }
const progressLabel = (step: number, current: number) => ({
  id: "settings.storage.format.progress",
  message: "Step {step}: {current} processed. You can return to Synergy and continue later.",
  values: { step, current },
})
const external = {
  id: "settings.storage.format.external",
  message: "On the server host, stop Synergy, run the command below, then restart the server.",
}
const loading = { id: "settings.storage.format.loading", message: "Checking database status…" }
const failed = { id: "settings.storage.format.failed", message: "Could not load database status. Try refreshing." }
const refreshLabel = { id: "settings.storage.refresh", message: "Refresh" }
const reclaimTitle = { id: "settings.storage.reclaim.status.title", message: "Space reclamation" }
const reclaimPending = { id: "settings.storage.reclaim.status.pending", message: "Waiting until Synergy is idle" }
const reclaimRunning = { id: "settings.storage.reclaim.status.running", message: "Running in the background" }
const reclaimPaused = { id: "settings.storage.reclaim.status.paused", message: "Paused" }
const reclaimDone = { id: "settings.storage.reclaim.status.done", message: "No space reclamation pending" }
const pause = { id: "settings.storage.reclaim.pause", message: "Pause" }
const unpause = { id: "settings.storage.reclaim.resume", message: "Resume" }
const pruneTitle = { id: "settings.storage.prune.title", message: "Large expired execution records" }
const pruneDescription = {
  id: "settings.storage.prune.description",
  message:
    "Remove execution evidence outside your retention window during maintenance. Conversation messages are preserved. Removed evidence cannot be restored.",
}
const pruneAction = { id: "settings.storage.prune.action", message: "Remove expired evidence" }

export function StorageMaintenance(props: {
  status?: StorageMaintenanceStatus
  loading: boolean
  error?: unknown
  bridge?: DesktopServerBridge
  controlBusy: boolean
  onRefresh(): unknown
  onControl(action: "pause" | "resume"): unknown
}) {
  const { _ } = useLingui()
  const [desktop, setDesktop] = createSignal<DesktopServerStatus | null>(null)
  const [action, setAction] = createSignal<"maintenance" | "return" | null>(null)
  const [error, setError] = createSignal<string>()
  const active = () => action() === "maintenance" || desktop()?.maintenance?.state === "running"
  const managed = () => desktop()?.mode === "managed" && Boolean(props.bridge?.maintenance)
  let disposed = false
  let polling = false

  const poll = async () => {
    if (disposed || polling || !props.bridge) return
    polling = true
    try {
      const status = await props.bridge.status()
      if (!disposed) setDesktop(status)
    } catch (error) {
      if (!disposed) setError(requestErrorMessage(error))
    } finally {
      polling = false
    }
  }
  onMount(() => {
    void poll()
    const timer = setInterval(() => void poll(), 1000)
    const refresh = setInterval(() => {
      if (!active()) props.onRefresh()
    }, 15_000)
    onCleanup(() => {
      disposed = true
      clearInterval(timer)
      clearInterval(refresh)
    })
  })

  async function run(next: "maintenance" | "return", operation?: "format" | "prune") {
    if (action() && next !== "return") return
    if (action() === "return") return
    setAction(next)
    setError(undefined)
    try {
      const result =
        next === "maintenance"
          ? await props.bridge?.maintenance?.(operation)
          : await props.bridge?.cancelMaintenance?.()
      if (!disposed && result) setDesktop(result)
    } catch (error) {
      if (!disposed && action() === next) setError(requestErrorMessage(error))
    } finally {
      if (!disposed && action() === next) setAction(null)
      await poll()
    }
  }

  return (
    <SettingsSection title={_(title)}>
      <Show
        when={active() || action() === "return"}
        fallback={
          <Show
            when={props.status}
            fallback={
              <>
                <p class="ds-section-hint">{props.error ? _(failed) : _(loading)}</p>
                <Show when={props.error}>
                  <Button size="small" disabled={props.loading} onClick={() => props.onRefresh()}>
                    {_(refreshLabel)}
                  </Button>
                </Show>
              </>
            }
          >
            {(status) => (
              <>
                <SettingRow
                  title={status().format.maintenanceRequired ? _(pending) : _(ready)}
                  description={_(description)}
                  trailing={
                    <Show
                      when={status().format.maintenanceRequired && managed()}
                      fallback={
                        <Button size="small" disabled={props.loading} onClick={() => props.onRefresh()}>
                          {_(refreshLabel)}
                        </Button>
                      }
                    >
                      <Button size="small" disabled={Boolean(action())} onClick={() => void run("maintenance")}>
                        {status().format.phase ? _(resume) : _(maintenance)}
                      </Button>
                    </Show>
                  }
                />
                <Show when={status().format.maintenanceRequired && !managed()}>
                  <p class="ds-section-hint">{_(external)}</p>
                  <code class="break-words">synergy migration run storage --maintenance</code>
                </Show>
                <SettingRow
                  title={_(reclaimTitle)}
                  description={
                    status().reclaim.paused
                      ? _(reclaimPaused)
                      : status().reclaim.running
                        ? _(reclaimRunning)
                        : status().reclaim.pending
                          ? _(reclaimPending)
                          : _(reclaimDone)
                  }
                  trailing={
                    <Show when={status().reclaim.pending}>
                      <Button
                        size="small"
                        disabled={props.controlBusy}
                        onClick={() => props.onControl(status().reclaim.paused ? "resume" : "pause")}
                      >
                        {status().reclaim.paused ? _(unpause) : _(pause)}
                      </Button>
                    </Show>
                  }
                />
                <Show when={(status().prune?.owners ?? 0) > 0}>
                  <SettingRow
                    title={_(pruneTitle)}
                    description={_(pruneDescription)}
                    trailing={
                      <Show when={managed()}>
                        <Button
                          size="small"
                          disabled={Boolean(action())}
                          onClick={() => void run("maintenance", "prune")}
                        >
                          {_(pruneAction)}
                        </Button>
                      </Show>
                    }
                  />
                  <Show when={!managed()}>
                    <p class="ds-section-hint">{_(external)}</p>
                    <code class="break-words">synergy data storage prune</code>
                  </Show>
                </Show>
                <Show when={status().reclaim.error}>{(message) => <p class="ds-section-hint">{message()}</p>}</Show>
              </>
            )}
          </Show>
        }
      >
        <SettingRow
          title={action() === "return" ? _(stopping) : _(running)}
          description={
            desktop()?.maintenance?.progress
              ? _(progressLabel(desktop()!.maintenance!.progress!.step, desktop()!.maintenance!.progress!.current))
              : _(description)
          }
          trailing={
            <Button
              size="small"
              disabled={action() === "return" || !props.bridge?.cancelMaintenance}
              onClick={() => void run("return")}
            >
              {_(returnLabel)}
            </Button>
          }
        />
      </Show>
      <Show when={error()}>
        {(message) => (
          <p class="ds-section-hint" role="alert">
            {message()}
          </p>
        )}
      </Show>
    </SettingsSection>
  )
}
