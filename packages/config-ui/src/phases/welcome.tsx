import { createSignal, type Component } from "solid-js"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { AppChrome } from "../components"
import { useDictionary } from "../locale"
import { selectIntent } from "../store"

const STAGE_COUNT = 3

export const WelcomePhase: Component = () => {
  const { t } = useDictionary()
  const [stage, setStage] = createSignal(0)
  const [wheelLocked, setWheelLocked] = createSignal(false)

  const advance = () => setStage((value) => Math.min(value + 1, STAGE_COUNT - 1))

  const handleWheel = (event: WheelEvent) => {
    if (wheelLocked() || stage() >= STAGE_COUNT - 1) return
    if (Math.abs(event.deltaY) < 18) return

    event.preventDefault()
    if (event.deltaY > 0) {
      setWheelLocked(true)
      advance()
      window.setTimeout(() => setWheelLocked(false), 520)
    }
  }

  return (
    <section class="su-welcome-immersive" onWheel={handleWheel}>
      <div class="su-welcome-backdrop" />
      <AppChrome class="su-welcome-chrome" />
      <div class="su-welcome-orbit su-welcome-orbit-a" />
      <div class="su-welcome-orbit su-welcome-orbit-b" />

      <div class="su-welcome-stage-stack">
        <section
          class="su-welcome-scene"
          classList={{ "su-welcome-scene-active": stage() === 0, "su-welcome-scene-past": stage() > 0 }}
        >
          <div class="su-welcome-scene-copy su-welcome-scene-copy-hero">
            <h1 class="su-welcome-hero-title">{t("welcomeIntroTitle")}</h1>
            <p class="su-welcome-hero-subtle">{t("welcomeIntroSubtle")}</p>
          </div>
        </section>

        <section
          class="su-welcome-scene"
          classList={{ "su-welcome-scene-active": stage() === 1, "su-welcome-scene-past": stage() > 1 }}
        >
          <div class="su-welcome-scene-copy">
            <div class="su-eyebrow">{t("welcomeFlowEyebrow")}</div>
            <h2 class="su-welcome-statement">
              <span>{t("welcomeFlowTitleLineOne")}</span>
              <span>{t("welcomeFlowTitleLineTwo")}</span>
            </h2>
            <p class="su-welcome-flow-copy">{t("welcomeFlowDescription")}</p>
          </div>
        </section>

        <section class="su-welcome-scene" classList={{ "su-welcome-scene-active": stage() === 2 }}>
          <div class="su-welcome-choice-shell">
            <div class="su-welcome-choice-intro">
              <div class="su-eyebrow">{t("welcomeChoiceEyebrow")}</div>
              <h2 class="su-welcome-choice-title">{t("welcomeChoiceTitle")}</h2>
              <p class="su-welcome-choice-copy">{t("welcomeChoiceDescription")}</p>
            </div>

            <div class="su-welcome-actions">
              <button type="button" class="su-welcome-card group" onClick={() => selectIntent("import")}>
                <div class="su-welcome-card-icon">
                  <Icon name="download" />
                </div>
                <div class="flex flex-col" style={{ gap: "0.7rem" }}>
                  <h3 class="su-welcome-card-title">{t("welcomeImportTitle")}</h3>
                  <p class="su-welcome-card-description">{t("welcomeImportDescription")}</p>
                </div>
                <div class="su-welcome-card-footer">
                  <span>{t("welcomeImportCta")}</span>
                  <Icon name="arrow-right" class="transition-transform duration-200 group-hover:translate-x-1" />
                </div>
              </button>

              <button type="button" class="su-welcome-card group" onClick={() => selectIntent("manual")}>
                <div class="su-welcome-card-icon">
                  <Icon name="sparkles" />
                </div>
                <div class="flex flex-col" style={{ gap: "0.7rem" }}>
                  <h3 class="su-welcome-card-title">{t("welcomeManualTitle")}</h3>
                  <p class="su-welcome-card-description">{t("welcomeManualDescription")}</p>
                </div>
                <div class="su-welcome-card-footer">
                  <span>{t("welcomeManualCta")}</span>
                  <Icon name="arrow-right" class="transition-transform duration-200 group-hover:translate-x-1" />
                </div>
              </button>
            </div>
          </div>
        </section>
      </div>

      <div class="su-welcome-controls">
        <div class="su-welcome-dots" aria-hidden="true">
          <div
            class="su-welcome-dot"
            classList={{ "su-welcome-dot-active": stage() === 0, "su-welcome-dot-done": stage() > 0 }}
          />
          <div
            class="su-welcome-dot"
            classList={{ "su-welcome-dot-active": stage() === 1, "su-welcome-dot-done": stage() > 1 }}
          />
          <div class="su-welcome-dot" classList={{ "su-welcome-dot-active": stage() === 2 }} />
        </div>

        <button
          type="button"
          class="su-welcome-advance"
          classList={{ "su-welcome-advance-hidden": stage() === STAGE_COUNT - 1 }}
          onClick={advance}
          aria-label={t("welcomeAdvanceLabel")}
        >
          <Icon name="arrow-right" class="su-welcome-advance-icon" />
        </button>
      </div>
    </section>
  )
}
