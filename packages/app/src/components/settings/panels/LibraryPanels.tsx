import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { Switch } from "@ericsanchezok/synergy-ui/switch"
import { SettingsStepScale, type SettingsStepOption } from "../components/SettingsStepScale"
import { SettingsPage, SettingsSection } from "../components/SettingsPrimitives"
import { SettingRow } from "../components/SettingRow"
import type { LibrarySettingsStore } from "../types"

const similarityOptions: SettingsStepOption[] = [
  { value: "0.5", label: "Broad", tickLabel: "0.5", detail: "Loose context match" },
  { value: "0.6", label: "Soft", tickLabel: "0.6", detail: "More context allowed" },
  { value: "0.7", label: "Balanced", tickLabel: "0.7", detail: "Default recall balance" },
  { value: "0.8", label: "Focused", tickLabel: "0.8", detail: "Close context only" },
  { value: "0.9", label: "Strict", tickLabel: "0.9", detail: "Very close matches" },
]

const memoryCountOptions: SettingsStepOption[] = [
  { value: "1", label: "Quiet", tickLabel: "1", detail: "Minimal recall" },
  { value: "2", label: "Lean", tickLabel: "2", detail: "Light recall" },
  { value: "3", label: "Balanced", tickLabel: "3", detail: "Default memory depth" },
  { value: "5", label: "More", tickLabel: "5", detail: "More context available" },
  { value: "8", label: "Full", tickLabel: "8", detail: "Maximum memory depth" },
]

const experienceCountOptions: SettingsStepOption[] = [
  { value: "3", label: "Lean", tickLabel: "3", detail: "Few past examples" },
  { value: "5", label: "Steady", tickLabel: "5", detail: "Moderate recall" },
  { value: "8", label: "Balanced", tickLabel: "8", detail: "Default experience depth" },
  { value: "10", label: "Deep", tickLabel: "10", detail: "More examples" },
  { value: "15", label: "Full", tickLabel: "15", detail: "Maximum experience depth" },
]

const explorationOptions: SettingsStepOption[] = [
  { value: "0", label: "Stable", tickLabel: "0", detail: "Always exploit known paths" },
  { value: "0.05", label: "Careful", tickLabel: "0.05", detail: "Rare exploration" },
  { value: "0.1", label: "Balanced", tickLabel: "0.1", detail: "Default exploration" },
  { value: "0.2", label: "Curious", tickLabel: "0.2", detail: "More alternatives" },
  { value: "0.3", label: "Exploratory", tickLabel: "0.3", detail: "Frequent alternatives" },
]

export function LearningPanel(props: {
  library: LibrarySettingsStore
  onLibraryChange: (key: keyof LibrarySettingsStore, value: string) => void
}) {
  return (
    <SettingsPage title="Learning" description="Decide how Synergy captures and maintains library knowledge.">
      <SettingsSection
        title="Capture"
        description="Keep the library useful without turning these controls into raw configuration."
      >
        <SettingRow
          title="Learn from interactions"
          description="Create and curate memories from useful conversation context."
          trailing={
            <>
              <span class="settings-row-state">{props.library.learning !== "false" ? "Learning" : "Paused"}</span>
              <Switch
                checked={props.library.learning !== "false"}
                hideLabel
                onChange={(value) => props.onLibraryChange("learning", value ? "true" : "false")}
              >
                Learn from interactions
              </Switch>
            </>
          }
        />
        <SettingRow
          title="Autonomous routines"
          description="Allow reflection and planning jobs to run quietly in the background."
          trailing={
            <>
              <span class="settings-row-state">{props.library.autonomy !== "false" ? "Automatic" : "Manual"}</span>
              <Switch
                checked={props.library.autonomy !== "false"}
                hideLabel
                onChange={(value) => props.onLibraryChange("autonomy", value ? "true" : "false")}
              >
                Autonomous routines
              </Switch>
            </>
          }
        />
      </SettingsSection>
    </SettingsPage>
  )
}

export function MemoryPanel(props: {
  library: LibrarySettingsStore
  onLibraryChange: (key: keyof LibrarySettingsStore, value: string) => void
}) {
  return (
    <SettingsPage title="Memory" description="Tune how Synergy recalls curated memory while you work.">
      <SettingsSection
        title="Recall"
        description="Adjust precision and volume for contextual memories that are brought into a session."
      >
        <SettingRow
          title="Match strictness"
          description="Higher values keep recalled memories closer to the current context."
          trailing={
            <SettingsStepScale
              value={props.library.memorySimThreshold}
              options={similarityOptions}
              lowLabel="Broader"
              highLabel="Stricter"
              ariaLabel="Memory match strictness"
              summary={(option) => `${option.label} ${option.value}`}
              onChange={(value) => props.onLibraryChange("memorySimThreshold", value)}
            />
          }
        />
        <SettingRow
          title="Memories per category"
          description="Limit how many memories each category can contribute."
          trailing={
            <SettingsStepScale
              value={props.library.memoryTopK}
              options={memoryCountOptions}
              lowLabel="Less context"
              highLabel="More context"
              ariaLabel="Memories per category"
              summary={(option) => `${option.label} ${option.value}`}
              onChange={(value) => props.onLibraryChange("memoryTopK", value)}
            />
          }
        />
      </SettingsSection>
    </SettingsPage>
  )
}

export function ExperiencePanel(props: {
  library: LibrarySettingsStore
  onLibraryChange: (key: keyof LibrarySettingsStore, value: string) => void
}) {
  return (
    <SettingsPage title="Experience" description="Tune how Synergy reuses past task patterns and tries alternatives.">
      <SettingsSection title="Retrieval" description="Choose how many past patterns should influence future work.">
        <SettingRow
          title="Match strictness"
          description="Higher values keep recalled experiences closer to the current task."
          trailing={
            <SettingsStepScale
              value={props.library.experienceSimThreshold}
              options={similarityOptions}
              lowLabel="Broader"
              highLabel="Stricter"
              ariaLabel="Experience match strictness"
              summary={(option) => `${option.label} ${option.value}`}
              onChange={(value) => props.onLibraryChange("experienceSimThreshold", value)}
            />
          }
        />
        <SettingRow
          title="Experiences to recall"
          description="Set how many past examples can be considered at once."
          trailing={
            <SettingsStepScale
              value={props.library.experienceTopK}
              options={experienceCountOptions}
              lowLabel="Fewer"
              highLabel="More"
              ariaLabel="Experiences to recall"
              summary={(option) => `${option.label} ${option.value}`}
              onChange={(value) => props.onLibraryChange("experienceTopK", value)}
            />
          }
        />
      </SettingsSection>
      <SettingsSection title="Exploration" description="Control how often Synergy tries a less familiar path.">
        <SettingRow
          title="Exploration rate"
          description="Chance of exploring alternatives instead of using the best-known pattern."
          trailing={
            <SettingsStepScale
              value={props.library.experienceEpsilon}
              options={explorationOptions}
              lowLabel="Stable"
              highLabel="Exploratory"
              ariaLabel="Experience exploration rate"
              summary={(option) => `${option.label} ${option.value}`}
              onChange={(value) => props.onLibraryChange("experienceEpsilon", value)}
            />
          }
        />
      </SettingsSection>
    </SettingsPage>
  )
}
