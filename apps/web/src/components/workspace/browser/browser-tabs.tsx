import { For, Show, createSignal, onMount } from "solid-js"
import { useLingui } from "@lingui/solid"
import { Button } from "@ericsanchezok/synergy-ui/button"
import type { BrowserOriginPolicy, BrowserProfile, BrowserProfileListSchema } from "@ericsanchezok/synergy-browser-core"
import type { z } from "zod"
import { useSDK } from "@/context/sdk"
import { useBrowser } from "./browser-store"
import { normalizeBrowserError } from "./browser-error"

const M = {
  pages: { id: "browser.tabs.pages", message: "Browser pages" },
  newPage: { id: "browser.tabs.new", message: "New page" },
  close: { id: "browser.tabs.close", message: "Close page" },
  identities: { id: "browser.identities.manage", message: "Identities" },
  openAs: { id: "browser.identities.openAs", message: "Open a copy as" },
  temporary: { id: "browser.identities.temporary", message: "Temporary identity" },
  name: { id: "browser.identities.name", message: "Identity name" },
  create: { id: "browser.identities.create", message: "Create identity" },
  save: { id: "browser.identities.save", message: "Save" },
  enable: { id: "browser.identities.enable", message: "Enable" },
  disable: { id: "browser.identities.disable", message: "Disable" },
  default: { id: "browser.identities.default", message: "Use by default" },
  currentDefault: { id: "browser.identities.currentDefault", message: "Default" },
  clear: { id: "browser.identities.clear", message: "Clear website data" },
  remove: { id: "browser.identities.remove", message: "Delete identity" },
  confirm: {
    id: "browser.identities.confirm",
    message: "This closes this identity's pages and signs out of its websites. Continue?",
  },
  continue: { id: "browser.identities.continue", message: "Continue" },
  cancel: { id: "browser.identities.cancel", message: "Cancel" },
  origin: { id: "browser.identities.origin", message: "Website origin" },
  access: { id: "browser.identities.access", message: "Access" },
  uploads: { id: "browser.identities.uploads", message: "Uploads" },
  downloads: { id: "browser.identities.downloads", message: "Downloads" },
  inherit: { id: "browser.identities.inherit", message: "Use task permissions" },
  allow: { id: "browser.identities.allow", message: "Allow" },
  ask: { id: "browser.identities.ask", message: "Ask" },
  deny: { id: "browser.identities.deny", message: "Deny" },
  revoke: { id: "browser.identities.revoke", message: "Reset website permissions" },
  explanation: {
    id: "browser.identities.explanation",
    message:
      "Identities share logins across tasks. Changing identity opens a new page. Temporary identities are discarded after their last page closes.",
  },
  policyNote: {
    id: "browser.identities.policyNote",
    message:
      "These rules apply to agents. Task permissions still apply; Full Access bypasses approval rules. Disabled identities stay unavailable.",
  },
  retry: { id: "browser.identities.retry", message: "Retry" },
}
type IdentityList = z.infer<typeof BrowserProfileListSchema>
export function BrowserTabs(props: { sessionID: string; routeDirectory?: string; createTicket(): Promise<string> }) {
  const browser = useBrowser(),
    sdk = useSDK(),
    { _ } = useLingui()
  const [catalog, setCatalog] = createSignal<IdentityList>({ defaultProfileId: null, profiles: [] })
  const [manager, setManager] = createSignal(false)
  const [identity, setIdentity] = createSignal<string>()
  const [name, setName] = createSignal("")
  const [origin, setOrigin] = createSignal("")
  const [policy, setPolicy] = createSignal<BrowserOriginPolicy>({})
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal("")
  const [confirmation, setConfirmation] = createSignal<"clear" | "remove">()
  const selected = () => catalog().profiles.find((profile) => profile.id === identity())
  const profileName = (id: string) => catalog().profiles.find((profile) => profile.id === id)?.name ?? _(M.temporary)
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
      setError(normalizeBrowserError(failure, "Identity operation failed").message)
    } finally {
      setBusy(false)
    }
  }
  async function refresh() {
    const response = await sdk.client.browser.profiles(await route(), { throwOnError: true })
    if (response.data) setCatalog(response.data)
  }
  function choose(profile: BrowserProfile) {
    setIdentity(profile.id)
    setName(profile.name)
    setConfirmation(undefined)
  }
  async function manage(input: Parameters<typeof sdk.client.browser.manageProfile>[0]["browserManageProfile"]) {
    const id = identity()
    if (!id) return
    const response = await sdk.client.browser.manageProfile(
      { ...(await route()), profileId: id, browserManageProfile: input },
      { throwOnError: true },
    )
    if (response.data) setCatalog(response.data)
    setConfirmation(undefined)
  }
  function onTabKey(event: KeyboardEvent) {
    const ids = browser.session.pages.map((page) => page.id),
      index = ids.indexOf(browser.pageId() ?? "")
    const next =
      event.key === "ArrowRight"
        ? ids[(index + 1) % ids.length]
        : event.key === "ArrowLeft"
          ? ids[(index - 1 + ids.length) % ids.length]
          : event.key === "Home"
            ? ids[0]
            : event.key === "End"
              ? ids.at(-1)
              : undefined
    if (!next) return
    event.preventDefault()
    browser.selectPage(next)
    const target = event.currentTarget as HTMLElement
    target.querySelector<HTMLButtonElement>(`[data-page-id="${CSS.escape(next)}"]`)?.focus()
  }
  onMount(() => void run(refresh))
  return (
    <>
      <div class="flex shrink-0 items-center gap-1 border-b border-border-weak-base px-2 py-1">
        <div
          role="tablist"
          aria-label={_(M.pages)}
          class="flex min-w-0 flex-1 gap-1 overflow-x-auto"
          onKeyDown={onTabKey}
        >
          <For each={browser.session.pages}>
            {(page) => (
              <div
                class="flex min-w-0 shrink-0 items-center rounded-md border border-border-weak-base"
                classList={{ "bg-surface-raised-base": browser.pageId() === page.id }}
              >
                <button
                  type="button"
                  role="tab"
                  data-page-id={page.id}
                  aria-selected={browser.pageId() === page.id}
                  tabIndex={browser.pageId() === page.id ? 0 : -1}
                  title={`${page.url}\n${profileName(page.profileId)}`}
                  class="max-w-44 truncate px-2 py-1 text-12 text-text-base"
                  onClick={() => browser.selectPage(page.id)}
                >
                  {page.isLoading ? "◌ " : ""}
                  {page.title || page.url || "about:blank"}
                  {browser.dialogs[page.id] || browser.fileChoosers[page.id] ? " •" : ""}
                </button>
                <button
                  type="button"
                  aria-label={_(M.close)}
                  class="px-1.5 py-1 text-text-weak hover:text-text-strong"
                  onClick={() => browser.send({ type: "close", pageId: page.id })}
                >
                  ×
                </button>
              </div>
            )}
          </For>
        </div>
        <Button size="small" variant="ghost" aria-label={_(M.newPage)} onClick={() => browser.openPage()}>
          +
        </Button>
        <Button
          size="small"
          variant="ghost"
          aria-expanded={manager()}
          onClick={() => {
            setManager(!manager())
            if (!manager()) return
            const profile = catalog().profiles.find((p) => p.id === browser.page()?.profileId) ?? catalog().profiles[0]
            if (profile) choose(profile)
            void run(refresh)
          }}
        >
          {_(M.identities)}
        </Button>
      </div>
      <Show when={manager()}>
        <section
          class="max-h-72 shrink-0 overflow-y-auto border-b border-border-weak-base p-3 text-12 text-text-base"
          aria-label={_(M.identities)}
        >
          <p class="mb-3 text-text-weak">{_(M.explanation)}</p>
          <div class="mb-3 flex flex-wrap items-center gap-2">
            <label>
              {_(M.openAs)}{" "}
              <select
                aria-label={_(M.openAs)}
                class="rounded border border-border-weak-base bg-surface-base px-2 py-1"
                value=""
                onChange={(event) => {
                  const id = event.currentTarget.value
                  if (id) browser.openPage(browser.page()?.url ?? "about:blank", id)
                  event.currentTarget.value = ""
                }}
              >
                <option value="">—</option>
                <For each={catalog().profiles.filter((p) => p.enabled)}>
                  {(p) => <option value={p.id}>{p.name}</option>}
                </For>
              </select>
            </label>
            <Button
              size="small"
              disabled={busy()}
              onClick={() =>
                void run(async () => {
                  const response = await sdk.client.browser.createProfile(
                    { ...(await route()), browserProfileCreate: { name: "Temporary", kind: "temporary" } },
                    { throwOnError: true },
                  )
                  if (response.data) browser.openPage("about:blank", response.data.id)
                })
              }
            >
              {_(M.temporary)}
            </Button>
          </div>
          <div class="mb-2 flex flex-wrap gap-1">
            <For each={catalog().profiles}>
              {(profile) => (
                <Button
                  size="small"
                  variant={identity() === profile.id ? "secondary" : "ghost"}
                  onClick={() => choose(profile)}
                >
                  {profile.name}
                  {catalog().defaultProfileId === profile.id ? ` · ${_(M.currentDefault)}` : ""}
                  {!profile.enabled ? " ⏸" : ""}
                </Button>
              )}
            </For>
          </div>
          <form
            class="flex flex-wrap items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              void run(async () => {
                const response = await sdk.client.browser.createProfile(
                  { ...(await route()), browserProfileCreate: { name: name() } },
                  { throwOnError: true },
                )
                await refresh()
                if (response.data) choose(response.data)
              })
            }}
          >
            <input
              aria-label={_(M.name)}
              placeholder={_(M.name)}
              value={name()}
              onInput={(e) => setName(e.currentTarget.value)}
              class="min-w-0 rounded border border-border-weak-base bg-surface-base px-2 py-1"
              maxLength={80}
            />
            <Button type="submit" size="small" disabled={busy() || !name().trim()}>
              {_(M.create)}
            </Button>
            <Show when={selected()}>
              <Button
                size="small"
                disabled={busy() || !name().trim()}
                onClick={() => void run(() => manage({ action: "update", changes: { name: name() } }))}
              >
                {_(M.save)}
              </Button>
              <Button
                size="small"
                disabled={busy()}
                onClick={() => void run(() => manage({ action: "update", changes: { enabled: !selected()!.enabled } }))}
              >
                {selected()?.enabled ? _(M.disable) : _(M.enable)}
              </Button>
              <Button
                size="small"
                disabled={busy() || !selected()?.enabled || catalog().defaultProfileId === identity()}
                onClick={() => void run(() => manage({ action: "default" }))}
              >
                {_(M.default)}
              </Button>
            </Show>
          </form>
          <Show when={selected()}>
            <div class="mt-3 flex flex-wrap gap-2">
              <Button size="small" disabled={busy()} onClick={() => setConfirmation("clear")}>
                {_(M.clear)}
              </Button>
              <Button size="small" disabled={busy()} onClick={() => setConfirmation("remove")}>
                {_(M.remove)}
              </Button>
            </div>
            <Show when={confirmation()}>
              <div role="alert" class="mt-2 rounded border border-border-warning-base p-2">
                <p>{_(M.confirm)}</p>
                <Button
                  size="small"
                  disabled={busy()}
                  onClick={() => void run(() => manage({ action: confirmation()! }))}
                >
                  {_(M.continue)}
                </Button>
                <Button size="small" onClick={() => setConfirmation(undefined)}>
                  {_(M.cancel)}
                </Button>
              </div>
            </Show>
            <p class="mt-3 text-text-weak">{_(M.policyNote)}</p>
            <div class="mt-2 flex flex-wrap items-end gap-2">
              <label>
                {_(M.origin)}
                <input
                  type="url"
                  placeholder="https://example.com"
                  value={origin()}
                  onInput={(e) => {
                    setOrigin(e.currentTarget.value)
                    setPolicy({})
                  }}
                  class="block rounded border border-border-weak-base bg-surface-base px-2 py-1"
                />
              </label>
              <For each={["access", "uploads", "downloads"] as const}>
                {(operation) => (
                  <label>
                    {_(M[operation])}
                    <select
                      class="block rounded border border-border-weak-base bg-surface-base px-2 py-1"
                      value={policy()[operation] ?? "inherit"}
                      onChange={(e) => setPolicy({ ...policy(), [operation]: e.currentTarget.value })}
                    >
                      <For each={["inherit", "allow", "ask", "deny"] as const}>
                        {(value) => <option value={value}>{_(M[value])}</option>}
                      </For>
                    </select>
                  </label>
                )}
              </For>
              <Button
                size="small"
                disabled={busy() || !origin()}
                onClick={() => void run(() => manage({ action: "policy", origin: origin(), policy: policy() }))}
              >
                {_(M.save)}
              </Button>
            </div>
            <For each={Object.entries(selected()?.origins ?? {})}>
              {([site, rules]) => (
                <div class="mt-2 flex items-center gap-2">
                  <button
                    type="button"
                    class="truncate text-text-base underline"
                    onClick={() => {
                      setOrigin(site)
                      setPolicy(rules)
                    }}
                  >
                    {site}
                  </button>
                  <Button
                    size="small"
                    disabled={busy()}
                    onClick={() => void run(() => manage({ action: "policy", origin: site, policy: null }))}
                  >
                    {_(M.revoke)}
                  </Button>
                </div>
              )}
            </For>
          </Show>
          <Show when={error()}>
            <p role="alert" class="mt-2 text-text-danger-base">
              {error()}{" "}
              <Button size="small" onClick={() => void run(refresh)}>
                {_(M.retry)}
              </Button>
            </p>
          </Show>
        </section>
      </Show>
    </>
  )
}
