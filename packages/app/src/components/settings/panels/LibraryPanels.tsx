import { SettingRow } from "../components/SettingRow"
import { SegmentPill } from "../components/SegmentPill"
import { SettingsPage, SettingsSection } from "../components/SettingsPrimitives"
import type { LibrarySettingsStore } from "../types"

export function LearningPanel(props: {
  library: LibrarySettingsStore
  onLibraryChange: (key: keyof LibrarySettingsStore, value: string) => void
}) {
  return (
    <SettingsPage title="Learning" description="Library learning and autonomy controls.">
      <SettingsSection title="Learning">
        <SettingRow
          title="Enable Learning"
          description="Continuously learn from interactions and curate memories"
          trailing={
            <BooleanPill
              value={props.library.learning}
              defaultValue="true"
              onChange={(value) => props.onLibraryChange("learning", value)}
            />
          }
        />
        <SettingRow
          title="Enable Autonomy"
          description="Run background routines such as reflection and agenda planning"
          trailing={
            <BooleanPill
              value={props.library.autonomy}
              defaultValue="true"
              onChange={(value) => props.onLibraryChange("autonomy", value)}
            />
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
    <SettingsPage title="Memory" description="Memory retrieval and embedding controls.">
      <SettingsSection title="Retrieval">
        <SettingRow
          title="Memory Similarity"
          description="Minimum cosine similarity for contextual memory"
          trailing={
            <SegmentPill
              value={props.library.memorySimThreshold}
              options={[
                { value: "0.5", label: "0.5" },
                { value: "0.6", label: "0.6" },
                { value: "0.7", label: "0.7" },
                { value: "0.8", label: "0.8" },
                { value: "0.9", label: "0.9" },
              ]}
              onChange={(value) => props.onLibraryChange("memorySimThreshold", value)}
              showReset
              defaultValue="0.7"
              onReset={() => props.onLibraryChange("memorySimThreshold", "0.7")}
            />
          }
        />
        <SettingRow
          title="Memory per Category"
          description="Max contextual memories per category"
          trailing={
            <SegmentPill
              value={props.library.memoryTopK}
              options={[
                { value: "1", label: "1" },
                { value: "2", label: "2" },
                { value: "3", label: "3" },
                { value: "5", label: "5" },
                { value: "8", label: "8" },
              ]}
              onChange={(value) => props.onLibraryChange("memoryTopK", value)}
              showReset
              defaultValue="3"
              onReset={() => props.onLibraryChange("memoryTopK", "3")}
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
    <SettingsPage title="Experience" description="Experience retrieval and exploration controls.">
      <SettingsSection title="Retrieval">
        <SettingRow
          title="Experience Similarity"
          description="Minimum cosine similarity for experience retrieval"
          trailing={
            <SegmentPill
              value={props.library.experienceSimThreshold}
              options={[
                { value: "0.5", label: "0.5" },
                { value: "0.6", label: "0.6" },
                { value: "0.7", label: "0.7" },
                { value: "0.8", label: "0.8" },
                { value: "0.9", label: "0.9" },
              ]}
              onChange={(value) => props.onLibraryChange("experienceSimThreshold", value)}
              showReset
              defaultValue="0.7"
              onReset={() => props.onLibraryChange("experienceSimThreshold", "0.7")}
            />
          }
        />
        <SettingRow
          title="Experience Count"
          description="Number of past experiences to retrieve"
          trailing={
            <SegmentPill
              value={props.library.experienceTopK}
              options={[
                { value: "3", label: "3" },
                { value: "5", label: "5" },
                { value: "8", label: "8" },
                { value: "10", label: "10" },
                { value: "15", label: "15" },
              ]}
              onChange={(value) => props.onLibraryChange("experienceTopK", value)}
              showReset
              defaultValue="8"
              onReset={() => props.onLibraryChange("experienceTopK", "8")}
            />
          }
        />
        <SettingRow
          title="Exploration Rate"
          description="Epsilon-greedy probability for experience exploration"
          trailing={
            <SegmentPill
              value={props.library.experienceEpsilon}
              options={[
                { value: "0", label: "0" },
                { value: "0.05", label: "0.05" },
                { value: "0.1", label: "0.1" },
                { value: "0.2", label: "0.2" },
                { value: "0.3", label: "0.3" },
              ]}
              onChange={(value) => props.onLibraryChange("experienceEpsilon", value)}
              showReset
              defaultValue="0.1"
              onReset={() => props.onLibraryChange("experienceEpsilon", "0.1")}
            />
          }
        />
      </SettingsSection>
    </SettingsPage>
  )
}

function BooleanPill(props: { value: string; defaultValue: string; onChange: (value: string) => void }) {
  return (
    <SegmentPill
      value={props.value}
      options={[
        { value: "true", label: "On" },
        { value: "false", label: "Off" },
      ]}
      onChange={props.onChange}
      showReset
      defaultValue={props.defaultValue}
      onReset={() => props.onChange(props.defaultValue)}
    />
  )
}
