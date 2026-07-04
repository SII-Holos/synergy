import type { ProviderAuthAuthorization, ProviderAuthMethod } from "@ericsanchezok/synergy-sdk/client"
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
import { providerConnectCopy, providerConnectReason, providerCTA } from "./provider-recommendation"

export { compareProviderIDs, providerConnectCopy } from "./provider-recommendation"

export function ProviderConnectionFlow(props: {
  providerID: string
  providerName?: string
  connectedOverride?: boolean
  completeDescription?: string
  iconID?: string
  compact?: boolean
  skipAutoAdvance?: boolean
  onBack?: () => void
  onComplete?: () => void | Promise<void>
}) {
  const globalSync = useGlobalSync()
  const globalSDK = useGlobalSDK()
  const platform = usePlatform()
  const provider = createMemo(() => globalSync.data.provider.all.find((x) => x.id === props.providerID))
  const providerName = createMemo(() => props.providerName ?? provider()?.name ?? props.providerID)
  const profiles = createMemo(() => globalSync.data.provider.profiles)
  const methods = createMemo<ProviderAuthMethod[]>(
    () =>
      globalSync.data.provider_auth[props.providerID] ?? [
        {
          type: "api",
          label: "API key",
        },
      ],
  )
  const connected = createMemo(
    () => props.connectedOverride ?? globalSync.data.provider.connected.includes(props.providerID),
  )
  const [store, setStore] = createStore({
    methodIndex: undefined as undefined | number,
    authorization: undefined as undefined | ProviderAuthAuthorization,
    state: "pending" as undefined | "pending" | "complete" | "error",
    error: undefined as string | undefined,
  })

  const method = createMemo(() => (store.methodIndex !== undefined ? methods().at(store.methodIndex) : undefined))

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
        .catch((e: any) => {
          setStore("state", "error")
          setStore("error", typeof e?.data?.message === "string" ? e.data.message : String(e))
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
    if (!connected() && methods().length === 1 && !props.skipAutoAdvance) void selectMethod(0)
  })

  async function complete() {
    await globalSDK.client.global.dispose()
    await globalSync.refreshAllConfigs()
    await props.onComplete?.()
    showToast({
      type: "success",
      icon: "circle-check",
      title: `${providerName()} connected`,
      description: props.completeDescription ?? `${providerName()} models are now available to use.`,
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

  function methodDescription(item: ProviderAuthMethod) {
    if (item.type === "api") return "Paste a provider API key."
    if (item.type === "oauth") return "Authorize in the browser and return here."
    if (item.type === "import") return "Use credentials already available on this device."
    return "Connect this provider."
  }

  function methodIcon(item: ProviderAuthMethod) {
    if (item.type === "api" || item.type === "import") return getSemanticIcon("account.import")
    if (item.type === "oauth") return getSemanticIcon("action.open")
    return getSemanticIcon("settings.providers")
  }

  return (
    <div classList={{ "provider-flow": true, "provider-flow-compact": !!props.compact }}>
      <div class="provider-flow-header">
        <Show when={props.onBack}>
          <button type="button" class="provider-flow-back" onClick={props.onBack} aria-label="Back to providers">
            <Icon name={getSemanticIcon("navigation.back")} size="small" />
          </button>
        </Show>
        <ProviderIcon id={props.iconID ?? props.providerID} class="size-5 shrink-0 icon-strong-base" />
        <div class="min-w-0">
          <div class="provider-flow-title">{providerConnectCopy(props.providerID, profiles(), provider()?.name)}</div>
          <div class="provider-flow-subtitle">
            {providerConnectReason(props.providerID, profiles()) ?? provider()?.name ?? props.providerID}
          </div>
        </div>
      </div>

      <div class="provider-flow-body">
        <Switch>
          <Match when={store.methodIndex === undefined}>
            <div class="provider-method-list">
              <div class="provider-flow-intro">
                <div class="provider-flow-eyebrow">{connected() ? "Credential refresh" : "Connection method"}</div>
                <div class="provider-flow-heading">{connected() ? "Refresh credentials" : "Choose how to connect"}</div>
              </div>
              <For each={methods()}>
                {(item, index) => (
                  <button type="button" class="provider-method-row" onClick={() => void selectMethod(index())}>
                    <span class="provider-method-icon">
                      <Icon name={methodIcon(item)} size="small" />
                    </span>
                    <span class="provider-method-copy">
                      <span class="provider-method-title">{item.label}</span>
                      <span class="provider-method-description">{methodDescription(item)}</span>
                    </span>
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
                  <div class="provider-step-header">
                    <div class="provider-flow-eyebrow">API key</div>
                    <div class="provider-flow-heading">Add a {providerName()} key</div>
                    <p>Use a key from your provider account to make this provider available in Synergy.</p>
                  </div>
                  <Show when={providerCTA(props.providerID, profiles())}>
                    {(cta) => (
                      <Link href={cta().url} class="provider-auth-link">
                        <span>{cta().label}</span>
                        <Icon name={getSemanticIcon("action.open")} size="small" />
                      </Link>
                    )}
                  </Show>
                  <TextField
                    autofocus
                    type="password"
                    label={`${providerName()} API key`}
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
                      <div class="provider-step-header">
                        <div class="provider-flow-eyebrow">Step 1</div>
                        <div class="provider-flow-heading">Authorize in your browser</div>
                        <p>We opened the authorization page automatically. Use the button if it did not appear.</p>
                      </div>
                      <Link href={store.authorization!.url} class="provider-auth-link">
                        <span>Open authorization page</span>
                        <Icon name={getSemanticIcon("action.open")} size="small" />
                      </Link>
                      <div class="provider-step-header provider-step-header-compact">
                        <div class="provider-flow-eyebrow">Step 2</div>
                        <div class="provider-flow-heading">Paste the authorization code</div>
                      </div>
                      <TextField
                        autofocus
                        type="text"
                        label="Authorization code"
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
                    if (store.authorization?.url) platform.openLink(store.authorization.url)
                    const result = await globalSDK.client.provider.oauth.callback({
                      providerID: props.providerID,
                      method: store.methodIndex,
                    })
                    if (result.error) {
                      setStore("state", "error")
                      setStore(
                        "error",
                        "Authorization timed out. Open the authorization page and enter the confirmation code, then try again.",
                      )
                      return
                    }
                    await complete()
                    resetMethod()
                  })

                  return (
                    <div class="provider-device-flow">
                      <div class="provider-step-header">
                        <div class="provider-flow-eyebrow">Authorize</div>
                        <div class="provider-flow-heading">Finish in your browser</div>
                        <p>Open the authorization page and enter this confirmation code when prompted.</p>
                      </div>
                      <Link href={store.authorization!.url} class="provider-auth-link">
                        <span>Open authorization page</span>
                        <Icon name={getSemanticIcon("action.open")} size="small" />
                      </Link>
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

function formDataValue(form: FormData, key: string) {
  const value = form.get(key)
  return typeof value === "string" ? value : ""
}
