import { Show } from "solid-js"
import { SettingRow } from "../components/SettingRow"
import { SectionLabel } from "../components/SectionLabel"
import { SegmentPill } from "../components/SegmentPill"
import type { LibrarySettingsStore } from "../types"

export function LibrarySettingsPanel(props: {
  library: LibrarySettingsStore
  onLibraryChange: (key: keyof LibrarySettingsStore, value: string) => void
}) {
  return (
    <div class="ds-content-inner">
      <h1 class="ds-content-title">Library</h1>

      <div class="ds-setting-section">
        <SectionLabel title="Learning" />
        <p class="ds-section-hint">Passive experience learning + active memory curation.</p>
        <SettingRow
          title="Enable Learning"
          description="Continuously learn from interactions and curate memories"
          trailing={
            <SegmentPill
              value={props.library.learning}
              options={[
                { value: "true", label: "On" },
                { value: "false", label: "Off" },
              ]}
              onChange={(value) => props.onLibraryChange("learning", value)}
              showReset
              defaultValue="true"
              onReset={() => props.onLibraryChange("learning", "true")}
            />
          }
        />
        <Show when={props.library.learning === "true"}>
          <div class="ds-setting-subsection">
            <h3 class="ds-subsection-title">Recall Tuning</h3>
            <p class="ds-section-hint">Control how memories and experiences are injected into conversations.</p>
            <SettingRow
              title="Memory Similarity"
              description="Minimum cosine similarity for contextual memory (default 0.7)"
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
              description="Max contextual memories per category (default 3)"
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
            <SettingRow
              title="Experience Similarity"
              description="Minimum cosine similarity for experience retrieval (default 0.7)"
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
              description="Number of past experiences to retrieve (default 8)"
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
              description="ε-greedy probability for experience exploration (default 0.1)"
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
          </div>
        </Show>
      </div>

      <div class="ds-setting-section">
        <SectionLabel title="Autonomy" />
        <SettingRow
          title="Enable Autonomy"
          description="Autonomous background routines like daily self-reflection and agenda planning"
          trailing={
            <SegmentPill
              value={props.library.autonomy}
              options={[
                { value: "true", label: "On" },
                { value: "false", label: "Off" },
              ]}
              onChange={(value) => props.onLibraryChange("autonomy", value)}
              showReset
              defaultValue="true"
              onReset={() => props.onLibraryChange("autonomy", "true")}
            />
          }
        />
      </div>
    </div>
  )
}
