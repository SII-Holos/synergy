import { createSignal, For, onMount, Show } from "solid-js"
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
} from "@ericsanchezok/synergy-browser-core"
import { browser as B } from "@/locales/messages"
import { BrowserImportDialog } from "./browser-import-entry"

const M = {
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
  if (props.section === "import") return <BrowserImportDialog ownerKey={props.ownerKey} pageId={props.pageId} />
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
  const [filter, setFilter] = createSignal("")
  const action = (action: BrowserDataAction) =>
    platform.browserNative!.dataAction!({
      protocolVersion: BROWSER_PROTOCOL_VERSION,
      ownerKey: props.ownerKey,
      pageId: props.pageId,
      action,
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
        <p role="alert" class="text-text-on-critical-base">
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
        <Button
          variant="secondary"
          onClick={() =>
            dialog.push(
              () => <BrowserImportDialog ownerKey={props.ownerKey} pageId={props.pageId} />,
              () => void run(refresh),
            )
          }
        >
          {_(B.importData)}
        </Button>
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
