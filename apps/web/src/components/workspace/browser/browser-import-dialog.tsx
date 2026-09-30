import { createEffect, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { useLingui } from "@lingui/solid"
import { Dialog } from "@ericsanchezok/synergy-ui/dialog"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { MenuField } from "@ericsanchezok/synergy-ui/menu-field"
import { Switch } from "@ericsanchezok/synergy-ui/switch"
import { Checkbox } from "@ericsanchezok/synergy-ui/checkbox"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import {
  BROWSER_PROTOCOL_VERSION,
  type BrowserDataAction,
  type BrowserDataResult,
  type BrowserImportSource,
  type BrowserImportKind,
  type BrowserImportResult,
} from "@ericsanchezok/synergy-browser-core"
import { usePlatform } from "@/context/platform"
import { useConfirm } from "@/components/dialog/confirm-dialog"
import { browser as B } from "@/locales/messages"
import { createBrowserCommandId } from "./browser-command"
import "./browser-import-dialog.css"

const M = {
  hint: { id: "browser.import.hint", message: "Bring your saved passwords and website logins into Synergy." },
  source: { id: "browser.import.source", message: "From" },
  file: { id: "browser.import.file", message: "Exported file" },
  passwords: { id: "browser.import.passwords", message: "Passwords" },
  cookies: { id: "browser.import.cookies", message: "Cookies" },
  passwordHint: { id: "browser.import.passwordHint", message: "Saved accounts for signing in" },
  cookieHint: { id: "browser.import.cookieHint", message: "Website logins and preferences" },
  unsupported: { id: "browser.import.unsupported", message: "Not available from this source" },
  locked: {
    id: "browser.import.locked",
    message: "Use a persistent browser profile and unlock the system password store.",
  },
  local: {
    id: "browser.import.local",
    message: "Your Mac may ask for permission. Imported passwords stay encrypted on this device.",
  },
  encrypted: {
    id: "browser.import.encrypted",
    message: "Imported passwords stay encrypted on this device. Some websites may ask you to sign in again.",
  },
  safari: {
    id: "browser.import.safari",
    message:
      "In Safari, choose File → Export Browsing Data, include passwords, then select the exported ZIP or CSV here.",
  },
  fileHint: {
    id: "browser.import.fileHint",
    message: "Use a password CSV or Safari ZIP, or a Cookie JSON file. You’ll choose one file for each selected type.",
  },
  options: { id: "browser.import.options", message: "Import options" },
  replace: { id: "browser.import.replace", message: "Replace matching existing entries" },
  replaceTitle: { id: "browser.import.replaceTitle", message: "Replace matching browser data?" },
  replaceHint: {
    id: "browser.import.replaceHint",
    message: "Matching saved passwords and cookies will be replaced by the imported entries. Other entries are kept.",
  },
  start: { id: "browser.import.start", message: "Import" },
  choose: { id: "browser.import.choose", message: "Choose file and import" },
  reading: { id: "browser.import.reading", message: "Reading selected data…" },
  importing: { id: "browser.import.importing", message: "Importing…" },
  progress: { id: "browser.import.progress", message: "{processed} of {total} entries" },
  stop: { id: "browser.import.stop", message: "Stop import" },
  stopped: { id: "browser.import.stopped", message: "Import stopped. Entries already imported have been kept." },
  done: { id: "browser.import.done", message: "Done" },
  result: { id: "browser.import.result", message: "{imported} imported · {skipped} skipped · {failed} failed" },
  failed: {
    id: "browser.import.failed",
    message:
      "Some entries could not be imported. Existing entries were preserved. You can use an exported file or sign in on the website.",
  },
  access: {
    id: "browser.import.access",
    message: "Access was not granted. Retry the system prompt or choose an exported file.",
  },
  unavailable: {
    id: "browser.import.unavailable",
    message: "This data could not be read. Quit the source browser and retry, or use an exported file.",
  },
  format: {
    id: "browser.import.format",
    message: "Choose a supported file under 32 MB: password CSV, Safari ZIP or Cookie JSON.",
  },
  error: { id: "browser.import.error", message: "Import is unavailable. Reopen the browser page and try again." },
  loading: { id: "browser.import.loading", message: "Finding browsers…" },
}
const names = { chrome: "Google Chrome", edge: "Microsoft Edge", brave: "Brave", safari: "Safari" }

export function BrowserImportDialog(props: { ownerKey: string; pageId: string }) {
  const platform = usePlatform(),
    dialog = useDialog(),
    confirm = useConfirm(),
    { _ } = useLingui()
  const [sources, setSources] = createSignal<BrowserImportSource[]>([])
  const [sourceId, setSourceId] = createSignal("")
  const [kinds, setKinds] = createSignal<BrowserImportKind[]>(["passwords", "cookies"])
  const [passwordStorage, setPasswordStorage] = createSignal(false)
  const [loading, setLoading] = createSignal(true)
  const [error, setError] = createSignal(false)
  const [overwrite, setOverwrite] = createSignal(false)
  const [job, setJob] = createSignal<string>()
  const [confirming, setConfirming] = createSignal(false)
  const [progress, setProgress] = createSignal<Extract<BrowserDataResult, { type: "progress" }>>({
    type: "progress",
    phase: "reading",
    processed: 0,
    total: 0,
  })
  const [result, setResult] = createSignal<BrowserImportResult>()
  const source = () => sources().find((source) => source.id === sourceId())
  const busy = () => Boolean(job()) || confirming()
  const available = (kind: BrowserImportKind) =>
    Boolean(source()?.kinds.includes(kind) && (kind !== "passwords" || passwordStorage()))
  const selected = () => kinds().filter(available)
  const action = (action: BrowserDataAction) =>
    platform.browserNative!.dataAction!({
      protocolVersion: BROWSER_PROTOCOL_VERSION,
      ownerKey: props.ownerKey,
      pageId: props.pageId,
      action,
    })
  const label = (source: BrowserImportSource) =>
    source.browser === "file" ? _(M.file) : [names[source.browser], source.profile].filter(Boolean).join(" · ")
  const load = async () => {
    setLoading(true)
    setError(false)
    try {
      const [catalog, state] = await Promise.all([action({ type: "importSources" }), action({ type: "state" })])
      if (catalog.type !== "sources" || state.type !== "state") throw new Error("Unavailable")
      setSources(catalog.sources)
      setPasswordStorage(state.passwordStorage)
      setSourceId(catalog.sources.find((source) => source.mode === "direct")?.id ?? "file")
    } catch {
      setError(true)
    } finally {
      setLoading(false)
    }
  }
  onMount(() => void load())
  onCleanup(() => {
    const requestId = job()
    if (requestId) void action({ type: "cancelImport", requestId }).catch(() => undefined)
  })
  createEffect(() => {
    const requestId = job()
    if (!requestId) return
    const timer = setInterval(() => {
      void action({ type: "importProgress", requestId })
        .then((value) => {
          if (value.type === "progress" && job() === requestId) setProgress(value)
        })
        .catch(() => undefined)
    }, 500)
    onCleanup(() => clearInterval(timer))
  })
  const stop = () => {
    const requestId = job()
    if (requestId) void action({ type: "cancelImport", requestId }).catch(() => setError(true))
  }
  async function start() {
    if (busy() || !selected().length) return
    setConfirming(true)
    try {
      if (
        overwrite() &&
        !(await confirm.ask({
          title: _(M.replaceTitle),
          description: _(M.replaceHint),
          confirmLabel: _(M.start),
          tone: "danger",
        }))
      )
        return
      const requestId = createBrowserCommandId()
      setJob(requestId)
      setResult(undefined)
      setError(false)
      setProgress({ type: "progress", phase: "reading", processed: 0, total: 0 })
      const value = await action({
        type: "import",
        sourceId: sourceId(),
        kinds: selected(),
        overwrite: overwrite(),
        requestId,
      })
      if (value.type === "import") setResult(value)
    } catch {
      setError(true)
    } finally {
      setJob(undefined)
      setConfirming(false)
    }
  }
  const kindLabel = (kind: BrowserImportKind) => _(kind === "passwords" ? M.passwords : M.cookies)
  const failure = (error: NonNullable<BrowserImportResult["items"][number]["error"]>) => {
    if (error === "access") return _(M.access)
    if (error === "unavailable") return _(M.unavailable)
    if (error === "format") return _(M.format)
    return _(M.locked)
  }
  return (
    <Dialog title={_(B.importData)} description={_(M.hint)} size="form" class="browser-import-dialog">
      <div class="browser-import-body">
        <Show when={loading()}>
          <p role="status">{_(M.loading)}</p>
        </Show>
        <Show when={error()}>
          <div role="alert" class="browser-import-error">
            <p>{_(M.error)}</p>
            <Button size="small" variant="ghost" disabled={busy()} onClick={() => void load()}>
              {_(B.retry)}
            </Button>
          </div>
        </Show>
        <Show when={!loading() && source()}>
          <div class="browser-import-source">
            <span>{_(M.source)}</span>
            <MenuField
              options={sources().map((source) => ({ value: source.id, label: label(source) }))}
              value={sourceId()}
              ariaLabel={_(M.source)}
              disabled={busy()}
              triggerClass="browser-import-source-trigger"
              surfaceClass="browser-import-source-menu"
              onChange={(id) => {
                setSourceId(id)
                setResult(undefined)
              }}
            />
          </div>
          <div class="browser-import-types">
            <For each={["passwords", "cookies"] as const}>
              {(kind) => (
                <div class="browser-import-type">
                  <div>
                    <span class="browser-import-type-name">{kindLabel(kind)}</span>
                    <p>
                      {!source()?.kinds.includes(kind)
                        ? _(M.unsupported)
                        : kind === "passwords" && !passwordStorage()
                          ? _(M.locked)
                          : _(kind === "passwords" ? M.passwordHint : M.cookieHint)}
                    </p>
                  </div>
                  <Switch
                    hideLabel
                    checked={available(kind) && kinds().includes(kind)}
                    disabled={busy() || !available(kind)}
                    onChange={(checked) =>
                      setKinds((items) =>
                        checked
                          ? [...items.filter((item) => item !== kind), kind]
                          : items.filter((item) => item !== kind),
                      )
                    }
                  >
                    {kindLabel(kind)}
                  </Switch>
                </div>
              )}
            </For>
          </div>
          <Show when={source()?.mode === "file"}>
            <p class="browser-import-help">{_(source()?.browser === "safari" ? M.safari : M.fileHint)}</p>
          </Show>
          <p class="browser-import-privacy">{_(source()?.mode === "direct" ? M.local : M.encrypted)}</p>
          <details class="browser-import-options">
            <summary>{_(M.options)}</summary>
            <Checkbox checked={overwrite()} disabled={busy()} onChange={setOverwrite}>
              {_(M.replace)}
            </Checkbox>
          </details>
        </Show>
        <Show when={job()}>
          <div role="status" class="browser-import-status">
            <p>{_(progress().phase === "reading" ? M.reading : M.importing)}</p>
            <Show when={progress().total}>
              <progress max={progress().total} value={progress().processed} aria-label={_(M.importing)} />
              <p>{_({ ...M.progress, values: progress() })}</p>
            </Show>
          </div>
        </Show>
        <Show when={result()}>
          {(result) => (
            <div role="status" class="browser-import-results">
              <For each={result().items}>
                {(item) => (
                  <div>
                    <span class="browser-import-type-name">{kindLabel(item.kind)}</span>
                    <p>{_({ ...M.result, values: item })}</p>
                    <Show when={item.error}>{(error) => <p>{failure(error())}</p>}</Show>
                  </div>
                )}
              </For>
              <Show when={result().cancelled}>
                <p>{_(M.stopped)}</p>
              </Show>
              <Show when={result().failed}>
                <p>{_(M.failed)}</p>
              </Show>
            </div>
          )}
        </Show>
      </div>
      <div class="browser-import-footer">
        <Button variant="secondary" onClick={() => (job() ? stop() : dialog.close())}>
          {_(job() ? M.stop : result() ? M.done : B.cancel)}
        </Button>
        <Button variant="primary" disabled={loading() || busy() || !selected().length} onClick={() => void start()}>
          {_(job() ? M.importing : source()?.mode === "file" ? M.choose : M.start)}
        </Button>
      </div>
    </Dialog>
  )
}
