import { useLingui } from "@lingui/solid"
import { For, Show, onCleanup, onMount } from "solid-js"
import { TextField } from "@ericsanchezok/synergy-ui/text-field"
import { Switch } from "@ericsanchezok/synergy-ui/switch"
import { showToast } from "@ericsanchezok/synergy-ui/toast"
import { useGlobalSDK } from "@/context/global-sdk"
import { requestErrorMessage } from "@/utils/error"
import { SettingRow } from "../components/SettingRow"
import { SegmentPill } from "../components/SegmentPill"
import { SettingsPage, SettingsSection } from "../components/SettingsPrimitives"
import type { RuntimeStore } from "../types"
import { bossNameFromRows, saveBossName, type BossNameGateway } from "./boss-name-model"
import type { MessageDescriptor } from "@lingui/core"

const NAME_SAVE_DEBOUNCE_MS = 600

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
const personalityRowTitle = { id: "settings.runtime.boss.personality", message: "Personality" }
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
const nameRowTitle = { id: "settings.runtime.boss.name", message: "Name" }
const nameRowDesc = {
  id: "settings.runtime.boss.name.desc",
  message: "The name your boss colleague will use.",
}
const namePlaceholder = { id: "settings.runtime.boss.name.placeholder", message: "e.g. Xiaofei" }
const nameSaveFailed = { id: "settings.runtime.boss.name.saveFailed", message: "Could not save boss name" }
const nameSaveFailedDesc = {
  id: "settings.runtime.boss.name.saveFailed.desc",
  message: "The boss name could not be saved. Please try again.",
}

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
  /** Test seam: fixtures inject a stub so they do not need the GlobalSDK provider stack. */
  bossNameGateway?: BossNameGateway
}) {
  const { _ } = useLingui()
  const enabled = () => props.runtime.bossMode === "true"
  const preset = () => props.runtime.bossPersonaPreset

  // Production callers mount under GlobalSDKProvider; the read happens during
  // render so the context owner is available. Fixtures pass a gateway stub.
  const sdkClient = props.bossNameGateway ? undefined : useGlobalSDK().client
  const gateway = (): BossNameGateway => {
    if (props.bossNameGateway) return props.bossNameGateway
    const client = sdkClient
    if (!client) throw new Error("BossModePanel requires GlobalSDK context or a bossNameGateway")
    return {
      listSelfMemories: async () => (await client.library.list({ category: "self" })).data ?? [],
      createMemory: (input) => client.library.memory.create(input),
      updateMemory: (input) => client.library.memory.update(input),
    }
  }

  let saveTimer: ReturnType<typeof setTimeout> | undefined
  let pendingName = ""
  let lastSavedName = ""

  const reportNameSaveFailure = (error: unknown) => {
    try {
      showToast({
        type: "error",
        title: _(nameSaveFailed),
        description: requestErrorMessage(error, _(nameSaveFailedDesc)),
      })
    } catch {
      // The toast host may be absent in embedded test harnesses; keep the
      // failure visible in the console instead of swallowing it silently.
      console.warn(_(nameSaveFailed), error)
    }
  }

  // Persist whatever draft is pending. The captured value (not the live store)
  // is written so a config-save re-init that resets bossName cannot drop a
  // draft that was still inside the debounce window.
  const persistPendingName = async () => {
    const content = pendingName.trim()
    if (!content || content === lastSavedName) return
    try {
      await saveBossName(gateway(), content)
      lastSavedName = content
      // bossName is not config, so a form re-init may have cleared the field;
      // re-assert the persisted value so the input stays in sync.
      if (!props.runtime.bossName.trim()) props.onRuntimeChange("bossName", content)
    } catch (error) {
      reportNameSaveFailure(error)
    }
  }
  const flushPendingName = () => {
    if (saveTimer) {
      clearTimeout(saveTimer)
      saveTimer = undefined
    }
    void persistPendingName()
  }
  const handleNameChange = (value: string) => {
    pendingName = value
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(flushPendingName, NAME_SAVE_DEBOUNCE_MS)
    props.onRuntimeChange("bossName", value)
  }

  onMount(() => {
    void (async () => {
      try {
        const name = bossNameFromRows(await gateway().listSelfMemories())
        if (name && !props.runtime.bossName.trim()) {
          props.onRuntimeChange("bossName", name)
          lastSavedName = name
        }
      } catch {
        // Reading the stored name is a convenience; leave the field blank on
        // failure so the rest of the panel still works.
      }
    })()
  })

  onCleanup(() => {
    if (saveTimer) {
      clearTimeout(saveTimer)
      saveTimer = undefined
    }
    // Never drop a debounced draft when the panel unmounts (tab switch, save
    // re-init): persist whatever was still pending.
    if (pendingName.trim() && pendingName.trim() !== lastSavedName) void persistPendingName()
  })

  return (
    <SettingsPage title={_(bossPageTitle)} description={_(bossPageDesc)}>
      <SettingsSection>
        <SettingRow
          title={_(bossPageTitle)}
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
              value={props.runtime.bossName}
              placeholder={_(namePlaceholder)}
              disabled={!enabled()}
              class="settings-row-control-text"
              onChange={handleNameChange}
              onBlur={() => void flushPendingName()}
            />
          }
        />
      </SettingsSection>
    </SettingsPage>
  )
}
