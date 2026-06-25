import type { AccountUsageSnapshot, ProviderAuthAuthorization } from "@ericsanchezok/synergy-sdk/client"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { Dialog } from "@ericsanchezok/synergy-ui/dialog"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { IconButton } from "@ericsanchezok/synergy-ui/icon-button"
import { List, type ListRef } from "@ericsanchezok/synergy-ui/list"
import { ProviderIcon } from "@ericsanchezok/synergy-ui/provider-icon"
import { Spinner } from "@ericsanchezok/synergy-ui/spinner"
import { TextField } from "@ericsanchezok/synergy-ui/text-field"
import { showToast } from "@ericsanchezok/synergy-ui/toast"
import { iife } from "@ericsanchezok/synergy-util/iife"
import { createMemo, For, Match, onCleanup, onMount, Show, Switch } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { Link } from "@/components/link"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { usePlatform } from "@/context/platform"
import { DialogSelectModel } from "./dialog-select-model"
import { DialogSelectProvider } from "./dialog-select-provider"

export function DialogConnectProvider(props: { provider: string }) {
  const dialog = useDialog()
  const globalSync = useGlobalSync()
  const globalSDK = useGlobalSDK()
  const platform = usePlatform()
  const provider = createMemo(() => globalSync.data.provider.all.find((x) => x.id === props.provider)!)
  const methods = createMemo(
    () =>
      globalSync.data.provider_auth[props.provider] ?? [
        {
          type: "api",
          label: "API key",
        },
      ],
  )
  const [store, setStore] = createStore({
    methodIndex: undefined as undefined | number,
    authorization: undefined as undefined | ProviderAuthAuthorization,
    usage: undefined as undefined | AccountUsageSnapshot,
    usageState: "idle" as "idle" | "pending" | "complete" | "error",
    state: "pending" as undefined | "pending" | "complete" | "error",
    error: undefined as string | undefined,
  })

  const method = createMemo(() => (store.methodIndex !== undefined ? methods().at(store.methodIndex!) : undefined))
  const connected = createMemo(() => globalSync.data.provider.connected.includes(props.provider))
  const usageSupported = createMemo(() => ["anthropic", "openai-codex", "openrouter"].includes(props.provider))

  function formatPercent(value: number | undefined) {
    if (value === undefined) return undefined
    return `${Math.round(value)}%`
  }

  function formatReset(value: string | undefined) {
    if (!value) return undefined
    const date = new Date(value)
    if (Number.isNaN(date.getTime())) return undefined
    return date.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    })
  }

  async function loadUsage() {
    if (!connected() || !usageSupported()) return
    setStore("usageState", "pending")
    await globalSDK.client.provider.usage
      .get({ providerID: props.provider }, { throwOnError: true })
      .then((x) => {
        setStore("usage", x.data)
        setStore("usageState", "complete")
      })
      .catch(() => {
        setStore("usageState", "error")
      })
  }

  async function selectMethod(index: number) {
    const method = methods()[index]
    setStore(
      produce((draft) => {
        draft.methodIndex = index
        draft.authorization = undefined
        draft.state = undefined
        draft.error = undefined
      }),
    )

    if (method.type === "oauth") {
      setStore("state", "pending")
      const start = Date.now()
      await globalSDK.client.provider.oauth
        .authorize(
          {
            providerID: props.provider,
            method: index,
          },
          { throwOnError: true },
        )
        .then((x) => {
          const elapsed = Date.now() - start
          const delay = 1000 - elapsed

          if (delay > 0) {
            setTimeout(() => {
              setStore("state", "complete")
              setStore("authorization", x.data!)
            }, delay)
            return
          }
          setStore("state", "complete")
          setStore("authorization", x.data!)
        })
        .catch((e) => {
          setStore("state", "error")
          setStore("error", String(e))
        })
    }
  }

  let listRef: ListRef | undefined
  function handleKey(e: KeyboardEvent) {
    if (e.key === "Enter" && e.target instanceof HTMLInputElement) {
      return
    }
    if (e.key === "Escape") return
    listRef?.onKeyDown(e)
  }

  onMount(() => {
    if (methods().length === 1) {
      selectMethod(0)
    }
    loadUsage()
    document.addEventListener("keydown", handleKey)
    onCleanup(() => {
      document.removeEventListener("keydown", handleKey)
    })
  })

  async function complete() {
    await globalSDK.client.global.dispose()
    dialog.close()
    showToast({
      type: "success",
      icon: "circle-check",
      title: `${provider().name} connected`,
      description: `${provider().name} models are now available to use.`,
    })
  }

  function goBack() {
    if (methods().length === 1) {
      dialog.show(() => <DialogSelectProvider />)
      return
    }
    if (store.authorization) {
      setStore("authorization", undefined)
      setStore("methodIndex", undefined)
      return
    }
    if (store.methodIndex) {
      setStore("methodIndex", undefined)
      return
    }
    dialog.show(() => <DialogSelectProvider />)
  }

  return (
    <Dialog title={<IconButton tabIndex={-1} icon="arrow-left" variant="ghost" onClick={goBack} />}>
      <div class="flex flex-col gap-6 px-2.5 pb-3">
        <div class="px-2.5 flex gap-4 items-center">
          <ProviderIcon id={props.provider} class="size-5 shrink-0 icon-strong-base" />
          <div class="text-16-medium text-text-strong">
            <Switch>
              <Match when={props.provider === "anthropic" && method()?.label?.toLowerCase().includes("max")}>
                Login with Claude Pro/Max
              </Match>
              <Match when={props.provider === "openai-codex"}>Login with ChatGPT/Codex</Match>
              <Match when={true}>Connect {provider().name}</Match>
            </Switch>
          </div>
        </div>
        <Show when={connected()}>
          <div class="mx-2.5 flex flex-col gap-3 rounded-md border border-border-base bg-surface-base px-3 py-2.5">
            <div class="flex items-center gap-2 text-13-medium text-text-strong">
              <Icon name="circle-check" class="text-icon-success-base" />
              <span>Connected</span>
            </div>
            <Show when={usageSupported()}>
              <Switch>
                <Match when={store.usageState === "pending"}>
                  <div class="flex items-center gap-2 text-13-regular text-text-weak">
                    <Spinner />
                    <span>Loading account usage...</span>
                  </div>
                </Match>
                <Match when={store.usageState === "error"}>
                  <div class="text-13-regular text-text-weak">Usage is unavailable right now.</div>
                </Match>
                <Match when={store.usage}>
                  {(usage) => (
                    <div class="flex flex-col gap-2 text-13-regular text-text-base">
                      <Show when={usage().plan}>
                        <div class="text-text-weak">Plan: {usage().plan}</div>
                      </Show>
                      <Show when={usage().status === "unavailable"}>
                        <div class="text-text-weak">{usage().unavailableReason ?? "Usage is unavailable."}</div>
                      </Show>
                      <Show when={usage().status === "error"}>
                        <div class="text-text-weak">{usage().unavailableReason ?? "Usage request failed."}</div>
                      </Show>
                      <Show when={usage().credits}>
                        {(credits) => (
                          <div>
                            Credits:{" "}
                            {credits().unlimited
                              ? "unlimited"
                              : credits().balance !== undefined
                                ? `${credits().balance}${credits().currency ? ` ${credits().currency}` : ""}`
                                : credits().hasCredits === false
                                  ? "none"
                                  : "available"}
                          </div>
                        )}
                      </Show>
                      <For each={usage().windows}>
                        {(window) => (
                          <div class="flex items-center justify-between gap-3">
                            <span>{window.label}</span>
                            <span class="text-text-weak">
                              {formatPercent(window.remainingPercent) ?? formatPercent(window.usedPercent) ?? "n/a"}
                              {formatReset(window.resetAt) ? ` resets ${formatReset(window.resetAt)}` : ""}
                            </span>
                          </div>
                        )}
                      </For>
                    </div>
                  )}
                </Match>
              </Switch>
            </Show>
          </div>
        </Show>
        <div class="px-2.5 pb-10 flex flex-col gap-6">
          <Switch>
            <Match when={store.methodIndex === undefined}>
              <div class="text-14-regular text-text-base">Select login method for {provider().name}.</div>
              <div class="">
                <List
                  ref={(ref) => {
                    listRef = ref
                  }}
                  items={methods}
                  key={(m) => m?.label}
                  onSelect={async (method, index) => {
                    if (!method) return
                    selectMethod(index)
                  }}
                >
                  {(i) => (
                    <div class="w-full flex items-center gap-x-2">
                      <div class="w-4 h-2 rounded-[1px] bg-input-base shadow-xs-border-base flex items-center justify-center">
                        <div class="w-2.5 h-0.5 bg-icon-strong-base hidden" data-slot="list-item-extra-icon" />
                      </div>
                      <span>{i.label}</span>
                    </div>
                  )}
                </List>
              </div>
            </Match>
            <Match when={store.state === "pending"}>
              <div class="text-14-regular text-text-base">
                <div class="flex items-center gap-x-2">
                  <Spinner />
                  <span>Authorization in progress...</span>
                </div>
              </div>
            </Match>
            <Match when={store.state === "error"}>
              <div class="text-14-regular text-text-base">
                <div class="flex items-center gap-x-2">
                  <Icon name="ban" class="text-icon-critical-base" />
                  <span>Authorization failed: {store.error}</span>
                </div>
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
                  const formData = new FormData(form)
                  const apiKey = formData.get("apiKey") as string

                  if (!apiKey?.trim()) {
                    setFormStore("error", "API key is required")
                    return
                  }

                  setFormStore("error", undefined)
                  await globalSDK.client.auth.set({
                    providerID: props.provider,
                    auth: {
                      type: "api",
                      key: apiKey,
                    },
                  })
                  await complete()
                }

                return (
                  <div class="flex flex-col gap-6">
                    <div class="text-14-regular text-text-base">
                      Enter your {provider().name} API key to connect your account and use {provider().name} models in
                      Synergy.
                    </div>
                    <form onSubmit={handleSubmit} class="flex flex-col items-start gap-4">
                      <TextField
                        autofocus
                        type="text"
                        label={`${provider().name} API key`}
                        placeholder="API key"
                        name="apiKey"
                        value={formStore.value}
                        onChange={setFormStore.bind(null, "value")}
                        validationState={formStore.error ? "invalid" : undefined}
                        error={formStore.error}
                      />
                      <Button class="w-auto" type="submit" size="large" variant="primary">
                        Submit
                      </Button>
                    </form>
                  </div>
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
                      if (store.authorization?.method === "code" && store.authorization?.url) {
                        platform.openLink(store.authorization.url)
                      }
                    })

                    async function handleSubmit(e: SubmitEvent) {
                      e.preventDefault()

                      const form = e.currentTarget as HTMLFormElement
                      const formData = new FormData(form)
                      const code = formData.get("code") as string

                      if (!code?.trim()) {
                        setFormStore("error", "Authorization code is required")
                        return
                      }

                      setFormStore("error", undefined)
                      const { error } = await globalSDK.client.provider.oauth.callback({
                        providerID: props.provider,
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
                      <div class="flex flex-col gap-6">
                        <div class="text-14-regular text-text-base">
                          Visit <Link href={store.authorization!.url}>this link</Link> to collect your authorization
                          code to connect your account and use {provider().name} models in Synergy.
                        </div>
                        <form onSubmit={handleSubmit} class="flex flex-col items-start gap-4">
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
                          <Button class="w-auto" type="submit" size="large" variant="primary">
                            Submit
                          </Button>
                        </form>
                      </div>
                    )
                  })}
                </Match>
                <Match when={store.authorization?.method === "auto"}>
                  {iife(() => {
                    const code = createMemo(() => {
                      const instructions = store.authorization?.instructions
                      if (instructions?.includes(":")) {
                        return instructions?.split(":")[1]?.trim()
                      }
                      return instructions
                    })

                    onMount(async () => {
                      const result = await globalSDK.client.provider.oauth.callback({
                        providerID: props.provider,
                        method: store.methodIndex,
                      })
                      if (result.error) {
                        // TODO: show error
                        dialog.close()
                        return
                      }
                      await complete()
                    })

                    return (
                      <div class="flex flex-col gap-6">
                        <div class="text-14-regular text-text-base">
                          Visit <Link href={store.authorization!.url}>this link</Link> and enter the code below to
                          connect your account and use {provider().name} models in Synergy.
                        </div>
                        <TextField label="Confirmation code" class="font-mono" value={code()} readOnly copyable />
                        <div class="text-14-regular text-text-base flex items-center gap-4">
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
    </Dialog>
  )
}
