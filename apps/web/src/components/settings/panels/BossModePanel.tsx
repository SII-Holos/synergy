import { settingsFieldCopy } from "../settings-field-copy"
import { useLingui } from "@lingui/solid"
import { createSignal, For, Show } from "solid-js"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { TextField } from "@ericsanchezok/synergy-ui/text-field"
import { Switch } from "@ericsanchezok/synergy-ui/switch"
import { showToast } from "@ericsanchezok/synergy-ui/toast"
import { requestErrorMessage } from "@/utils/error"
import { SettingRow } from "../components/SettingsSettingRow"
import { SegmentPill } from "../components/SegmentPill"
import { SettingsPage, SettingsSection } from "../components/SettingsPrimitives"
import type { RuntimeStore } from "../types"
import type { BossNameController } from "./boss-name-controller"
import type { MessageDescriptor } from "@lingui/core"

/* Boss Mode */
const bossPageTitle = { id: "settings.runtime.boss.title", message: "Boss Mode" }
const bossPageDesc = {
  id: "settings.runtime.boss.desc",
  message:
    "Turn this Synergy instance into a colleague: auto-create a runtime boss session and route all Feishu messages to it.",
}
const bossRowDesc = {
  id: "settings.runtime.boss.enabled.desc",
  message: "Route all Feishu messages to the runtime boss session",
}
const personalityRowTitle = settingsFieldCopy.bossPersonality
const personalityRowDesc = {
  id: "settings.runtime.boss.personality.desc",
  message: "How your boss colleague behaves and communicates.",
}
const personaDefault = { id: "settings.runtime.boss.persona.default", message: "Default" }
const personaProjectManager = { id: "settings.runtime.boss.persona.projectManager", message: "Project Manager" }
const personaOpsAssistant = { id: "settings.runtime.boss.persona.opsAssistant", message: "Ops Assistant" }
const personaCustom = { id: "settings.runtime.boss.persona.custom", message: "Custom" }
const personaTraitsTitle = {
  id: "settings.runtime.boss.persona.customTraits",
  message: "Custom personality traits",
}
const nameRowTitle = settingsFieldCopy.bossName
const nameRowDesc = {
  id: "settings.runtime.boss.name.desc",
  message: "The name your boss colleague will use.",
}
const namePlaceholder = { id: "settings.runtime.boss.name.placeholder", message: "e.g. Xiaofei" }
const openSessionRowTitle = { id: "settings.runtime.boss.openSession", message: "Open boss session" }
const openSessionRowDesc = {
  id: "settings.runtime.boss.openSession.desc",
  message: "Open the runtime boss chat. Creates the session on first use.",
}
const openSessionBusy = { id: "settings.runtime.boss.openSession.busy", message: "Opening…" }
const openSessionFailed = { id: "settings.runtime.boss.openSession.failed", message: "Could not open the boss session" }

type BossPersonaPresetOption = { value: string; label: MessageDescriptor }

type BossPersonaTraitKey =
  | "bossPersonaFormality"
  | "bossPersonaConciseness"
  | "bossPersonaProactiveness"
  | "bossPersonaWarmth"

type BossPersonaTraitDef = { key: BossPersonaTraitKey; label: MessageDescriptor }

const personaOptions: BossPersonaPresetOption[] = [
  { value: "none", label: personaDefault },
  { value: "project_manager", label: personaProjectManager },
  { value: "ops_assistant", label: personaOpsAssistant },
  { value: "custom", label: personaCustom },
]

const personaTraits: BossPersonaTraitDef[] = [
  { key: "bossPersonaFormality", label: { id: "settings.runtime.boss.persona.formality", message: "Formality" } },
  { key: "bossPersonaConciseness", label: { id: "settings.runtime.boss.persona.conciseness", message: "Conciseness" } },
  {
    key: "bossPersonaProactiveness",
    label: { id: "settings.runtime.boss.persona.proactiveness", message: "Proactiveness" },
  },
  { key: "bossPersonaWarmth", label: { id: "settings.runtime.boss.persona.warmth", message: "Warmth" } },
]

function personaOptionWithLabel(option: BossPersonaPresetOption, translate: (descriptor: MessageDescriptor) => string) {
  return { value: option.value, label: translate(option.label) }
}

function personaTraitLabel(trait: BossPersonaTraitDef, translate: (descriptor: MessageDescriptor) => string): string {
  return translate(trait.label)
}

export function BossModePanel(props: {
  runtime: RuntimeStore
  onRuntimeChange: (key: keyof RuntimeStore, value: string) => void
  nameController: BossNameController
  configDirty?: boolean
  onOpenBossSession?: () => Promise<void>
}) {
  const { _ } = useLingui()
  const enabled = () => props.runtime.bossMode === "true"
  const preset = () => props.runtime.bossPersonaPreset
  const [opening, setOpening] = createSignal(false)

  const reportOpenSessionFailure = (error: unknown) => {
    try {
      showToast({
        type: "error",
        title: _(openSessionFailed),
        description: requestErrorMessage(error, _(openSessionFailed)),
      })
    } catch {
      console.warn(_(openSessionFailed), error)
    }
  }

  const handleOpenSession = async () => {
    if (opening() || !props.onOpenBossSession) return
    setOpening(true)
    try {
      await props.onOpenBossSession()
    } catch (error) {
      reportOpenSessionFailure(error)
    } finally {
      setOpening(false)
    }
  }

  return (
    <SettingsPage title={_(bossPageTitle)} description={_(bossPageDesc)}>
      <SettingsSection>
        <SettingRow
          title={_({ id: "settings.runtime.boss.enable", message: "Enable colleague mode" })}
          description={_(bossRowDesc)}
          trailing={
            <Switch
              checked={enabled()}
              onChange={(value) => props.onRuntimeChange("bossMode", value ? "true" : "false")}
            />
          }
        />
        <SettingRow
          title={_(personalityRowTitle)}
          description={_(personalityRowDesc)}
          trailing={
            <SegmentPill
              value={preset()}
              ariaLabel={_(personalityRowTitle)}
              options={personaOptions.map((option) => personaOptionWithLabel(option, _))}
              onChange={(value) => props.onRuntimeChange("bossPersonaPreset", value)}
            />
          }
        />
        <Show when={preset() === "custom"}>
          <div
            role="group"
            aria-label={_(personaTraitsTitle)}
            class="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-4 pt-1"
          >
            <For each={personaTraits}>
              {(trait) => {
                const value = () => props.runtime[trait.key]
                const percent = () => {
                  const parsed = Number(value())
                  return Number.isFinite(parsed) ? String(Math.round(parsed * 100)) : "0"
                }
                return (
                  <div class="flex flex-col gap-1.5 min-w-0">
                    <div class="flex items-center justify-between gap-3 min-w-0">
                      <span class="settings-row-title truncate">{personaTraitLabel(trait, _)}</span>
                      <span class="settings-row-state tabular-nums">{percent()}%</span>
                    </div>
                    <input
                      class="settings-step-scale-slider"
                      type="range"
                      min="0"
                      max="1"
                      step="0.01"
                      value={value()}
                      aria-label={personaTraitLabel(trait, _)}
                      onInput={(event) => {
                        const next = Number(event.currentTarget.value)
                        props.onRuntimeChange(trait.key, Number.isFinite(next) ? next.toFixed(2) : "0.5")
                      }}
                    />
                  </div>
                )
              }}
            </For>
          </div>
        </Show>
        <SettingRow
          title={_(nameRowTitle)}
          description={_(nameRowDesc)}
          trailing={
            <TextField
              type="text"
              value={props.nameController.content()}
              placeholder={_(namePlaceholder)}
              disabled={!enabled() || !props.nameController.loaded()}
              class="settings-row-control-text"
              onChange={props.nameController.setContent}
            />
          }
        />
        <Show when={props.nameController.error()}>
          <p role="alert" class="ds-section-hint">
            {props.nameController.error()}
          </p>
          <Show when={!props.nameController.loaded()}>
            <Button variant="secondary" onClick={() => void props.nameController.load()}>
              {_({ id: "settings.runtime.boss.name.retry", message: "Reload name" })}
            </Button>
          </Show>
        </Show>
      </SettingsSection>
      <SettingsSection title={_({ id: "settings.runtime.boss.conversation", message: "Colleague conversation" })}>
        <SettingRow
          title={_({ id: "settings.runtime.boss.conversation.open", message: "Conversation" })}
          description={_(openSessionRowDesc)}
          trailing={
            <Button
              type="button"
              variant="secondary"
              size="small"
              disabled={!enabled() || opening() || props.configDirty || props.nameController.dirty()}
              onClick={() => void handleOpenSession()}
            >
              {opening() ? _(openSessionBusy) : _(openSessionRowTitle)}
            </Button>
          }
        />
        <Show when={props.configDirty || props.nameController.dirty()}>
          <p class="ds-section-hint">
            {_({
              id: "settings.runtime.boss.saveFirst",
              message: "Save your changes before opening the Boss Mode session.",
            })}
          </p>
        </Show>
      </SettingsSection>
    </SettingsPage>
  )
}
