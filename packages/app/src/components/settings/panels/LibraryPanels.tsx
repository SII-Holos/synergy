import { For, type JSX } from "solid-js"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon, type SemanticIconTokenName } from "@ericsanchezok/synergy-ui/semantic-icon"
import { Switch } from "@ericsanchezok/synergy-ui/switch"
import { SettingsPage } from "../components/SettingsPrimitives"
import type { LibrarySettingsStore } from "../types"

type StepOption = {
  value: string
  label: string
  tone: string
}

const similarityOptions: StepOption[] = [
  { value: "0.5", label: "Broad", tone: "Loose context match" },
  { value: "0.6", label: "Soft", tone: "More context allowed" },
  { value: "0.7", label: "Balanced", tone: "Default recall balance" },
  { value: "0.8", label: "Focused", tone: "Close context only" },
  { value: "0.9", label: "Strict", tone: "Very close matches" },
]

const memoryCountOptions: StepOption[] = [
  { value: "1", label: "Quiet", tone: "Minimal recall" },
  { value: "2", label: "Lean", tone: "Light recall" },
  { value: "3", label: "Balanced", tone: "Default memory depth" },
  { value: "5", label: "More", tone: "More context available" },
  { value: "8", label: "Full", tone: "Maximum memory depth" },
]

const experienceCountOptions: StepOption[] = [
  { value: "3", label: "Lean", tone: "Few past examples" },
  { value: "5", label: "Steady", tone: "Moderate recall" },
  { value: "8", label: "Balanced", tone: "Default experience depth" },
  { value: "10", label: "Deep", tone: "More examples" },
  { value: "15", label: "Full", tone: "Maximum experience depth" },
]

const explorationOptions: StepOption[] = [
  { value: "0", label: "Stable", tone: "Always exploit known paths" },
  { value: "0.05", label: "Careful", tone: "Rare exploration" },
  { value: "0.1", label: "Balanced", tone: "Default exploration" },
  { value: "0.2", label: "Curious", tone: "More alternatives" },
  { value: "0.3", label: "Exploratory", tone: "Frequent alternatives" },
]

export function LearningPanel(props: {
  library: LibrarySettingsStore
  onLibraryChange: (key: keyof LibrarySettingsStore, value: string) => void
}) {
  return (
    <SettingsPage title="Learning" description="Decide how Synergy captures and maintains library knowledge.">
      <div class="settings-library-shell">
        <LibrarySection
          title="Capture"
          description="Keep the library useful without turning these controls into raw configuration."
        >
          <LibrarySwitchRow
            iconToken="settings.learning"
            title="Learn from interactions"
            description="Create and curate memories from useful conversation context."
            checked={props.library.learning !== "false"}
            onChange={(value) => props.onLibraryChange("learning", value ? "true" : "false")}
            onLabel="Learning"
            offLabel="Paused"
          />
          <LibrarySwitchRow
            iconToken="settings.experience"
            title="Autonomous routines"
            description="Allow reflection and planning jobs to run quietly in the background."
            checked={props.library.autonomy !== "false"}
            onChange={(value) => props.onLibraryChange("autonomy", value ? "true" : "false")}
            onLabel="Automatic"
            offLabel="Manual"
          />
        </LibrarySection>
      </div>
    </SettingsPage>
  )
}

export function MemoryPanel(props: {
  library: LibrarySettingsStore
  onLibraryChange: (key: keyof LibrarySettingsStore, value: string) => void
}) {
  return (
    <SettingsPage title="Memory" description="Tune how Synergy recalls curated memory while you work.">
      <div class="settings-library-shell">
        <LibrarySection
          title="Recall"
          description="Adjust precision and volume for contextual memories that are brought into a session."
        >
          <LibraryStepRow
            title="Match strictness"
            description="Higher values keep recalled memories closer to the current context."
            value={props.library.memorySimThreshold}
            defaultValue="0.7"
            options={similarityOptions}
            lowLabel="Broader"
            highLabel="Stricter"
            ariaLabel="Memory match strictness"
            onChange={(value) => props.onLibraryChange("memorySimThreshold", value)}
          />
          <LibraryStepRow
            title="Memories per category"
            description="Limit how many memories each category can contribute."
            value={props.library.memoryTopK}
            defaultValue="3"
            options={memoryCountOptions}
            lowLabel="Less context"
            highLabel="More context"
            ariaLabel="Memories per category"
            onChange={(value) => props.onLibraryChange("memoryTopK", value)}
          />
        </LibrarySection>
      </div>
    </SettingsPage>
  )
}

export function ExperiencePanel(props: {
  library: LibrarySettingsStore
  onLibraryChange: (key: keyof LibrarySettingsStore, value: string) => void
}) {
  return (
    <SettingsPage title="Experience" description="Tune how Synergy reuses past task patterns and tries alternatives.">
      <div class="settings-library-shell">
        <LibrarySection title="Retrieval" description="Choose how many past patterns should influence future work.">
          <LibraryStepRow
            title="Match strictness"
            description="Higher values keep recalled experiences closer to the current task."
            value={props.library.experienceSimThreshold}
            defaultValue="0.7"
            options={similarityOptions}
            lowLabel="Broader"
            highLabel="Stricter"
            ariaLabel="Experience match strictness"
            onChange={(value) => props.onLibraryChange("experienceSimThreshold", value)}
          />
          <LibraryStepRow
            title="Experiences to recall"
            description="Set how many past examples can be considered at once."
            value={props.library.experienceTopK}
            defaultValue="8"
            options={experienceCountOptions}
            lowLabel="Fewer"
            highLabel="More"
            ariaLabel="Experiences to recall"
            onChange={(value) => props.onLibraryChange("experienceTopK", value)}
          />
        </LibrarySection>

        <LibrarySection title="Exploration" description="Control how often Synergy tries a less familiar path.">
          <LibraryStepRow
            title="Exploration rate"
            description="Chance of exploring alternatives instead of using the best-known pattern."
            value={props.library.experienceEpsilon}
            defaultValue="0.1"
            options={explorationOptions}
            lowLabel="Stable"
            highLabel="Exploratory"
            ariaLabel="Experience exploration rate"
            onChange={(value) => props.onLibraryChange("experienceEpsilon", value)}
          />
        </LibrarySection>
      </div>
    </SettingsPage>
  )
}

function LibrarySection(props: { title: string; description: string; children: JSX.Element }) {
  return (
    <section class="settings-library-section">
      <div class="settings-library-section-heading">
        <h2>{props.title}</h2>
        <p>{props.description}</p>
      </div>
      <div class="settings-library-list">{props.children}</div>
    </section>
  )
}

function LibrarySwitchRow(props: {
  iconToken: SemanticIconTokenName
  title: string
  description: string
  checked: boolean
  onChange: (checked: boolean) => void
  onLabel: string
  offLabel: string
}) {
  return (
    <div class="settings-library-row settings-library-toggle-row">
      <div class="settings-library-copy">
        <span class="settings-library-row-icon">
          <Icon name={getSemanticIcon(props.iconToken)} size="small" />
        </span>
        <div class="min-w-0">
          <div class="settings-library-row-title">{props.title}</div>
          <div class="settings-library-row-description">{props.description}</div>
        </div>
      </div>
      <div class="settings-library-toggle-control">
        <span class="settings-library-state">{props.checked ? props.onLabel : props.offLabel}</span>
        <Switch checked={props.checked} hideLabel onChange={props.onChange}>
          {props.title}
        </Switch>
      </div>
    </div>
  )
}

function LibraryStepRow(props: {
  title: string
  description: string
  value: string
  defaultValue: string
  options: StepOption[]
  lowLabel: string
  highLabel: string
  ariaLabel: string
  onChange: (value: string) => void
}) {
  const current = () => props.options.find((option) => option.value === props.value)
  const isCustom = () => !current()

  return (
    <div class="settings-library-row">
      <div class="settings-library-copy settings-library-copy-plain">
        <div class="settings-library-row-title">{props.title}</div>
        <div class="settings-library-row-description">{props.description}</div>
      </div>
      <div class="settings-library-step-control">
        <div class="settings-library-step-summary">
          <span class="settings-library-step-value">
            {current() ? `${current()?.label} ${current()?.value}` : `Custom ${props.value}`}
          </span>
          <button
            type="button"
            class="settings-library-reset"
            disabled={props.value === props.defaultValue}
            onClick={() => props.onChange(props.defaultValue)}
          >
            Reset
          </button>
        </div>
        <div class="settings-library-step-track" role="radiogroup" aria-label={props.ariaLabel}>
          <For each={props.options}>
            {(option) => (
              <button
                type="button"
                role="radio"
                aria-checked={props.value === option.value}
                aria-label={`${props.ariaLabel}: ${option.label} ${option.value}`}
                title={option.tone}
                class="settings-library-step"
                classList={{ "settings-library-step-active": props.value === option.value }}
                onClick={() => props.onChange(option.value)}
              >
                {option.value}
              </button>
            )}
          </For>
        </div>
        <div class="settings-library-step-range" classList={{ "settings-library-step-range-custom": isCustom() }}>
          <span>{props.lowLabel}</span>
          <span>{current()?.tone ?? "Choose a preset to return to the guided range"}</span>
          <span>{props.highLabel}</span>
        </div>
      </div>
    </div>
  )
}
