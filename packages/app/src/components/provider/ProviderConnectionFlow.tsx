import type {
  AccountUsageSnapshot,
  ProviderAuthAuthorization,
  ProviderAuthMethod,
} from "@ericsanchezok/synergy-sdk/client"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { ProviderIcon } from "@ericsanchezok/synergy-ui/provider-icon"
import { Spinner } from "@ericsanchezok/synergy-ui/spinner"
import { TextField } from "@ericsanchezok/synergy-ui/text-field"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { showToast } from "@ericsanchezok/synergy-ui/toast"
import { iife } from "@ericsanchezok/synergy-util/iife"
import { createMemo, For, Match, onMount, Show, Switch } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { Link } from "@/components/link"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { usePlatform } from "@/context/platform"
import { popularProviders } from "@/hooks/use-providers"

export function providerConnectCopy(providerID: string) {
  if (providerID === "anthropic") return "Connect with Claude Pro/Max or API key"
  if (providerID === "openai-codex") return "Connect with ChatGPT/Codex"
  if (providerID === "github-copilot") return "Connect with GitHub Copilot"
  if (providerID === "openrouter") return "Connect OpenRouter credits or API key"
  return "Connect provider"
}

export function sortProviderIDs(a: string, b: string) {
  const aIndex = popularProviders.indexOf(a)
  const bIndex = popularProviders.indexOf(b)
  if (aIndex !== -1 || bIndex !== -1) {
    if (aIndex === -1) return 1
    if (bIndex === -1) return -1
    return aIndex - bIndex
  }
  return a.localeCompare(b)
}

export function ProviderConnectionFlow(props: {
  providerID: string
  compact?: boolean
  onBack?: () => void
  onComplete?: () => void | Promise<void>
}) {
  const globalSync = useGlobalSync()
  const globalSDK = useGlobalSDK()
  const platform = usePlatform()
  const provider = createMemo(() => globalSync.data.provider.all.find((x) => x.id === props.providerID))
  const methods = createMemo<ProviderAuthMethod[]>(
    () =>
      globalSync.data.provider_auth[props.providerID] ?? [
        {
          type: "api",
          label: "API key",
        },
      ],
  )
  const connected = createMemo(() => globalSync.data.provider.connected.includes(props.providerID))
  const [store, setStore] = createStore({
    methodIndex: undefined as undefined | number,
    authorization: undefined as undefined | ProviderAuthAuthorization,
    usage: undefined as undefined | AccountUsageSnapshot,
    usageState: "idle" as "idle" | "pending" | "complete" | "error",
    state: "pending" as undefined | "pending" | "complete" | "error",
    error: undefined as string | undefined,
  })

  const method = createMemo(() => (store.methodIndex !== undefined ? methods().at(store.methodIndex) : undefined))

  async function loadUsage() {
    if (!connected()) return
    setStore("usageState", "pending")
    await globalSDK.client.provider.usage
      .get({ providerID: props.providerID }, { throwOnError: true })
      .then((x) => {
        setStore("usage", x.data)
        setStore("usageState", "complete")
      })
      .catch(() => {
        setStore("usageState", "error")
      })
  }

  async function selectMethod(index: number) {
    const selected = methods()[index]
    setStore(
      produce((draft) => {
        draft.methodIndex = index
        draft.authorization = undefined
        draft.state = undefined
        draft.error = undefined
      }),
    )

    if (selected.type === "oauth") {
      setStore("state", "pending")
      await globalSDK.client.provider.oauth
        .authorize(
          {
            providerID: props.providerID,
            method: index,
          },
          { throwOnError: true },
        )
        .then((x) => {
          setStore("state", "complete")
          setStore("authorization", x.data!)
        })
        .catch((e) => {
          setStore("state", "error")
          setStore("error", String(e))
        })
    }

    if (selected.type === "import") {
      setStore("state", "pending")
      await globalSDK.client.provider.credentials
        .importCredentials(
          {
            providerID: props.providerID,
            method: index,
          },
          { throwOnError: true },
        )
        .then(() => complete())
        .catch((e) => {
          setStore("state", "error")
          setStore("error", String(e))
        })
    }
  }

  onMount(() => {
    if (methods().length === 1) void selectMethod(0)
    void loadUsage()
  })

  async function complete() {
    await globalSDK.client.global.dispose()
    await globalSync.refreshAllConfigs()
    await loadUsage()
    await props.onComplete?.()
    showToast({
      type: "success",
      icon: "circle-check",
      title: `${provider()?.name ?? props.providerID} connected`,
      description: `${provider()?.name ?? props.providerID} models are now available to use.`,
    })
  }

  function resetMethod() {
    setStore(
      produce((draft) => {
        draft.methodIndex = undefined
        draft.authorization = undefined
        draft.state = undefined
        draft.error = undefined
      }),
    )
  }

  return (
    <div classList={{ "provider-flow": true, "provider-flow-compact": !!props.compact }}>
      <div class="provider-flow-header">
        <Show when={props.onBack}>
          <button type="button" class="provider-flow-back" onClick={props.onBack} aria-label="Back to providers">
            <Icon name={getSemanticIcon("navigation.back")} size="small" />
          </button>
        </Show>
        <ProviderIcon id={props.providerID} class="size-5 shrink-0 icon-strong-base" />
        <div class="min-w-0">
          <div class="provider-flow-title">{providerConnectCopy(props.providerID)}</div>
          <div class="provider-flow-subtitle">{provider()?.name ?? props.providerID}</div>
        </div>
      </div>

      <Show when={connected()}>
        <UsageSummary usage={store.usage} state={store.usageState} />
      </Show>

      <div class="provider-flow-body">
        <Switch>
          <Match when={store.methodIndex === undefined}>
            <div class="provider-method-list">
              <For each={methods()}>
                {(item, index) => (
                  <button type="button" class="provider-method-row" onClick={() => void selectMethod(index())}>
                    <span class="provider-method-indicator" />
                    <span>{item.label}</span>
                    <Icon name={getSemanticIcon("navigation.expand")} size="small" class="text-text-weaker" />
                  </button>
                )}
              </For>
            </div>
          </Match>
          <Match when={store.state === "pending"}>
            <div class="provider-flow-message">
              <Spinner />
              <span>Authorization in progress...</span>
            </div>
          </Match>
          <Match when={store.state === "error"}>
            <div class="provider-flow-message provider-flow-message-error">
              <Icon name={getSemanticIcon("state.error")} class="text-icon-critical-base" />
              <span>Authorization failed: {store.error}</span>
              <Button type="button" variant="ghost" size="small" onClick={resetMethod}>
                Try another method
              </Button>
            </div>
          </Match>
          <Match when={method()?.type === "api"}>
            {iife(() => {
              const [formStore, setFormStore] = createStore({
                value: "",
                error: undefined as string | undefined,
              })

              async function handleSubmit(e: SubmitEvent) {
                e.preventDefault()
                const form = e.currentTarget as HTMLFormElement
                const apiKey = formDataValue(new FormData(form), "apiKey")

                if (!apiKey?.trim()) {
                  setFormStore("error", "API key is required")
                  return
                }

                setFormStore("error", undefined)
                await globalSDK.client.auth.set({
                  providerID: props.providerID,
                  auth: {
                    type: "api",
                    key: apiKey,
                  },
                })
                await complete()
              }

              return (
                <form onSubmit={handleSubmit} class="provider-api-form">
                  <TextField
                    autofocus
                    type="password"
                    label={`${provider()?.name ?? props.providerID} API key`}
                    placeholder="API key"
                    name="apiKey"
                    value={formStore.value}
                    onChange={setFormStore.bind(null, "value")}
                    validationState={formStore.error ? "invalid" : undefined}
                    error={formStore.error}
                  />
                  <div class="provider-form-actions">
                    <Button type="button" variant="ghost" size="large" onClick={resetMethod}>
                      Back
                    </Button>
                    <Button class="w-auto" type="submit" size="large" variant="primary">
                      Save key
                    </Button>
                  </div>
                </form>
              )
            })}
          </Match>
          <Match when={method()?.type === "oauth"}>
            <Switch>
              <Match when={store.authorization?.method === "code"}>
                {iife(() => {
                  const [formStore, setFormStore] = createStore({
                    value: "",
                    error: undefined as string | undefined,
                  })

                  onMount(() => {
                    if (store.authorization?.url) platform.openLink(store.authorization.url)
                  })

                  async function handleSubmit(e: SubmitEvent) {
                    e.preventDefault()
                    const code = formDataValue(new FormData(e.currentTarget as HTMLFormElement), "code")

                    if (!code?.trim()) {
                      setFormStore("error", "Authorization code is required")
                      return
                    }

                    setFormStore("error", undefined)
                    const { error } = await globalSDK.client.provider.oauth.callback({
                      providerID: props.providerID,
                      method: store.methodIndex,
                      code,
                    })
                    if (!error) {
                      await complete()
                      return
                    }
                    setFormStore("error", "Invalid authorization code")
                  }

                  return (
                    <form onSubmit={handleSubmit} class="provider-api-form">
                      <div class="provider-flow-copy">
                        Visit <Link href={store.authorization!.url}>this link</Link> to collect your authorization code.
                      </div>
                      <TextField
                        autofocus
                        type="text"
                        label={`${method()?.label} authorization code`}
                        placeholder="Authorization code"
                        name="code"
                        value={formStore.value}
                        onChange={setFormStore.bind(null, "value")}
                        validationState={formStore.error ? "invalid" : undefined}
                        error={formStore.error}
                      />
                      <div class="provider-form-actions">
                        <Button type="button" variant="ghost" size="large" onClick={resetMethod}>
                          Back
                        </Button>
                        <Button class="w-auto" type="submit" size="large" variant="primary">
                          Submit
                        </Button>
                      </div>
                    </form>
                  )
                })}
              </Match>
              <Match when={store.authorization?.method === "auto"}>
                {iife(() => {
                  const code = createMemo(() => {
                    const instructions = store.authorization?.instructions
                    if (instructions?.includes(":")) return instructions.split(":")[1]?.trim()
                    return instructions
                  })

                  onMount(async () => {
                    const result = await globalSDK.client.provider.oauth.callback({
                      providerID: props.providerID,
                      method: store.methodIndex,
                    })
                    if (result.error) {
                      setStore("state", "error")
                      setStore("error", "Authorization did not complete.")
                      return
                    }
                    await complete()
                  })

                  return (
                    <div class="provider-device-flow">
                      <div class="provider-flow-copy">
                        Visit <Link href={store.authorization!.url}>this link</Link> and enter the code below.
                      </div>
                      <TextField label="Confirmation code" class="font-mono" value={code()} readOnly copyable />
                      <div class="provider-flow-message">
                        <Spinner />
                        <span>Waiting for authorization...</span>
                      </div>
                    </div>
                  )
                })}
              </Match>
            </Switch>
          </Match>
        </Switch>
      </div>
    </div>
  )
}

function UsageSummary(props: { usage?: AccountUsageSnapshot; state: "idle" | "pending" | "complete" | "error" }) {
  return (
    <div class="provider-flow-usage">
      <Switch>
        <Match when={props.state === "pending" || props.state === "idle"}>
          <div class="provider-flow-message">
            <Spinner />
            <span>Loading usage...</span>
          </div>
        </Match>
        <Match when={props.state === "error"}>
          <div class="text-13-regular text-text-weak">Usage is unavailable right now.</div>
        </Match>
        <Match when={props.usage}>
          {(usage) => (
            <>
              <div class="provider-usage-head">
                <span class="ds-inline-badge" classList={{ "ds-inline-badge-muted": usage().status !== "available" }}>
                  {usage().status === "available" ? "Connected" : usage().status}
                </span>
                <Show when={usage().plan}>
                  <span>{usage().plan}</span>
                </Show>
              </div>
              <Show when={usage().unavailableReason}>
                <div class="provider-flow-copy">{usage().unavailableReason}</div>
              </Show>
              <For each={usage().windows}>
                {(window) => (
                  <div class="provider-usage-window">
                    <span>{window.label}</span>
                    <span>
                      {formatUsageWindow(window.remainingPercent, window.usedPercent)}
                      {window.resetAt ? ` resets ${new Date(window.resetAt).toLocaleString()}` : ""}
                    </span>
                  </div>
                )}
              </For>
              <Show when={usage().credits}>
                {(credits) => (
                  <div class="provider-usage-window">
                    <span>Credits</span>
                    <span>
                      {credits().unlimited
                        ? "unlimited"
                        : credits().balance !== undefined
                          ? `${credits().balance}${credits().currency ? ` ${credits().currency}` : ""}`
                          : credits().hasCredits === false
                            ? "none"
                            : "available"}
                    </span>
                  </div>
                )}
              </Show>
            </>
          )}
        </Match>
      </Switch>
    </div>
  )
}

function formatUsageWindow(remaining?: number, used?: number) {
  const value = remaining ?? used
  if (value === undefined) return "n/a"
  return `${Math.round(value)}%`
}

function formDataValue(form: FormData, key: string) {
  const value = form.get(key)
  return typeof value === "string" ? value : ""
}
