import { For, Match, Show, Switch, createMemo, onMount, type Component } from "solid-js"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { AppChrome } from "./components"
import { api } from "./api"
import { FinishPhase } from "./phases/finish"
import { ChooseModelsPhase } from "./phases/choose-models"
import { ConnectProviderPhase } from "./phases/connect-provider"
import { ImportPhase } from "./phases/import"
import { SearchSetupPhase } from "./phases/search-setup"
import { ValidateCorePhase } from "./phases/validate-core"
import { OptionalRolesPhase } from "./phases/optional-roles"
import { WelcomePhase } from "./phases/welcome"
import { useDictionary, type DictionaryKey } from "./locale"
import {
  configStore,
  getNextPhase,
  getPhaseState,
  getPreviousPhase,
  getProgressPhaseOrder,
  goToNextPhase,
  goToPreviousPhase,
  hasPartialRecallSetup,
  hydrateManualConfig,
  type SetupPhase,
} from "./store"

const phaseLabelKey: Record<SetupPhase, DictionaryKey> = {
  welcome: "phaseWelcome",
  import: "phaseImport",
  "connect-provider": "phaseConnectProvider",
  "choose-models": "phaseChooseModels",
  "recall-setup": "phaseRecallSetup",
  "validate-core": "phaseValidateCore",
  "optional-roles": "phaseOptionalRoles",
  finish: "phaseFinish",
}

const PhaseContent: Component = () => (
  <Switch>
    <Match when={configStore.phase === "welcome"}>
      <WelcomePhase />
    </Match>
    <Match when={configStore.phase === "import"}>
      <ImportPhase />
    </Match>
    <Match when={configStore.phase === "connect-provider"}>
      <ConnectProviderPhase />
    </Match>
    <Match when={configStore.phase === "choose-models"}>
      <ChooseModelsPhase />
    </Match>
    <Match when={configStore.phase === "recall-setup"}>
      <SearchSetupPhase />
    </Match>
    <Match when={configStore.phase === "validate-core"}>
      <ValidateCorePhase />
    </Match>
    <Match when={configStore.phase === "optional-roles"}>
      <OptionalRolesPhase />
    </Match>
    <Match when={configStore.phase === "finish"}>
      <FinishPhase />
    </Match>
  </Switch>
)

export const App: Component = () => {
  const { t } = useDictionary()

  onMount(async () => {
    try {
      const current = await api.getConfig()
      hydrateManualConfig(current.config)
    } catch {}
  })

  const isWelcomePhase = () => configStore.phase === "welcome"
  const nextPhase = () => getNextPhase(configStore)
  const previousPhase = () => getPreviousPhase(configStore)
  const canGoBack = () => previousPhase() !== null
  const canGoNext = () => nextPhase() !== null
  const showForwardNavigation = () => configStore.phase !== "finish"

  const progressPhases = createMemo(() => getProgressPhaseOrder(configStore))
  const currentProgressIndex = createMemo(() => {
    const phases = progressPhases()
    const index = phases.indexOf(configStore.phase)
    return index >= 0 ? index : 0
  })

  const nextActionHint = createMemo(() => {
    if (canGoNext()) {
      return configStore.phase === "import" ? t("navNextReadyImport") : t("navNextReadyDefault")
    }

    switch (configStore.phase) {
      case "import":
        return t("navNextLockedImport")
      case "connect-provider":
        return t("navNextLockedConnect")
      case "choose-models":
        return t("navNextLockedChoose")
      case "recall-setup":
        return hasPartialRecallSetup(configStore) ? t("navNextLockedRecall") : t("navNextReadyRecall")
      case "validate-core":
        return t("navNextLockedValidate")
      case "optional-roles":
        return t("navNextReadyRoles")
      default:
        return t("navNextReadyDefault")
    }
  })

  const handlePrimaryAction = () => {
    if (!canGoNext()) return
    goToNextPhase()
  }

  return (
    <div class="su-shell">
      <div class="su-glow" />

      <Show when={!isWelcomePhase()}>
        <AppChrome />
      </Show>

      <main
        class="su-stage"
        classList={{
          "su-stage-welcome": isWelcomePhase(),
          "su-stage-task": !isWelcomePhase(),
        }}
      >
        <Show
          when={isWelcomePhase()}
          fallback={
            <div class="su-task-shell">
              <aside class="su-task-rail">
                <div class="su-task-rail-head">
                  <div class="su-section-label">{t("setupJourney")}</div>
                  <div class="su-task-rail-count">
                    {currentProgressIndex() + 1} / {progressPhases().length}
                  </div>
                </div>

                <div class="su-task-rail-steps">
                  <For each={progressPhases()}>
                    {(phase, index) => {
                      const active = () => phase === configStore.phase
                      const done = () => index() < currentProgressIndex() || getPhaseState(configStore, phase).complete
                      const upcoming = () => index() > currentProgressIndex()

                      return (
                        <div class="su-task-step-wrap">
                          <div class="su-task-step-rail">
                            <div
                              class="su-task-step-dot"
                              classList={{
                                "su-task-step-dot-active": active(),
                                "su-task-step-dot-done": done(),
                                "su-task-step-dot-upcoming": upcoming(),
                              }}
                            >
                              {index() + 1}
                            </div>
                            <Show when={index() < progressPhases().length - 1}>
                              <div class="su-task-step-line" classList={{ "su-task-step-line-done": done() }} />
                            </Show>
                          </div>

                          <div
                            class="su-task-step-copy"
                            classList={{
                              "su-task-step-copy-active": active(),
                              "su-task-step-copy-done": done(),
                            }}
                          >
                            {t(phaseLabelKey[phase])}
                          </div>
                        </div>
                      )
                    }}
                  </For>
                </div>
              </aside>

              <section class="su-task-stage-frame">
                <div class="su-task-panel">
                  <Show when={canGoBack()}>
                    <div class="su-task-panel-nav su-task-panel-nav-top">
                      <button type="button" class="su-task-arrow" onClick={goToPreviousPhase} aria-label={t("back")}>
                        <Icon name="arrow-up" size="small" />
                      </button>
                      <div class="su-task-panel-nav-stack">
                        <div class="su-task-arrow-label">{t("back")}</div>
                        <div class="su-task-panel-nav-copy">{t("navBackHint")}</div>
                      </div>
                    </div>
                  </Show>

                  <div class="su-task-panel-content">
                    <PhaseContent />
                  </div>

                  <Show when={showForwardNavigation()}>
                    <div class="su-task-panel-nav su-task-panel-nav-bottom">
                      <button
                        type="button"
                        class="su-task-arrow su-task-arrow-next"
                        classList={{ "su-task-arrow-disabled": !canGoNext() }}
                        disabled={!canGoNext()}
                        onClick={handlePrimaryAction}
                        aria-label={t("continue")}
                      >
                        <Icon name="arrow-up" size="small" class="rotate-180" />
                      </button>
                      <div class="su-task-panel-nav-stack">
                        <div class="su-task-arrow-label">{t("continue")}</div>
                        <div
                          class="su-task-panel-nav-copy"
                          classList={{ "su-task-panel-nav-copy-disabled": !canGoNext() }}
                        >
                          {nextActionHint()}
                        </div>
                      </div>
                    </div>
                  </Show>
                </div>
              </section>
            </div>
          }
        >
          <PhaseContent />
        </Show>
      </main>
    </div>
  )
}
