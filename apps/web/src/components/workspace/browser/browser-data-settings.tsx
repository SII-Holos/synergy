import { createSignal, createEffect, onCleanup, For, onMount, Show } from "solid-js"
import { useLingui } from "@lingui/solid"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { Dialog } from "@ericsanchezok/synergy-ui/dialog"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { usePlatform } from "@/context/platform"
import { useConfirm } from "@/components/dialog/confirm-dialog"
import {
  BROWSER_PROTOCOL_VERSION,
  type BrowserDataAction,
  type BrowserDataState,
  type BrowserImportResult,
} from "@ericsanchezok/synergy-browser-core"
import { browser as B } from "@/locales/messages"
import { createBrowserCommandId } from "./browser-command"

const M = {
  progress: { id: "browser.data.progress", message: "Processed {processed} of {total}" },
  data: { id: "browser.data.title", message: "Browser data" },
  passwords: { id: "browser.data.passwords", message: "Passwords and autofill" },
  passwordHint: {
    id: "browser.data.passwordHint",
    message: "Choose an account to fill this website. Sign-in forms are never submitted automatically.",
  },
  save: { id: "browser.data.save", message: "Save current login" },
  saveHint: {
    id: "browser.data.saveHint",
    message:
      "Enter your username and password on the webpage before saving. An existing entry for this account will be updated.",
  },
  saveConfirm: { id: "browser.data.saveConfirm", message: "Save this website's login?" },
  saved: { id: "browser.data.saved", message: "Login saved." },
  fill: { id: "browser.data.fill", message: "Fill login" },
  remove: { id: "browser.data.remove", message: "Delete saved password" },
  removeHint: {
    id: "browser.data.removeHint",
    message: "This removes the saved password from this browser profile. Existing website sessions are kept.",
  },
  empty: { id: "browser.data.empty", message: "No saved passwords" },
  unavailable: {
    id: "browser.data.unavailable",
    message:
      "Password storage requires a persistent browser profile and an unlocked system password store. You can continue browsing and sign in manually.",
  },
  passwordFile: { id: "browser.data.passwordFile", message: "Passwords (CSV or Safari ZIP)" },
  cookieFile: { id: "browser.data.cookieFile", message: "Cookies (JSON)" },
  importHint: {
    id: "browser.data.importHint",
    message:
      "Import a Chrome, Edge or Safari password export, or a Cookie JSON file. Only the selected data type is imported into this browser profile. Some websites will still require sign-in.",
  },
  overwrite: { id: "browser.data.overwrite", message: "Replace matching existing entries" },
  choose: { id: "browser.data.choose", message: "Choose file and import" },
  importing: { id: "browser.data.importing", message: "Importing…" },
  result: { id: "browser.data.result", message: "Imported: {imported} · Skipped: {skipped} · Failed: {failed}" },
  cancelled: { id: "browser.data.cancelled", message: "Import stopped. Entries already imported have been kept." },
  failures: {
    id: "browser.data.failures",
    message: "Failed rows contain invalid data or unsupported cookie attributes. Other entries were preserved.",
  },
  recent: { id: "browser.data.recent", message: "Recently visited" },
  recentHint: {
    id: "browser.data.recentHint",
    message: "The last 100 addresses are kept in this browser profile. Temporary browsing leaves no recent history.",
  },
  clear: { id: "browser.data.clear", message: "Clear recent history" },
  clearHint: {
    id: "browser.data.clearHint",
    message: "Remove recent addresses from this browser profile? Passwords and website logins are kept.",
  },
  search: { id: "browser.data.search", message: "Search websites or usernames" },
}

type Props = {
  ownerKey: string
  pageId: string
  url: string
  section?: "import" | "passwords"
  onNavigate?(url: string): void
}
export function BrowserDataDialog(props: Props) {
  const { _ } = useLingui()
  return (
    <Dialog title={_(props.section === "passwords" ? M.passwords : B.importData)} size="form">
      <div class="min-h-0 overflow-y-auto p-5">
        <BrowserDataSettings {...props} />
      </div>
    </Dialog>
  )
}

export function BrowserDataSettings(props: Props) {
  const platform = usePlatform(),
    confirm = useConfirm(),
    dialog = useDialog(),
    { _ } = useLingui()
  const [data, setData] = createSignal<BrowserDataState>()
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal("")
  const [notice, setNotice] = createSignal("")
  const [kind, setKind] = createSignal<"passwords" | "cookies">("passwords")
  const [overwrite, setOverwrite] = createSignal(false)
  const [result, setResult] = createSignal<BrowserImportResult>()
  const [progress, setProgress] = createSignal({ processed: 0, total: 0 })
  const [job, setJob] = createSignal<string>()
  const [filter, setFilter] = createSignal("")
  const action = (action: BrowserDataAction) =>
    platform.browserNative!.dataAction!({
      protocolVersion: BROWSER_PROTOCOL_VERSION,
      ownerKey: props.ownerKey,
      pageId: props.pageId,
      action,
    })
  createEffect(() => {
    const requestId = job()
    if (!requestId) return
    setProgress({ processed: 0, total: 0 })
    const timer = setInterval(() => {
      void action({ type: "importProgress", requestId })
        .then((value) => {
          if (value.type === "progress" && job() === requestId) setProgress(value)
        })
        .catch(() => undefined)
    }, 500)
    onCleanup(() => clearInterval(timer))
  })
  const refresh = async () => {
    const next = await action({ type: "state" })
    if (next.type === "state") setData(next)
  }
  async function run(work: () => Promise<void>) {
    if (busy()) return
    setBusy(true)
    setError("")
    setNotice("")
    try {
      await work()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setBusy(false)
    }
  }
  onMount(() => void run(refresh))
  const matchesOrigin = (origin: string) => {
    try {
      return new URL(props.url).origin === origin
    } catch {
      return false
    }
  }
  return (
    <div class="flex flex-col gap-5 text-13">
      <Show when={error()}>
        <p role="alert" class="text-text-critical-base">
          {error()}
        </p>
        <Button size="small" onClick={() => void run(refresh)}>
          {_(B.retry)}
        </Button>
      </Show>
      <Show when={notice()}>
        <p role="status" class="text-text-weak">
          {notice()}
        </p>
      </Show>
      <Show when={props.section !== "passwords"}>
        <section class="flex flex-col gap-3">
          <h3 class="text-14-medium text-text-strong">{_(B.importData)}</h3>
          <p class="text-12 text-text-weak">{_(M.importHint)}</p>
          <select
            class="rounded-md border border-border-weak-base bg-surface-base px-3 py-2"
            aria-label={_(B.importData)}
            value={kind()}
            disabled={busy()}
            onChange={(event) => setKind(event.currentTarget.value as "passwords" | "cookies")}
          >
            <option value="passwords">{_(M.passwordFile)}</option>
            <option value="cookies">{_(M.cookieFile)}</option>
          </select>
          <label class="flex items-center gap-2 text-12">
            <input
              type="checkbox"
              checked={overwrite()}
              disabled={busy()}
              onChange={(event) => setOverwrite(event.currentTarget.checked)}
            />
            {_(M.overwrite)}
          </label>
          <div class="flex flex-wrap gap-2">
            <Button
              size="small"
              disabled={busy() || !data() || (kind() === "passwords" && !data()?.passwordStorage)}
              onClick={() =>
                void run(async () => {
                  const requestId = createBrowserCommandId()
                  setJob(requestId)
                  setResult(undefined)
                  try {
                    const imported = await action({ type: "import", kind: kind(), overwrite: overwrite(), requestId })
                    if (imported.type === "import") setResult(imported)
                    await refresh()
                  } finally {
                    setJob(undefined)
                  }
                })
              }
            >
              {_(job() ? M.importing : M.choose)}
            </Button>
            <Show when={job()}>
              <Button
                size="small"
                variant="ghost"
                onClick={() => void action({ type: "cancelImport", requestId: job()! })}
              >
                {_(B.cancel)}
              </Button>
            </Show>
          </div>
          <Show when={job() && progress().total}>
            <p role="status" class="text-12 text-text-weak">
              {_({ id: M.progress.id, message: M.progress.message, values: progress() })}
            </p>
          </Show>
          <Show when={result()}>
            {(result) => (
              <div role="status" class="text-12 text-text-weak">
                <p>{_({ id: M.result.id, message: M.result.message, values: result() })}</p>
                <Show when={result().cancelled}>
                  <p>{_(M.cancelled)}</p>
                </Show>
                <Show when={result().failed}>
                  <p>{_(M.failures)}</p>
                </Show>
              </div>
            )}
          </Show>
        </section>
      </Show>
      <Show when={data() && !data()?.passwordStorage}>
        <p class="text-12 text-text-weak">{_(M.unavailable)}</p>
      </Show>
      <Show when={props.section !== "import"}>
        <section class="flex flex-col gap-3">
          <h3 class="text-14-medium text-text-strong">{_(M.passwords)}</h3>
          <p class="text-12 text-text-weak">{_(M.passwordHint)}</p>
          <input
            type="search"
            class="rounded-md border border-border-weak-base bg-surface-base px-3 py-2"
            placeholder={_(M.search)}
            aria-label={_(M.search)}
            value={filter()}
            onInput={(event) => setFilter(event.currentTarget.value)}
          />
          <Show when={data()?.passwords.length} fallback={<p class="text-12 text-text-weak">{_(M.empty)}</p>}>
            <div class="flex max-h-64 flex-col overflow-auto divide-y divide-border-weak-base">
              <For
                each={data()?.passwords.filter((entry) =>
                  `${entry.origin} ${entry.username}`.toLowerCase().includes(filter().toLowerCase()),
                )}
              >
                {(entry) => (
                  <div class="flex items-center gap-2 py-3">
                    <div class="min-w-0 flex-1">
                      <div class="truncate">{entry.origin}</div>
                      <div class="truncate text-12 text-text-weak">{entry.username}</div>
                    </div>
                    <Show when={matchesOrigin(entry.origin)}>
                      <Button
                        size="small"
                        disabled={busy() || !data()?.passwordStorage}
                        onClick={() =>
                          void run(async () => {
                            await action({ type: "fillLogin", id: entry.id })
                            dialog.close()
                          })
                        }
                      >
                        {_(M.fill)}
                      </Button>
                    </Show>
                    <Button
                      size="small"
                      variant="ghost"
                      disabled={busy()}
                      onClick={() =>
                        void run(async () => {
                          if (
                            !(await confirm.ask({
                              title: _(M.remove),
                              description: _(M.removeHint),
                              confirmLabel: _(M.remove),
                              tone: "danger",
                            }))
                          )
                            return
                          await action({ type: "deletePassword", id: entry.id })
                          await refresh()
                        })
                      }
                    >
                      {_(M.remove)}
                    </Button>
                  </div>
                )}
              </For>
            </div>
          </Show>
          <Button
            size="small"
            variant="secondary"
            disabled={busy() || !data()?.passwordStorage || !/^https?:/.test(props.url)}
            onClick={() =>
              void run(async () => {
                if (
                  !(await confirm.ask({
                    title: _(M.saveConfirm),
                    description: _(M.saveHint),
                    confirmLabel: _(M.save),
                    tone: "neutral",
                  }))
                )
                  return
                await action({ type: "saveLogin" })
                setNotice(_(M.saved))
                await refresh()
              })
            }
          >
            {_(M.save)}
          </Button>
        </section>
      </Show>
      <Show when={!props.section}>
        <section class="flex flex-col gap-3 border-t border-border-weak-base pt-4">
          <h3 class="text-14-medium text-text-strong">{_(M.recent)}</h3>
          <p class="text-12 text-text-weak">{_(M.recentHint)}</p>
          <div class="max-h-48 overflow-auto">
            <For each={data()?.history}>
              {(entry) => (
                <button
                  class="block w-full truncate rounded px-2 py-1.5 text-left hover:bg-surface-raised-base"
                  title={entry.url}
                  onClick={() => {
                    props.onNavigate?.(entry.url)
                    dialog.close()
                  }}
                >
                  {entry.title || entry.url}
                </button>
              )}
            </For>
          </div>
          <Button
            size="small"
            variant="ghost"
            disabled={busy() || !data()?.history.length}
            onClick={() =>
              void run(async () => {
                if (
                  !(await confirm.ask({
                    title: _(M.clear),
                    description: _(M.clearHint),
                    confirmLabel: _(M.clear),
                    tone: "danger",
                  }))
                )
                  return
                await action({ type: "clearHistory" })
                await refresh()
              })
            }
          >
            {_(M.clear)}
          </Button>
        </section>
      </Show>
    </div>
  )
}
