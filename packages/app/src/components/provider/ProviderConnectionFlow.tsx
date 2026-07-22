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
import { useLingui } from "@lingui/solid"
import { providerFlow } from "@/locales/messages"
import { Link } from "./external-link"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { usePlatform } from "@/context/platform"
import { providerConnectCopy, providerConnectReason, providerCTA } from "./provider-recommendation"

export { compareProviderIDs, providerConnectCopy } from "./provider-recommendation"

export function ProviderConnectionFlow(props: {
  providerID: string
  providerName?: string
  intent?: "connect" | "recover"
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
  const { _ } = useLingui()
  const provider = createMemo(() => globalSync.data.provider.all.find((x) => x.id === props.providerID))
  const providerName = createMemo(() => props.providerName ?? provider()?.name ?? props.providerID)
  const profiles = createMemo(() => globalSync.data.provider.profiles)
  const methods = createMemo<ProviderAuthMethod[]>(
    () =>
      globalSync.data.provider_auth[props.providerID] ?? [
        {
          type: "api",
          label: _(providerFlow.methodApiDefaultLabel),
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
    await globalSync.refreshProviders()
    await props.onComplete?.()
    const suffix = props.intent === "recover" ? _(providerFlow.reconnected) : _(providerFlow.connected)
    showToast({
      type: "success",
      icon: getSemanticIcon("state.complete"),
      title: `${providerName()} ${suffix}`,
      description: props.completeDescription ?? _(providerFlow.modelsAvailable.id, { provider: providerName() }),
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
    if (item.type === "api") return _(providerFlow.methodApiDesc)
    if (item.type === "oauth") return _(providerFlow.methodOauthDesc)
    if (item.type === "import") return _(providerFlow.methodImportDesc)
    return _(providerFlow.methodGenericDesc)
  }

  function methodIcon(item: ProviderAuthMethod) {
    if (item.type === "api" || item.type === "import") return getSemanticIcon("account.import")
    if (item.type === "oauth") return getSemanticIcon("action.open")
    return getSemanticIcon("providers.main")
  }

  return (
    <div classList={{ "provider-flow": true, "provider-flow-compact": !!props.compact }}>
      <div class="provider-flow-header">
        <Show when={props.onBack}>
          <button
            type="button"
            class="provider-flow-back"
            onClick={props.onBack}
            aria-label={_(providerFlow.backToProviders)}
          >
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
                <div class="provider-flow-eyebrow">
                  {props.intent === "recover" ? _(providerFlow.accountRecovery) : _(providerFlow.connectionMethod)}
                </div>
                <div class="provider-flow-heading">
                  {props.intent === "recover" ? _(providerFlow.reconnectOrReplace) : _(providerFlow.chooseHowToConnect)}
                </div>
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
              <span>
                {_(method()?.type === "import" ? providerFlow.importInProgress : providerFlow.authInProgress)}
              </span>
            </div>
          </Match>
          <Match when={store.state === "error"}>
            <div class="provider-flow-message provider-flow-message-error">
              <Icon name={getSemanticIcon("state.error")} class="text-icon-critical-base" />
              <span>{_(providerFlow.authFailed.id, { error: store.error })}</span>
              <Button type="button" variant="ghost" size="small" onClick={resetMethod}>
                {_(providerFlow.tryAnotherMethod)}
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
                  setFormStore("error", _(providerFlow.apiKeyRequired))
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
                    <div class="provider-flow-eyebrow">{_(providerFlow.apiKey)}</div>
                    <div class="provider-flow-heading">
                      {props.intent === "recover"
                        ? _(providerFlow.replaceKey.id, { provider: providerName() })
                        : _(providerFlow.addKey.id, { provider: providerName() })}
                    </div>
                    <p>{_(providerFlow.apiKeyDescription)}</p>
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
                    label={_(providerFlow.apiKeyLabel.id, { provider: providerName() })}
                    placeholder={_(providerFlow.apiKeyPlaceholder)}
                    name="apiKey"
                    value={formStore.value}
                    onChange={setFormStore.bind(null, "value")}
                    validationState={formStore.error ? "invalid" : undefined}
                    error={formStore.error}
                  />
                  <div class="provider-form-actions">
                    <Button type="button" variant="ghost" size="large" onClick={resetMethod}>
                      {_(providerFlow.back)}
                    </Button>
                    <Button class="w-auto" type="submit" size="large" variant="primary">
                      {_(providerFlow.saveKey)}
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
                      setFormStore("error", _(providerFlow.authCodeRequired))
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
                    setFormStore("error", _(providerFlow.invalidAuthCode))
                  }

                  return (
                    <form onSubmit={handleSubmit} class="provider-api-form">
                      <div class="provider-step-header">
                        <div class="provider-flow-eyebrow">{_(providerFlow.step1)}</div>
                        <div class="provider-flow-heading">{_(providerFlow.authorizeInBrowser)}</div>
                        <p>{_(providerFlow.autoOpened)}</p>
                      </div>
                      <Link href={store.authorization!.url} class="provider-auth-link">
                        <span>{_(providerFlow.openAuthPage)}</span>
                        <Icon name={getSemanticIcon("action.open")} size="small" />
                      </Link>
                      <div class="provider-step-header provider-step-header-compact">
                        <div class="provider-flow-eyebrow">{_(providerFlow.step2)}</div>
                        <div class="provider-flow-heading">{_(providerFlow.pasteAuthCode)}</div>
                      </div>
                      <TextField
                        autofocus
                        type="text"
                        label={_(providerFlow.authCodeLabel)}
                        placeholder={_(providerFlow.authCodePlaceholder)}
                        name="code"
                        value={formStore.value}
                        onChange={setFormStore.bind(null, "value")}
                        validationState={formStore.error ? "invalid" : undefined}
                        error={formStore.error}
                      />
                      <div class="provider-form-actions">
                        <Button type="button" variant="ghost" size="large" onClick={resetMethod}>
                          {_(providerFlow.back)}
                        </Button>
                        <Button class="w-auto" type="submit" size="large" variant="primary">
                          {_(providerFlow.submit)}
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
                      setStore("error", _(providerFlow.authTimeout))
                      return
                    }
                    await complete()
                    resetMethod()
                  })

                  return (
                    <div class="provider-device-flow">
                      <div class="provider-step-header">
                        <div class="provider-flow-eyebrow">{_(providerFlow.authorize)}</div>
                        <div class="provider-flow-heading">{_(providerFlow.finishInBrowser)}</div>
                        <p>{_(providerFlow.deviceInstructions)}</p>
                      </div>
                      <Link href={store.authorization!.url} class="provider-auth-link">
                        <span>{_(providerFlow.openAuthPage)}</span>
                        <Icon name={getSemanticIcon("action.open")} size="small" />
                      </Link>
                      <TextField
                        label={_(providerFlow.confirmationCode)}
                        class="font-mono"
                        value={code()}
                        readOnly
                        copyable
                      />
                      <div class="provider-flow-message">
                        <Spinner />
                        <span>{_(providerFlow.waitingForAuth)}</span>
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
