import { For, Show, createMemo, createSignal, onMount, type Component } from "solid-js"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { TextField } from "@ericsanchezok/synergy-ui/text-field"
import { api, type ConnectedProviderSource } from "../api"
import { InlineAlert, PageIntro, SectionCard, StatusPill, Tag } from "../components"
import { useDictionary } from "../locale"
import { PROVIDER_META } from "../provider-meta"
import { configStore, resetCoreValidation, setConfigStore, syncConnectedProviders } from "../store"
import { CustomProviderPhase } from "./custom-provider"

export const ConnectProviderPhase: Component = () => {
  const { t } = useDictionary()
  const [search, setSearch] = createSignal("")
  const [activeProvider, setActiveProvider] = createSignal<string | null>(null)
  const [apiKey, setApiKey] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [verifyFailed, setVerifyFailed] = createSignal(false)
  const [errorMsg, setErrorMsg] = createSignal("")
  const [successMsg, setSuccessMsg] = createSignal("")
  const [removing, setRemoving] = createSignal<string | null>(null)
  const [showCustomProvider, setShowCustomProvider] = createSignal(false)

  const loadProviders = async () => {
    try {
      const [available, connected] = await Promise.all([
        api.getProviders(),
        api.getConnectedProviders(configStore.stagedAuth, configStore.providerDrafts),
      ])
      setConfigStore("availableProviders", available.providers)
      syncConnectedProviders(connected.connected)
    } catch {}
  }

  onMount(loadProviders)

  const removableSource = (providerID: string): ConnectedProviderSource | undefined =>
    configStore.connectedProviders
      .find((provider) => provider.id === providerID)
      ?.sources.find((source) => source.removable)

  const hasExternalSource = (providerID: string) =>
    configStore.connectedProviders
      .find((provider) => provider.id === providerID)
      ?.sources.some((source) => !source.removable)

  const sourceLabel = (source: ConnectedProviderSource) => {
    switch (source.kind) {
      case "stored-key":
        return t("providersSourceStored")
      case "env":
        return source.env && source.env.length > 0
          ? `${t("providersSourceEnv")} · ${source.env.join(", ")}`
          : t("providersSourceEnv")
      case "inline-key":
        return t("providersSourceInline")
      case "draft-config":
        return t("providersSourceDraft")
    }
  }

  const modelSummary = (providerID: string) => {
    const provider = configStore.connectedProviders.find((item) => item.id === providerID)
    if (!provider) return ""
    if (provider.modelCountStatus === "verified" && provider.accountModelCount !== undefined) {
      return `${t("providersModelsAvailablePrefix")} ${provider.accountModelCount} / ${t("providersModelsCatalogPrefix")} ${provider.catalogModelCount}`
    }
    return `${t("providersModelsCatalogPrefix")} ${provider.catalogModelCount}`
  }

  const filteredProviders = createMemo(() => {
    const query = search().toLowerCase()
    const connectedIds = new Set(configStore.connectedProviders.map((provider) => provider.id))
    return configStore.availableProviders.filter(
      (provider) => !connectedIds.has(provider.id) && provider.name.toLowerCase().includes(query),
    )
  })

  const resetMessages = () => {
    setErrorMsg("")
    setSuccessMsg("")
  }

  const toggleProvider = (providerID: string) => {
    setActiveProvider(activeProvider() === providerID ? null : providerID)
    setApiKey("")
    resetMessages()
    setVerifyFailed(false)
  }

  const handleVerifyAndSave = async (providerID: string) => {
    setBusy(true)
    resetMessages()
    setVerifyFailed(false)

    try {
      const res = await api.verifyAuth(providerID, apiKey())
      if (!res.ok) {
        setVerifyFailed(true)
        setErrorMsg(res.error || t("providersVerificationFailed"))
        return
      }

      setConfigStore("stagedAuth", providerID, { mode: "set", key: apiKey() })
      setSuccessMsg(res.message || t("providersVerifiedAndSaved"))
      setActiveProvider(null)
      setApiKey("")
      resetCoreValidation()
      await loadProviders()
    } catch (error: any) {
      setVerifyFailed(true)
      setErrorMsg(error.message || t("providersVerificationError"))
    } finally {
      setBusy(false)
    }
  }

  const handleSaveAnyway = async (providerID: string) => {
    setBusy(true)
    resetMessages()

    try {
      setConfigStore("stagedAuth", providerID, { mode: "set", key: apiKey() })
      setSuccessMsg(t("providersSavedWithoutVerification"))
      setActiveProvider(null)
      setApiKey("")
      setVerifyFailed(false)
      resetCoreValidation()
      await loadProviders()
    } catch (error: any) {
      setErrorMsg(error.message || t("providersSaveFailed"))
    } finally {
      setBusy(false)
    }
  }

  const handleRemove = async (providerID: string) => {
    setRemoving(providerID)
    resetMessages()

    try {
      const removable = removableSource(providerID)
      if (!removable) return

      if (removable.kind === "stored-key") {
        setConfigStore("stagedAuth", providerID, { mode: "remove" })
      }

      if (removable.kind === "draft-config") {
        setConfigStore("providerDrafts", (drafts) => {
          const next = { ...drafts }
          delete next[providerID]
          return next
        })
      }

      resetCoreValidation()
      await loadProviders()
      const stillConnected = configStore.connectedProviders.some((provider) => provider.id === providerID)
      setSuccessMsg(stillConnected ? t("providersRemovedExternal") : t("providersRemoved"))
    } catch (error: any) {
      setErrorMsg(error.message || t("providersRemoveFailed"))
    } finally {
      setRemoving(null)
    }
  }

  return (
    <div class="su-connect-layout">
      <PageIntro eyebrow={t("connectEyebrow")} title={t("connectTitle")} copy={t("connectDescription")} />

      <Show
        when={showCustomProvider()}
        fallback={
          <SectionCard class="su-onboarding-panel su-connect-custom-entry">
            <div class="flex flex-wrap items-center justify-between gap-4">
              <div>
                <div class="su-section-label">{t("customProviderEntryEyebrow")}</div>
                <h2 class="su-required-title">{t("customProviderEntryTitle")}</h2>
                <p class="su-required-copy">{t("customProviderEntryDescription")}</p>
              </div>
              <Button variant="secondary" size="large" onClick={() => setShowCustomProvider(true)}>
                {t("customProviderEntryAction")}
              </Button>
            </div>
          </SectionCard>
        }
      >
        <CustomProviderPhase
          onDone={async () => {
            setShowCustomProvider(false)
            await loadProviders()
          }}
          onCancel={() => setShowCustomProvider(false)}
        />
      </Show>

      <SectionCard class="su-onboarding-panel su-connect-connected-panel">
        <div class="flex flex-col gap-4">
          <Show when={successMsg()}>
            <InlineAlert variant="info">{successMsg()}</InlineAlert>
          </Show>

          <Show when={errorMsg()}>
            <InlineAlert variant="error">{errorMsg()}</InlineAlert>
          </Show>

          <div class="su-onboarding-header-row">
            <div>
              <div class="su-section-label">{t("providersConnected")}</div>
              <h2 class="su-required-title">{t("connectConnectedTitle")}</h2>
              <p class="su-required-copy">{t("connectConnectedDescription")}</p>
            </div>
            <StatusPill tone={configStore.connectedProviders.length > 0 ? "success" : "neutral"}>
              {configStore.connectedProviders.length > 0
                ? `${configStore.connectedProviders.length} ${t("providersConnected")}`
                : t("connectNoneYet")}
            </StatusPill>
          </div>

          <Show
            when={configStore.connectedProviders.length > 0}
            fallback={<div class="su-empty-state">{t("connectEmptyState")}</div>}
          >
            <div class="su-provider-grid">
              <For each={configStore.connectedProviders}>
                {(provider) => (
                  <div class="su-provider-chip">
                    <div class="su-provider-chip-main">
                      <div class="su-provider-chip-top">
                        <div class="su-provider-chip-title">{provider.name}</div>
                        <Show when={hasExternalSource(provider.id)}>
                          <Tag tone="neutral">{t("providersManagedExternally")}</Tag>
                        </Show>
                      </div>
                      <div class="text-12-regular text-text-weaker">{modelSummary(provider.id)}</div>
                      <div class="mt-2 flex flex-wrap gap-2">
                        <For each={provider.sources}>{(source) => <Tag tone="neutral">{sourceLabel(source)}</Tag>}</For>
                      </div>
                    </div>
                    <Show when={removableSource(provider.id)}>
                      <Button
                        variant="ghost"
                        size="small"
                        class="text-text-on-critical-base"
                        disabled={removing() === provider.id}
                        onClick={() => handleRemove(provider.id)}
                      >
                        {removing() === provider.id ? t("providersRemoving") : t("providersRemove")}
                      </Button>
                    </Show>
                  </div>
                )}
              </For>
            </div>
          </Show>
        </div>
      </SectionCard>

      <SectionCard class="su-onboarding-panel su-connect-available-panel">
        <div class="su-connect-available-head">
          <div class="su-onboarding-header-row">
            <div>
              <div class="su-section-label">{t("providersAvailable")}</div>
              <h2 class="su-required-title">{t("connectAvailableTitle")}</h2>
              <p class="su-required-copy">{t("connectAvailableDescription")}</p>
            </div>
          </div>

          <div class="su-provider-search su-connect-search-shell">
            <TextField
              label={t("providersAvailable")}
              hideLabel
              placeholder={t("providersSearchPlaceholder")}
              value={search()}
              onChange={setSearch}
            />
          </div>
        </div>

        <div class="su-connect-provider-list">
          <div class="su-connect-provider-list-inner">
            <For each={filteredProviders()}>
              {(provider) => (
                <Show
                  when={activeProvider() === provider.id}
                  fallback={
                    <button type="button" class="su-provider-row" onClick={() => toggleProvider(provider.id)}>
                      <div>
                        <div class="text-13-medium text-text-strong">{provider.name}</div>
                      </div>
                      <div class="su-provider-row-actions">
                        <Show when={PROVIDER_META[provider.id]}>
                          <a
                            class="su-provider-key-link"
                            href={PROVIDER_META[provider.id]!.keysUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <Icon name="arrow-up-right" size="small" />
                            {t("providerGetKey")}
                          </a>
                        </Show>
                        <StatusPill tone="neutral">{t("providersAdd")}</StatusPill>
                      </div>
                    </button>
                  }
                >
                  <div class="su-provider-active">
                    <div class="flex items-center justify-between gap-4">
                      <div class="flex items-center gap-2">
                        <span class="text-13-medium text-text-strong">{provider.name}</span>
                        <Show when={PROVIDER_META[provider.id]}>
                          <a
                            class="su-provider-key-link"
                            href={PROVIDER_META[provider.id]!.keysUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            <Icon name="arrow-up-right" size="small" />
                            {t("providerGetKey")}
                          </a>
                        </Show>
                      </div>
                      <Button variant="ghost" size="small" onClick={() => toggleProvider(provider.id)}>
                        {t("providersCancel")}
                      </Button>
                    </div>

                    <div class="su-provider-note">
                      <div class="text-12-medium uppercase tracking-wider text-text-weaker">
                        {t("providersCredentialStoreTitle")}
                      </div>
                      <p class="text-12-regular text-text-weaker">{t("providersCredentialStoreDescription")}</p>
                    </div>

                    <div class="flex flex-col gap-3 xl:flex-row">
                      <div class="flex-1">
                        <TextField
                          type="password"
                          label={t("providersApiKey")}
                          hideLabel
                          placeholder={t("providersApiKey")}
                          value={apiKey()}
                          onChange={(value) => {
                            setApiKey(value)
                            setVerifyFailed(false)
                            resetMessages()
                          }}
                          onKeyDown={(event: KeyboardEvent) => {
                            if (event.key !== "Enter" || !apiKey() || busy()) return
                            if (verifyFailed()) handleSaveAnyway(provider.id)
                            else handleVerifyAndSave(provider.id)
                          }}
                        />
                      </div>

                      <Show
                        when={verifyFailed()}
                        fallback={
                          <Button
                            variant="primary"
                            size="large"
                            disabled={!apiKey() || busy()}
                            onClick={() => handleVerifyAndSave(provider.id)}
                          >
                            {busy() ? t("providersVerifying") : t("providersVerifyAndSave")}
                          </Button>
                        }
                      >
                        <Button
                          variant="secondary"
                          size="large"
                          disabled={!apiKey() || busy()}
                          onClick={() => handleSaveAnyway(provider.id)}
                        >
                          {busy() ? t("providersSaving") : t("providersSaveAnyway")}
                        </Button>
                      </Show>
                    </div>

                    <Show when={provider.env.length > 0}>
                      <div class="su-provider-note">
                        <div class="text-12-medium uppercase tracking-wider text-text-weaker">
                          {t("providersEnvTitle")}
                        </div>
                        <p class="text-12-regular text-text-weaker">{t("providersEnvDescription")}</p>
                        <div class="flex flex-wrap gap-2">
                          <For each={provider.env}>{(env) => <Tag tone="neutral">{env}</Tag>}</For>
                        </div>
                      </div>
                    </Show>
                  </div>
                </Show>
              )}
            </For>

            <Show when={filteredProviders().length === 0}>
              <p class="su-empty-state">{search() ? t("providersNoMatch") : t("providersAllConnected")}</p>
            </Show>
          </div>
        </div>
      </SectionCard>
    </div>
  )
}
