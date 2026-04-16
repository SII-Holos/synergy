import { For, Show, createMemo, createSignal, type Component } from "solid-js"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { TextField } from "@ericsanchezok/synergy-ui/text-field"
import { PageIntro, SectionCard, StatusPill } from "../components"
import { useDictionary } from "../locale"
import { ROLE_META } from "../role-meta"
import { configStore, setConfigStore, type RoleKey } from "../store"

const RoleCard: Component<{ role: (typeof ROLE_META)[number]; index: number }> = (props) => {
  const { t } = useDictionary()
  const [search, setSearch] = createSignal("")

  const selectedValue = createMemo(() => configStore.roles[props.role.key])

  const allOptions = createMemo(() =>
    configStore.connectedProviders.flatMap((provider) =>
      provider.models.map((model) => ({
        value: `${provider.id}/${model.id}`,
        providerName: provider.name,
        modelName: model.name,
      })),
    ),
  )

  const filteredOptions = createMemo(() => {
    const query = search().toLowerCase().trim()
    if (!query) return allOptions()
    return allOptions().filter(
      (option) => option.modelName.toLowerCase().includes(query) || option.providerName.toLowerCase().includes(query),
    )
  })

  const selectRole = (value: string | undefined) => {
    setConfigStore("roles", props.role.key, value)
  }

  return (
    <section class="su-role-card">
      <div class="su-role-card-head">
        <div class="su-role-card-icon">
          <Icon name={props.role.icon} size="small" />
        </div>
        <div class="su-role-card-copy">
          <div class="su-section-label">
            {props.index}. {t(props.role.labelKey)}
          </div>
          <h3 class="su-role-card-title">{t(props.role.headlineKey)}</h3>
          <div class="su-role-card-label">{t(props.role.labelKey)}</div>
          <p class="su-role-card-description">{t(props.role.descriptionKey)}</p>
        </div>
        <StatusPill tone={selectedValue() ? "info" : "neutral"}>
          {selectedValue() ? t("rolesCustomState") : t("rolesFallbackState")}
        </StatusPill>
      </div>

      <div class="su-role-search-wrap">
        <TextField placeholder={t("rolesSearchPlaceholder")} value={search()} onChange={setSearch} />
      </div>

      <div class="su-role-option-list">
        <button
          type="button"
          class="su-role-option"
          classList={{ "su-role-option-active": !selectedValue() }}
          onClick={() => selectRole(undefined)}
        >
          <div class="su-role-option-main">
            <div class="su-role-option-title">{t("rolesUseDefaultTitle")}</div>
            <div class="su-role-option-copy">{t("rolesUseDefaultDescription")}</div>
          </div>
        </button>

        <For each={filteredOptions()}>
          {(option) => {
            const selected = () => selectedValue() === option.value
            return (
              <button
                type="button"
                class="su-role-option"
                classList={{ "su-role-option-active": selected() }}
                onClick={() => selectRole(option.value)}
              >
                <div class="su-role-option-main">
                  <div class="su-role-option-title">{option.modelName}</div>
                  <div class="su-role-option-copy">{option.providerName}</div>
                </div>
              </button>
            )
          }}
        </For>
      </div>
    </section>
  )
}

export const OptionalRolesPhase: Component = () => {
  const { t } = useDictionary()

  return (
    <div class="su-roles-layout">
      <PageIntro
        eyebrow={t("rolesEyebrow")}
        title={t("rolesTitle")}
        copy={t("rolesDescription")}
        class="su-roles-intro"
      >
        <div class="su-roles-intro-note">{t("rolesOptionalNote")}</div>
      </PageIntro>

      <SectionCard class="su-onboarding-panel">
        <div class="su-roles-hero">
          <div class="su-roles-hero-headline">{t("rolesHeroTitle")}</div>
          <div class="su-roles-hero-copy">{t("rolesHeroDescription")}</div>
        </div>
      </SectionCard>

      <div class="su-role-card-grid">
        <For each={ROLE_META}>{(role, index) => <RoleCard role={role} index={index() + 1} />}</For>
      </div>

      <Show when={configStore.connectedProviders.length === 0}>
        <SectionCard>
          <div class="su-empty-state">{t("noProvidersConnected")}</div>
        </SectionCard>
      </Show>
    </div>
  )
}
