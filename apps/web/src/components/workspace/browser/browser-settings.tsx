import { For, Show, createSignal, onMount } from "solid-js"
import { useLingui } from "@lingui/solid"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { Dialog } from "@ericsanchezok/synergy-ui/dialog"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { TextField } from "@ericsanchezok/synergy-ui/text-field"
import { MenuField } from "@ericsanchezok/synergy-ui/menu-field"
import type { BrowserOriginPolicy, BrowserProfile, BrowserProfileListSchema } from "@ericsanchezok/synergy-browser-core"
import type { z } from "zod"
import { useSDK } from "@/context/sdk"
import { useConfirm } from "@/components/dialog/confirm-dialog"
import { browser as B } from "@/locales/messages"
import { useBrowser } from "./browser-store"
import { normalizeBrowserError } from "./browser-error"
import { usePlatform } from "@/context/platform"
import { BrowserDataSettings } from "./browser-data-settings"

const M = {
  advanced: { id: "browser.settings.advanced", message: "Separate accounts and advanced settings" },
  login: { id: "browser.settings.login", message: "Saved logins" },
  explanation: {
    id: "browser.settings.loginHint",
    message:
      "Website logins are remembered across tasks. Add a separate browser profile only when you need another account.",
  },
  profiles: { id: "browser.settings.profiles", message: "Browser profile" },
  openAs: { id: "browser.identities.openAs", message: "Open this page with this profile" },
  temporary: { id: "browser.identities.temporary", message: "Browse temporarily" },
  temporaryHint: {
    id: "browser.settings.temporaryHint",
    message: "Temporary browsing starts signed out and clears website data when its last page closes.",
  },
  name: { id: "browser.identities.name", message: "Profile name" },
  create: { id: "browser.identities.create", message: "Add browser profile" },
  manage: { id: "browser.settings.manage", message: "Manage this profile" },
  save: { id: "browser.identities.save", message: "Save" },
  enable: { id: "browser.identities.enable", message: "Enable" },
  disable: { id: "browser.identities.disable", message: "Disable" },
  disabled: { id: "browser.settings.disabled", message: "Disabled" },
  default: { id: "browser.identities.default", message: "Use by default" },
  currentDefault: { id: "browser.identities.currentDefault", message: "Default" },
  clear: { id: "browser.identities.clear", message: "Clear website data" },
  remove: { id: "browser.identities.remove", message: "Delete profile" },
  confirm: {
    id: "browser.identities.confirm",
    message: "This closes this profile's pages and signs out of its websites. Continue?",
  },
  permissions: { id: "browser.settings.permissions", message: "Agent website permissions" },
  origin: { id: "browser.identities.origin", message: "Website" },
  access: { id: "browser.identities.access", message: "Access" },
  uploads: { id: "browser.identities.uploads", message: "Uploads" },
  downloads: { id: "browser.identities.downloads", message: "Downloads" },
  inherit: { id: "browser.identities.inherit", message: "Use task permissions" },
  allow: { id: "browser.identities.allow", message: "Allow" },
  ask: { id: "browser.identities.ask", message: "Ask" },
  deny: { id: "browser.identities.deny", message: "Deny" },
  revoke: { id: "browser.identities.revoke", message: "Reset website permissions" },
  policyNote: {
    id: "browser.identities.policyNote",
    message:
      "Rules apply to agents using this profile. Task permissions still apply. Full Access bypasses approval rules; disabled profiles stay unavailable.",
  },
  originPlaceholder: { id: "browser.identities.originPlaceholder", message: "https://example.com" },
  retry: { id: "browser.identities.retry", message: "Retry" },
}
type IdentityList = z.infer<typeof BrowserProfileListSchema>

export function BrowserSettings(props: {
  ownerKey?: string
  sessionID: string
  routeDirectory?: string
  createTicket(): Promise<string>
}) {
  const browser = useBrowser(),
    platform = usePlatform(),
    sdk = useSDK(),
    dialog = useDialog(),
    confirm = useConfirm(),
    { _ } = useLingui()
  const [catalog, setCatalog] = createSignal<IdentityList>({ defaultProfileId: null, profiles: [] })
  const [identity, setIdentity] = createSignal<string>()
  const [name, setName] = createSignal("")
  const [newName, setNewName] = createSignal("")
  const [creating, setCreating] = createSignal(false)
  const [origin, setOrigin] = createSignal("")
  const [policy, setPolicy] = createSignal<BrowserOriginPolicy>({})
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal("")
  const selected = () => catalog().profiles.find((profile) => profile.id === identity())
  const route = async () => ({
    path_directory: props.routeDirectory ?? sdk.directory ?? sdk.scopeID ?? sdk.scopeKey,
    query_directory: sdk.directory,
    scopeID: sdk.scopeID,
    mode: "session" as const,
    sessionID: props.sessionID,
    presentation: "native" as const,
    nativeTicket: await props.createTicket(),
  })
  async function run(fn: () => Promise<void>) {
    if (busy()) return
    setBusy(true)
    setError("")
    try {
      await fn()
    } catch (failure) {
      setError(normalizeBrowserError(failure, "Browser settings could not be saved. Retry the operation.").message)
    } finally {
      setBusy(false)
    }
  }
  function choose(profile: BrowserProfile) {
    setIdentity(profile.id)
    setName(profile.name)
    setOrigin("")
    setPolicy({})
  }
  async function refresh() {
    const response = await sdk.client.browser.profiles(await route(), { throwOnError: true })
    if (!response.data) return
    setCatalog(response.data)
    const profile =
      response.data.profiles.find((p) => p.id === identity()) ??
      response.data.profiles.find((p) => p.id === browser.page()?.profileId) ??
      response.data.profiles.find((p) => p.id === response.data!.defaultProfileId) ??
      response.data.profiles[0]
    if (profile) choose(profile)
    else {
      setIdentity(undefined)
      setName("")
    }
  }
  async function manage(input: Parameters<typeof sdk.client.browser.manageProfile>[0]["browserManageProfile"]) {
    const id = identity()
    if (!id) return
    const response = await sdk.client.browser.manageProfile(
      { ...(await route()), profileId: id, browserManageProfile: input },
      { throwOnError: true },
    )
    if (response.data) setCatalog(response.data)
    if (!selected()) await refresh()
  }
  function confirmChange(action: "clear" | "remove") {
    confirm.show({
      title: action === "clear" ? M.clear : M.remove,
      description: M.confirm,
      confirmLabel: action === "clear" ? M.clear : M.remove,
      tone: "danger",
      onConfirm: () => manage({ action }),
    })
  }
  function openCopy() {
    const id = identity()
    if (!id) return
    browser.openPage(browser.page()?.url ?? "about:blank", id)
    dialog.close()
  }
  onMount(() => void run(refresh))
  return (
    <Dialog title={_(B.settings)} size="form" dismissible={!busy()}>
      <div data-slot="dialog-form" class="text-13 text-text-base">
        <Show when={props.ownerKey && browser.pageId() && platform.browserNative?.dataAction}>
          <BrowserDataSettings
            ownerKey={props.ownerKey!}
            pageId={browser.pageId()!}
            url={browser.page()?.url ?? ""}
            onNavigate={browser.navigate}
          />
        </Show>
        <details class="border-t border-border-weak-base pt-4">
          <summary class="cursor-pointer text-14-medium text-text-strong">{_(M.advanced)}</summary>
          <section class="flex flex-col gap-3" aria-label={_(M.login)}>
            <div>
              <h3 class="text-14-medium text-text-strong">{_(M.login)}</h3>
              <p class="mt-1 text-12 text-text-weak">{_(M.explanation)}</p>
            </div>
            <div class="flex flex-wrap items-center justify-between gap-2">
              <MenuField
                value={identity() ?? ""}
                ariaLabel={_(M.profiles)}
                disabled={busy() || !catalog().profiles.length}
                options={catalog().profiles.map((p) => ({
                  value: p.id,
                  label: `${p.name}${!p.enabled ? ` · ${_(M.disabled)}` : catalog().defaultProfileId === p.id ? ` · ${_(M.currentDefault)}` : ""}`,
                }))}
                onChange={(id) => {
                  const profile = catalog().profiles.find((p) => p.id === id)
                  if (profile) choose(profile)
                }}
              />
              <Button variant="ghost" size="small" disabled={busy()} onClick={() => setCreating(!creating())}>
                {_(M.create)}
              </Button>
            </div>
            <Show when={creating()}>
              <form
                class="flex flex-col gap-2"
                onSubmit={(event) => {
                  event.preventDefault()
                  void run(async () => {
                    const response = await sdk.client.browser.createProfile(
                      { ...(await route()), browserProfileCreate: { name: newName() } },
                      { throwOnError: true },
                    )
                    await refresh()
                    if (response.data) choose(response.data)
                    setNewName("")
                    setCreating(false)
                  })
                }}
              >
                <TextField label={_(M.name)} value={newName()} onChange={setNewName} maxLength={80} autofocus />
                <Button type="submit" disabled={busy() || !newName().trim()}>
                  {_(M.create)}
                </Button>
              </form>
            </Show>
            <Show when={selected()}>
              <div class="flex flex-wrap gap-2">
                <Button size="small" disabled={busy() || !selected()?.enabled} onClick={openCopy}>
                  {_(M.openAs)}
                </Button>
                <Button
                  size="small"
                  variant="ghost"
                  disabled={busy() || !selected()?.enabled || catalog().defaultProfileId === identity()}
                  onClick={() => void run(() => manage({ action: "default" }))}
                >
                  {_(M.default)}
                </Button>
              </div>
              <details class="rounded-md border border-border-weak-base px-3 py-2">
                <summary class="cursor-pointer text-12 text-text-weak">{_(M.manage)}</summary>
                <div class="mt-3 flex flex-col gap-3">
                  <TextField label={_(M.name)} value={name()} onChange={setName} maxLength={80} />
                  <div class="flex flex-wrap gap-2">
                    <Button
                      size="small"
                      disabled={busy() || !name().trim() || name() === selected()?.name}
                      onClick={() => void run(() => manage({ action: "update", changes: { name: name() } }))}
                    >
                      {_(M.save)}
                    </Button>
                    <Button
                      size="small"
                      variant="ghost"
                      disabled={busy()}
                      onClick={() =>
                        void run(() => manage({ action: "update", changes: { enabled: !selected()!.enabled } }))
                      }
                    >
                      {selected()?.enabled ? _(M.disable) : _(M.enable)}
                    </Button>
                    <Button size="small" variant="ghost" disabled={busy()} onClick={() => confirmChange("clear")}>
                      {_(M.clear)}
                    </Button>
                    <Button size="small" variant="ghost" disabled={busy()} onClick={() => confirmChange("remove")}>
                      {_(M.remove)}
                    </Button>
                  </div>
                </div>
              </details>
            </Show>
          </section>
          <section class="border-t border-border-weak-base pt-4">
            <div class="flex flex-wrap items-center justify-between gap-3">
              <p class="max-w-80 text-12 text-text-weak">{_(M.temporaryHint)}</p>
              <Button
                size="small"
                variant="secondary"
                disabled={busy()}
                onClick={() =>
                  void run(async () => {
                    const response = await sdk.client.browser.createProfile(
                      { ...(await route()), browserProfileCreate: { name: "Temporary", kind: "temporary" } },
                      { throwOnError: true },
                    )
                    if (response.data) {
                      browser.openPage("about:blank", response.data.id)
                      dialog.close()
                    }
                  })
                }
              >
                {_(M.temporary)}
              </Button>
            </div>
          </section>
        </details>
        <Show when={selected()}>
          <details class="border-t border-border-weak-base pt-4">
            <summary class="cursor-pointer text-14-medium text-text-strong">{_(M.permissions)}</summary>
            <div class="mt-3 flex flex-col gap-3">
              <p class="text-12 text-text-weak">{_(M.policyNote)}</p>
              <TextField
                label={_(M.origin)}
                type="url"
                placeholder={_(M.originPlaceholder)}
                value={origin()}
                onChange={(value) => {
                  setOrigin(value)
                  setPolicy({})
                }}
              />
              <For
                each={
                  [
                    { value: "access", label: _(M.access) },
                    { value: "uploads", label: _(M.uploads) },
                    { value: "downloads", label: _(M.downloads) },
                  ] as const
                }
              >
                {(operation) => (
                  <div class="flex flex-wrap items-center justify-between gap-2">
                    <span>{operation.label}</span>
                    <MenuField
                      value={policy()[operation.value] ?? "inherit"}
                      ariaLabel={operation.label}
                      disabled={busy()}
                      options={[
                        { value: "inherit", label: _(M.inherit) },
                        { value: "allow", label: _(M.allow) },
                        { value: "ask", label: _(M.ask) },
                        { value: "deny", label: _(M.deny) },
                      ]}
                      onChange={(value) => setPolicy({ ...policy(), [operation.value]: value })}
                    />
                  </div>
                )}
              </For>
              <div>
                <Button
                  size="small"
                  disabled={busy() || !origin().trim()}
                  onClick={() => void run(() => manage({ action: "policy", origin: origin(), policy: policy() }))}
                >
                  {_(M.save)}
                </Button>
              </div>
              <For each={Object.entries(selected()?.origins ?? {})}>
                {([site, rules]) => (
                  <div class="flex flex-wrap items-center justify-between gap-2 border-t border-border-weak-base pt-2">
                    <button
                      type="button"
                      class="min-w-0 truncate text-text-base underline"
                      onClick={() => {
                        setOrigin(site)
                        setPolicy(rules)
                      }}
                    >
                      {site}
                    </button>
                    <Button
                      size="small"
                      variant="ghost"
                      disabled={busy()}
                      onClick={() => void run(() => manage({ action: "policy", origin: site, policy: null }))}
                    >
                      {_(M.revoke)}
                    </Button>
                  </div>
                )}
              </For>
            </div>
          </details>
        </Show>
        <Show when={error()}>
          <p role="alert" class="text-12 text-text-on-critical-base">
            {error()}{" "}
            <Button size="small" onClick={() => void run(refresh)}>
              {_(M.retry)}
            </Button>
          </p>
        </Show>
      </div>
    </Dialog>
  )
}
