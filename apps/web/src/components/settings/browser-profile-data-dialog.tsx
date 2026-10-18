import { createEffect, createSignal, lazy, onCleanup, onMount, Show, Suspense } from "solid-js"
import { useLingui } from "@lingui/solid"
import { Dialog } from "@ericsanchezok/synergy-ui/dialog"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { MenuField } from "@ericsanchezok/synergy-ui/menu-field"
import { useGlobalSDK } from "@/context/global-sdk"
import { usePlatform } from "@/context/platform"
import { browserDataAccess, createBrowserDataContext } from "../workspace/browser/browser-data-context"
import { BrowserDataSettings } from "../workspace/browser/browser-data-settings"
import type { BrowserProfile } from "@ericsanchezok/synergy-browser-core"
import { browserSettingsCopy } from "./panels/BrowserPanel"
import "../workspace/browser/browser-import-dialog.css"

const ImportForm = lazy(() =>
  import("../workspace/browser/browser-import-dialog").then((module) => ({ default: module.BrowserImportForm })),
)
export function BrowserProfileDataDialog(props: { section: "import" | "passwords" }) {
  const { _ } = useLingui(),
    sdk = useGlobalSDK(),
    platform = usePlatform()
  const selection = sdk.capabilities.current(),
    serverUrl = sdk.url,
    bridge = platform.browserNative
  const [profiles, setProfiles] = createSignal<BrowserProfile[]>([])
  const [target, setTarget] = createSignal<Awaited<ReturnType<typeof createBrowserDataContext>>>()
  const [error, setError] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const lifetime = new AbortController()
  let preparation = new AbortController()
  let profileId: string | undefined
  let revision = 0
  const current = () =>
    !lifetime.signal.aborted && sdk.capabilities.current() === selection && sdk.capabilities.has("browser")
  const invalidate = () => {
    lifetime.abort()
    preparation.abort()
    setTarget(undefined)
  }
  createEffect(() => {
    if (!current()) invalidate()
  })
  onCleanup(invalidate)
  const load = async (selected = profileId) => {
    if (!bridge || !current()) return
    const token = ++revision
    preparation.abort()
    preparation = new AbortController()
    const signal = AbortSignal.any([lifetime.signal, preparation.signal])
    setBusy(true)
    setTarget(undefined)
    setError("")
    try {
      const access = await browserDataAccess({ client: sdk.client, bridge, serverUrl, scopeID: "home" }, signal)
      const catalog = await sdk.client.browser.profiles(access, { signal, throwOnError: true })
      if (!current() || token !== revision) return
      const choices = (catalog.data?.profiles ?? []).filter(
        (profile) => profile.enabled && profile.kind === "persistent",
      )
      setProfiles(choices)
      profileId = selected ?? catalog.data?.defaultProfileId ?? undefined
      if (!profileId || !choices.some((profile) => profile.id === profileId))
        throw new Error(
          _({ id: "settings.browser.chooseProfile", message: "Choose an enabled persistent browser profile." }),
        )
      const context = await createBrowserDataContext({
        client: sdk.client,
        bridge,
        serverUrl,
        scopeID: "home",
        profileId,
        current,
        signal,
      })
      if (!current() || token !== revision) {
        await context.release()
        return
      }
      setTarget(context)
    } catch (failure) {
      if (current() && token === revision)
        setError(
          failure instanceof Error
            ? failure.message
            : _({ id: "settings.browser.unavailable", message: "Browser data is unavailable. Retry." }),
        )
    } finally {
      if (current() && token === revision) setBusy(false)
    }
  }
  onMount(() => void load())
  const targetLabel = () =>
    _(
      props.section === "import"
        ? { id: "settings.browser.destination", message: "Save to" }
        : { id: "settings.browser.target", message: "Browser profile" },
    )
  const TargetPicker = () => (
    <Show when={profiles().length > 1}>
      <div class="browser-import-source">
        <span>{targetLabel()}</span>
        <MenuField
          value={target()?.profile.id ?? profileId ?? ""}
          ariaLabel={targetLabel()}
          options={profiles().map((profile) => ({ value: profile.id, label: profile.name }))}
          disabled={busy()}
          triggerClass="browser-import-source-trigger"
          surfaceClass="browser-import-source-menu"
          onChange={(id) => void load(id)}
        />
      </div>
    </Show>
  )
  return (
    <Dialog
      title={_(props.section === "import" ? browserSettingsCopy.import : browserSettingsCopy.manage)}
      size="form"
      class="browser-import-dialog"
    >
      <Show
        when={target()}
        keyed
        fallback={
          <div class="browser-import-body browser-profile-data-body">
            <TargetPicker />
            <Show when={busy()}>
              <p role="status">{_({ id: "settings.browser.preparing", message: "Preparing browser data…" })}</p>
            </Show>
            <Show when={error()}>
              <p role="alert">{error()}</p>
              <Button size="small" onClick={() => void load()}>
                {_({ id: "settings.browser.retry", message: "Retry" })}
              </Button>
            </Show>
          </div>
        }
      >
        {(destination) =>
          props.section === "import" ? (
            <Suspense>
              <ImportForm
                resolveTarget={Object.assign(async () => destination, { current: destination.current })}
                signal={preparation.signal}
                destination={<TargetPicker />}
              />
            </Suspense>
          ) : (
            <div class="browser-import-body browser-profile-data-body">
              <TargetPicker />
              <BrowserDataSettings managementTarget={destination} section="passwords" />
            </div>
          )
        }
      </Show>
    </Dialog>
  )
}
