import type {
  ProviderAuthAuthorization,
  ProviderAuthMethod,
  ProviderConnectionTestResult,
} from "@ericsanchezok/synergy-sdk/client"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { ProviderIcon } from "@ericsanchezok/synergy-ui/provider-icon"
import { Spinner } from "@ericsanchezok/synergy-ui/spinner"
import { TextField } from "@ericsanchezok/synergy-ui/text-field"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { showToast } from "@ericsanchezok/synergy-ui/toast"
import { iife } from "@ericsanchezok/synergy-util/iife"
import {
  createEffect,
  on,
  createMemo,
  createSignal,
  For,
  Match,
  onCleanup,
  onMount,
  Show,
  Switch,
  untrack,
  type JSX,
} from "solid-js"
import { createStore, produce } from "solid-js/store"
import { useLingui } from "@lingui/solid"
import { providerFlow } from "@/locales/messages"
import { Link } from "./external-link"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { usePlatform } from "@/context/platform"
import { requestErrorMessage } from "@/utils/error"
import { providerConnectCopy, providerConnectReason, providerCTA } from "./provider-recommendation"
import { providerAuthMethodLabel } from "./provider-auth-method-label"
import { translateDescriptor } from "@/locales/translate"
import type { ProviderSetupDraft } from "./provider-setup-drafts"
import {
  resolveProviderAuthMethods,
  runProviderDeviceCallback,
  shouldAutoAdvanceConnection,
  createProviderCredentialCommand,
} from "./provider-connection-model"

export { compareProviderIDs, providerConnectCopy } from "./provider-recommendation"

const refreshConnection = { id: "settings.providers.account.retryRefresh", message: "Refresh connection" }
const refreshFailed = {
  id: "settings.providers.connection.refreshFailed",
  message: "Connection saved. Could not refresh the account.",
}

export function ProviderConnectionFlow(props: {
  providerID: string
  providerName?: string
  intent?: "connect" | "recover"
  connectedOverride?: boolean
  completeDescription?: string
  iconID?: string
  compact?: boolean
  skipAutoAdvance?: boolean
  prepareConnection?: () => Promise<string>
  draft?: ProviderSetupDraft
  onDraftChange?: (value: Partial<ProviderSetupDraft>) => void
  apiOptions?: JSX.Element
  onBack?: () => void
  onComplete?: () => void | Promise<void>
}) {
  const globalSync = useGlobalSync()
  const globalSDK = useGlobalSDK()
  const platform = usePlatform()
  const { _, i18n } = useLingui()
  const provider = createMemo(() => globalSync.data.provider.all.find((x) => x.id === props.providerID))
  const providerName = createMemo(() => props.providerName ?? provider()?.name ?? props.providerID)
  const profiles = createMemo(() => globalSync.data.provider.profiles)
  const methods = createMemo<ProviderAuthMethod[]>(() =>
    resolveProviderAuthMethods({
      registry: globalSync.data.provider_auth,
      providerID: props.providerID,
      fallbackLabel: _(providerFlow.methodApiDefaultLabel),
    }),
  )
  const connected = createMemo(
    () => props.connectedOverride ?? globalSync.data.provider.connected.includes(props.providerID),
  )
  const controller = new AbortController()
  const serverURL = globalSDK.url
  const active = () => !controller.signal.aborted && globalSDK.url === serverURL
  onCleanup(() => controller.abort())
  const [targetID, setTargetID] = createSignal(props.draft?.targetID ?? props.providerID)
  const [persisted, setPersisted] = createSignal(props.draft?.credentialsSaved ?? false)
  const [refreshing, setRefreshing] = createSignal(false)
  const [store, setStore] = createStore({
    methodIndex: undefined as undefined | number,
    authorization: undefined as undefined | ProviderAuthAuthorization,
    state: props.draft?.credentialsSaved ? "error" : (undefined as undefined | "pending" | "complete" | "error"),
    error: undefined as string | undefined,
  })

  const method = createMemo(() => (store.methodIndex !== undefined ? methods().at(store.methodIndex) : undefined))

  async function prepare() {
    const id = props.prepareConnection ? await props.prepareConnection() : props.providerID
    if (!active()) throw new DOMException("Connection view closed", "AbortError")
    setTargetID(id)
    return id
  }

  async function selectMethod(index: number) {
    if (!active() || persisted() || store.state === "pending") return
    const selected = methods()[index]
    if (!selected) return
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
      try {
        const providerID = await prepare()
        const response = await globalSDK.client.provider.oauth.authorize(
          {
            providerID,
            method: index,
          },
          { throwOnError: true, signal: controller.signal },
        )
        if (!active()) return
        setStore("state", "complete")
        setStore("authorization", response.data!)
      } catch (error) {
        if (!active()) return
        setStore("state", "error")
        setStore("error", requestErrorMessage(error))
      }
    }

    if (selected.type === "import") {
      setStore("state", "pending")
      try {
        const providerID = await prepare()
        await globalSDK.client.provider.credentials.importCredentials(
          {
            providerID,
            method: index,
          },
          { throwOnError: true, signal: controller.signal },
        )
        if (!active()) return
        await complete()
      } catch (error) {
        if (!active()) return
        setStore("state", "error")
        setStore("error", requestErrorMessage(error))
      }
    }
  }

  onMount(() => {
    if (!connected() && !props.skipAutoAdvance && shouldAutoAdvanceConnection(methods())) void selectMethod(0)
  })

  async function complete() {
    if (!active()) return
    setPersisted(true)
    props.onDraftChange?.({ credentialsSaved: true, apiKey: "" })
    await globalSync.refreshProviders()
    if (!active()) return
    const suffix = _({ id: "app.provider.toast.saved", message: "credentials saved" })
    showToast({
      type: "success",
      icon: getSemanticIcon("state.complete"),
      title: `${providerName()} ${suffix}`,
      description:
        props.completeDescription ??
        _({
          id: "app.provider.toast.untested",
          message: "Credentials saved. Use Test connection to verify a model request.",
        }),
    })
    await props.onComplete?.()
  }

  function resetMethod() {
    if (!active()) return
    setPersisted(false)
    setStore(
      produce((draft) => {
        draft.methodIndex = undefined
        draft.authorization = undefined
        draft.state = undefined
        draft.error = undefined
      }),
    )
  }

  async function retryRefresh() {
    if (refreshing()) return
    setRefreshing(true)
    try {
      await complete()
      resetMethod()
    } catch (error) {
      if (!active()) return
      setStore("error", requestErrorMessage(error))
    } finally {
      if (active()) setRefreshing(false)
    }
  }

  function methodDescription(item: ProviderAuthMethod) {
    if (item.type === "api") return _(providerFlow.methodApiDesc)
    if (item.type === "oauth") return _(providerFlow.methodOauthDesc)
    if (item.type === "import") return _(providerFlow.methodImportDesc)
    return _(providerFlow.methodGenericDesc)
  }

  function methodLabel(item: ProviderAuthMethod) {
    const descriptor = providerAuthMethodLabel(provider()?.profileID ?? props.providerID, item)
    return descriptor ? translateDescriptor(descriptor, i18n()) : item.label
  }

  function methodIcon(item: ProviderAuthMethod) {
    if (item.type === "api" || item.type === "import") return getSemanticIcon("account.import")
    if (item.type === "oauth") return getSemanticIcon("action.open")
    return getSemanticIcon("providers.main")
  }

  return (
    <div classList={{ "provider-flow": true, "provider-flow-compact": !!props.compact }}>
      <Show when={!props.compact}>
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
            <div class="provider-flow-title">
              {_({
                id: "settings.providers.connection.title",
                message: "Connect {provider}",
                values: { provider: providerName() },
              })}
            </div>
            <div class="provider-flow-subtitle">
              {providerConnectReason(props.providerID, profiles()) ?? provider()?.name ?? props.providerID}
            </div>
          </div>
        </div>
      </Show>

      <div class="provider-flow-body">
        <Switch>
          <Match when={store.methodIndex === undefined && !persisted()}>
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
                      <span class="provider-method-title">{methodLabel(item)}</span>
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
              <span>{persisted() ? _(refreshFailed) : _(providerFlow.authFailed.id, { error: store.error })}</span>
              <Show
                when={persisted()}
                fallback={
                  <Button type="button" variant="ghost" size="small" onClick={resetMethod}>
                    {_(providerFlow.tryAnotherMethod)}
                  </Button>
                }
              >
                <Button type="button" variant="secondary" disabled={refreshing()} onClick={() => void retryRefresh()}>
                  {_(refreshConnection)}
                </Button>
              </Show>
            </div>
          </Match>
          <Match when={method()?.type === "api"}>
            {iife(() => {
              const [formStore, setFormStore] = createStore({
                value: untrack(() => props.draft?.apiKey ?? ""),
                error: undefined as string | undefined,
                busy: false,
                persisted: false,
              })
              const credentialCommand = createProviderCredentialCommand(async () => {
                const providerID = await prepare()
                await globalSDK.client.auth.set(
                  { providerID, auth: { type: "api", key: formStore.value.trim() } },
                  { throwOnError: true, signal: controller.signal },
                )
                if (!active()) return
                setFormStore("persisted", true)
              }, complete)

              async function handleSubmit(e: SubmitEvent) {
                e.preventDefault()
                if (formStore.busy) return
                const form = e.currentTarget as HTMLFormElement
                const apiKey = formStore.persisted ? formStore.value : formDataValue(new FormData(form), "apiKey")

                if (!apiKey?.trim()) {
                  setFormStore("error", _(providerFlow.apiKeyRequired))
                  return
                }
                setFormStore("value", apiKey)

                setFormStore("error", undefined)
                setFormStore("busy", true)
                try {
                  await credentialCommand.run()
                } catch (error) {
                  if (!active()) return
                  setFormStore("error", requestErrorMessage(error))
                } finally {
                  if (active()) setFormStore("busy", false)
                }
              }

              return (
                <form onSubmit={handleSubmit} class="provider-api-form">
                  <div class="provider-step-header">
                    <p>
                      {props.providerID === "github"
                        ? _({
                            id: "app.provider.github.token.description",
                            message:
                              "Paste a GitHub personal access token to connect repository and GitHub CLI actions.",
                          })
                        : _(providerFlow.apiKeyDescription)}
                    </p>
                  </div>
                  <Show when={providerCTA(provider()?.profileID ?? props.providerID, profiles())}>
                    {(cta) => (
                      <Link href={cta().url} class="provider-auth-link">
                        <span>
                          {(provider()?.profileID ?? props.providerID) === "openai"
                            ? _({ id: "app.provider.apiKey.createPlatform", message: "Create OpenAI API key" })
                            : cta().label}
                        </span>
                        <Icon name={getSemanticIcon("action.open")} size="small" />
                      </Link>
                    )}
                  </Show>
                  <TextField
                    autofocus
                    type="password"
                    label={
                      props.providerID === "github"
                        ? _({ id: "app.provider.github.token.label", message: "GitHub access token" })
                        : _(providerFlow.apiKeyLabel.id, { provider: providerName() })
                    }
                    placeholder={_(providerFlow.apiKeyPlaceholder)}
                    name="apiKey"
                    value={formStore.value}
                    onChange={(value) => {
                      setFormStore("value", value)
                      props.onDraftChange?.({ apiKey: value })
                      credentialCommand.reset()
                    }}
                    disabled={formStore.busy || formStore.persisted}
                    validationState={formStore.error && !formStore.persisted ? "invalid" : undefined}
                    error={formStore.persisted ? undefined : formStore.error}
                  />
                  {props.apiOptions}
                  <Show when={formStore.persisted && formStore.error}>
                    <p class="settings-request-error" role="alert">
                      {_(refreshFailed)} <span>{formStore.error}</span>
                    </p>
                  </Show>
                  <div class="provider-form-actions">
                    <Show when={methods().length > 1}>
                      <Button
                        type="button"
                        variant="ghost"
                        size="large"
                        disabled={formStore.busy}
                        onClick={resetMethod}
                      >
                        {_(providerFlow.back)}
                      </Button>
                    </Show>
                    <Button class="w-auto" type="submit" size="large" variant="primary" disabled={formStore.busy}>
                      {formStore.persisted
                        ? _(refreshConnection)
                        : _({ id: "settings.providers.connectAction", message: "Connect" })}
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
                    busy: false,
                  })
                  const controller = new AbortController()
                  onCleanup(() => controller.abort())

                  onMount(() => {
                    if (store.authorization?.url) platform.openLink(store.authorization.url)
                  })

                  async function handleSubmit(e: SubmitEvent) {
                    e.preventDefault()
                    if (formStore.busy) return
                    const code = formDataValue(new FormData(e.currentTarget as HTMLFormElement), "code")

                    if (!code?.trim()) {
                      setFormStore("error", _(providerFlow.authCodeRequired))
                      return
                    }

                    setFormStore("error", undefined)
                    setFormStore("busy", true)
                    try {
                      await globalSDK.client.provider.oauth.callback(
                        { providerID: targetID(), method: store.methodIndex, code },
                        { throwOnError: true, signal: controller.signal },
                      )
                      await complete()
                    } catch (error) {
                      if (controller.signal.aborted) return
                      if (persisted()) {
                        setStore("state", "error")
                        setStore("error", requestErrorMessage(error))
                      } else setFormStore("error", requestErrorMessage(error, _(providerFlow.invalidAuthCode)))
                    } finally {
                      if (!controller.signal.aborted) setFormStore("busy", false)
                    }
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
                        disabled={formStore.busy}
                        value={formStore.value}
                        onChange={setFormStore.bind(null, "value")}
                        validationState={formStore.error ? "invalid" : undefined}
                        error={formStore.error}
                      />
                      <div class="provider-form-actions">
                        <Button
                          type="button"
                          variant="ghost"
                          size="large"
                          disabled={formStore.busy}
                          onClick={resetMethod}
                        >
                          {_(providerFlow.back)}
                        </Button>
                        <Button class="w-auto" type="submit" size="large" variant="primary" disabled={formStore.busy}>
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

                  const controller = new AbortController()
                  let active = true
                  onCleanup(() => {
                    active = false
                    controller.abort()
                  })

                  onMount(() => {
                    if (store.authorization?.url) platform.openLink(store.authorization.url)
                    void runProviderDeviceCallback({
                      callback: () =>
                        globalSDK.client.provider.oauth.callback(
                          {
                            providerID: targetID(),
                            method: store.methodIndex,
                          },
                          { signal: controller.signal, throwOnError: true },
                        ),
                      complete,
                      active: () => active,
                      onError: () => {
                        setStore("state", "error")
                        setStore("error", _(providerFlow.authTimeout))
                      },
                      onComplete: resetMethod,
                    })
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

const failures = {
  authentication: {
    id: "provider.test.authentication",
    message: "Credentials are missing or were rejected. Check the saved API key.",
  },
  rate_limit: { id: "provider.test.rateLimit", message: "The provider returned a quota or rate limit error." },
  model: { id: "provider.test.model", message: "The model or endpoint was not found." },
  network: { id: "provider.test.network", message: "Could not reach the provider. Check the endpoint and network." },
  timeout: { id: "provider.test.timeout", message: "The model request timed out." },
  unavailable: { id: "provider.test.unavailable", message: "No enabled text model is available for this account." },
  provider: { id: "provider.test.provider", message: "The provider rejected the model request." },
}

export function ProviderConnectionTest(props: { providerID: string; disabled?: boolean; revision?: string }) {
  const sdk = useGlobalSDK()
  const { _, i18n } = useLingui()
  const [pending, setPending] = createSignal(false)
  const [result, setResult] = createSignal<ProviderConnectionTestResult>()
  const [failed, setFailed] = createSignal(false)
  let controller: AbortController | undefined
  const reset = () => {
    controller?.abort()
    controller = undefined
    setPending(false)
    setResult(undefined)
    setFailed(false)
  }
  createEffect(on(() => [sdk.url, sdk.client, props.providerID, props.disabled, props.revision], reset))
  onCleanup(reset)
  const test = async () => {
    if (pending() || props.disabled) return
    const request = new AbortController()
    controller = request
    const client = sdk.client
    setPending(true)
    setResult(undefined)
    setFailed(false)
    try {
      const response = await client.provider.connection.test(
        { providerID: props.providerID, providerConnectionTestInput: {} },
        { signal: request.signal, throwOnError: true },
      )
      if (controller !== request || request.signal.aborted) return
      if (response.data) setResult(response.data)
      else setFailed(true)
    } catch {
      if (controller === request && !request.signal.aborted) setFailed(true)
    } finally {
      if (controller === request) setPending(false)
    }
  }
  return (
    <div class="provider-connection-test">
      <Button type="button" variant="secondary" disabled={props.disabled || pending()} onClick={() => void test()}>
        {pending()
          ? _({ id: "provider.test.pending", message: "Testing…" })
          : _({ id: "provider.test.action", message: "Test connection" })}
      </Button>
      <Show when={props.disabled}>
        <p class="ds-section-hint">
          {_({ id: "provider.test.saveFirst", message: "Save changes before testing the connection." })}
        </p>
      </Show>
      <Show when={result()}>
        {(value) => (
          <p role="status" class={value().success ? "ds-section-hint" : "settings-request-error"}>
            {value().success
              ? _({
                  id: "provider.test.success",
                  message: "Model request succeeded · {model} · {duration} ms",
                  values: { model: value().modelID ?? props.providerID, duration: value().durationMs },
                })
              : translateDescriptor(failures[value().error?.kind ?? "provider"], i18n())}
            <Show when={value().error?.statusCode}>{(status) => ` (HTTP ${status()})`}</Show>
          </p>
        )}
      </Show>
      <Show when={failed()}>
        <p role="alert" class="settings-request-error">
          {_({ id: "provider.test.failed", message: "Could not complete the connection test. Try again." })}
        </p>
      </Show>
    </div>
  )
}
