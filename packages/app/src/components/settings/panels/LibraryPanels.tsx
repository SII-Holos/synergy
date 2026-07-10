import { createSignal, Show, For, createMemo } from "solid-js"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { Switch } from "@ericsanchezok/synergy-ui/switch"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { SettingsSubsection } from "../components/SettingsPrimitives"
import { SettingsStepScale, type SettingsStepOption } from "../components/SettingsStepScale"
import { SettingsPage, SettingsSection } from "../components/SettingsPrimitives"
import { SettingRow } from "../components/SettingRow"
import { useGlobalSDK } from "@/context/global-sdk"
import type { ExperienceDetectResult, ExperienceDetectGroup } from "@ericsanchezok/synergy-sdk/client"
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

// ── Encoding Health ─────────────────────────────────────────────────────────

function relativeTime(ts: number): string {
  const delta = Math.floor((Date.now() - ts) / 1000)
  if (delta < 60) return "just now"
  if (delta < 3600) return `${Math.floor(delta / 60)} min ago`
  if (delta < 86400) return `${Math.floor(delta / 3600)} hr ago`
  return `${Math.floor(delta / 86400)} d ago`
}

function estimateDuration(count: number): string {
  const secs = Math.ceil((count * 2) / 5)
  if (secs < 60) return `~${count} LLM calls, ~${secs} seconds`
  return `~${count} LLM calls, ~${Math.ceil(secs / 60)}-${Math.ceil(secs / 60) + 1} minutes`
}

function EncodingHealthSection() {
  const globalSDK = useGlobalSDK()

  const [scanning, setScanning] = createSignal(false)
  const [result, setResult] = createSignal<ExperienceDetectResult | null>(null)
  const [reencoding, setReencoding] = createSignal<{
    kind: "intent" | "script"
    reason?: string
    total: number
    completed: number
    ok: number
    skipped: number
    failed: number
    aborter: AbortController
  } | null>(null)
  const [reencodeDone, setReencodeDone] = createSignal<{ ok: number; skipped: number; failed: number } | null>(null)

  const hasIssues = createMemo(() => {
    const r = result()
    if (!r) return false
    return r.intent.total > 0 || r.script.total > 0
  })

  async function handleScan() {
    setScanning(true)
    setReencodeDone(null)
    try {
      const res = await globalSDK.client.library.experience.detect()
      if (res.error) throw res.error
      setResult(res.data)
    } catch {
      // scan fails silently — button re-enabled
    } finally {
      setScanning(false)
    }
  }

  async function handleReencode(kind: "intent" | "script", reason?: string) {
    const active = reencoding()
    if (active) return
    if (!window.confirm(`Re-encode all ${kind} records? This will make LLM calls and may take several minutes.`)) return

    const aborter = new AbortController()
    const reenc = {
      kind,
      reason,
      total: 0,
      completed: 0,
      ok: 0,
      skipped: 0,
      failed: 0,
      aborter,
    }
    setReencoding(reenc)
    setReencodeDone(null)

    try {
      const sseResult = await globalSDK.client.library.experience.reencode(
        { type: kind, reason },
        {
          signal: aborter.signal,
          parseAs: "stream",
          onSseEvent: (event) => {
            const d = event.data as Record<string, unknown>
            if (d.type === "start" && typeof d.total === "number") {
              setReencoding((prev) => (prev ? { ...prev, total: d.total as number } : prev))
            } else if (d.type === "progress" && typeof d.completed === "number") {
              setReencoding((prev) => {
                if (!prev) return prev
                const status = d.status as string
                return {
                  ...prev,
                  completed: d.completed as number,
                  ok: prev.ok + (status === "ok" ? 1 : 0),
                  skipped: prev.skipped + (status === "skipped" ? 1 : 0),
                  failed: prev.failed + (status === "failed" ? 1 : 0),
                }
              })
            } else if (d.type === "done") {
              setReencodeDone({
                ok: (d.ok as number) ?? 0,
                skipped: (d.skipped as number) ?? 0,
                failed: (d.failed as number) ?? 0,
              })
              setReencoding(null)
            } else if (d.type === "error") {
              throw new Error((d.message as string) ?? "Re-encode failed")
            }
          },
        },
      )
      for await (const _ of sseResult.stream) {
        // no-op: onSseEvent handles progress
      }
    } catch {
      setReencoding(null)
    }
  }

  function handleCancel() {
    reencoding()?.aborter.abort()
    setReencoding(null)
  }

  return (
    <SettingsSection
      title="Encoding Health"
      description="Scan the database for records whose intent or script may not have been properly encoded."
    >
      {/* Overview bar */}
      <div class="usage-overview">
        <div class="usage-overview-metrics">
          <div class="usage-overview-metric">
            <span class="usage-overview-value">{result()?.intent.total ?? "—"}</span>
            <span class="usage-overview-label">Intent issues</span>
          </div>
          <div class="usage-overview-metric">
            <span class="usage-overview-value">{result()?.script.total ?? "—"}</span>
            <span class="usage-overview-label">Script issues</span>
          </div>
          <div class="usage-overview-metric">
            <span class="usage-overview-value usage-overview-date">
              {result() ? relativeTime(result()!.scannedAt) : "Not scanned yet"}
            </span>
            <span class="usage-overview-label">Last scanned</span>
          </div>
        </div>
        <div class="usage-overview-actions">
          <Button
            type="button"
            variant={result() ? "secondary" : "primary"}
            size="small"
            icon={getSemanticIcon(scanning() ? "action.refresh" : "action.search")}
            disabled={scanning() || reencoding() !== null}
            onClick={handleScan}
          >
            {scanning() ? "Scanning…" : "Scan Now"}
          </Button>
        </div>
      </div>

      {/* Re-encode progress bar */}
      <Show when={reencoding()}>
        {(reenc) => {
          const pct = reenc().total > 0 ? Math.round((reenc().completed / reenc().total) * 100) : 0
          return (
            <SettingsSubsection title={`Re-encoding ${reenc().kind} records…`}>
              <div class="usage-window-meter" style="margin-bottom: 8px;">
                <span style={{ width: `${pct}%` }} />
              </div>
              <div style="display:flex; justify-content:space-between; align-items:center;">
                <div style="gap:12px; display:flex;">
                  <span class="usage-overview-label">
                    {reenc().completed} / {reenc().total}
                  </span>
                  <span class="usage-overview-label">Updated: {reenc().ok}</span>
                  <span class="usage-overview-label">Skipped: {reenc().skipped}</span>
                  <span class="usage-overview-label">Failed: {reenc().failed}</span>
                </div>
                <Button type="button" variant="ghost" size="small" onClick={handleCancel}>
                  Cancel
                </Button>
              </div>
            </SettingsSubsection>
          )
        }}
      </Show>

      {/* Re-encode done message */}
      <Show when={reencodeDone()}>
        {(done) => (
          <div class="ds-setting-subsection" style={{ color: "var(--icon-success-base)" }}>
            <span>
              Complete: {done().ok} updated, {done().skipped} skipped, {done().failed} failed
            </span>
          </div>
        )}
      </Show>

      {/* No issues message */}
      <Show when={!reencoding() && result() && !hasIssues()}>
        <div
          class="ds-setting-subsection"
          style={{ color: "var(--icon-success-base)", "font-weight": "var(--font-weight-medium)" }}
        >
          All experience records are healthy.
        </div>
      </Show>

      {/* Issue group cards */}
      <Show when={!reencoding() && result() && hasIssues()}>
        <ExperienceGroupCards
          kind="intent"
          groups={result()!.intent.groups}
          disabled={reencoding() !== null || scanning()}
          onReencode={(reason) => handleReencode("intent", reason)}
        />
        <ExperienceGroupCards
          kind="script"
          groups={result()!.script.groups}
          disabled={reencoding() !== null || scanning()}
          onReencode={(reason) => handleReencode("script", reason)}
        />
      </Show>
    </SettingsSection>
  )
}

function ExperienceGroupCards(props: {
  kind: "intent" | "script"
  groups: ExperienceDetectGroup[]
  disabled: boolean
  onReencode: (reason?: string) => void
}) {
  if (props.groups.length === 0) return null

  const title = props.kind === "intent" ? "Intent Issues" : "Script Issues"
  const total = props.groups.reduce((sum, g) => sum + g.count, 0)

  return (
    <SettingsSubsection title={title}>
      <For each={props.groups}>
        {(group) => {
          const [expanded, setExpanded] = createSignal(false)
          return (
            <div style={{ "margin-bottom": "10px" }}>
              <div style={{ display: "flex", "align-items": "center", "justify-content": "space-between" }}>
                <div>
                  <span class="usage-overview-value" style={{ "font-size": "var(--settings-type-body-size)" }}>
                    {group.label}
                  </span>
                  <span class="usage-overview-label" style={{ "margin-left": "8px" }}>
                    {group.count.toLocaleString()}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => setExpanded((v) => !v)}
                  style={{
                    background: "none",
                    border: "none",
                    cursor: "pointer",
                    color: "var(--text-weaker)",
                    "font-size": "var(--settings-type-caption-size)",
                  }}
                >
                  <Show when={group.samples.length > 0}>{expanded() ? "▾ Hide samples" : "▸ Show samples"}</Show>
                </button>
              </div>
              <Show when={expanded() && group.samples.length > 0}>
                <div
                  style={{
                    "margin-top": "6px",
                    "padding-left": "8px",
                    "border-left": "1px solid var(--settings-border)",
                  }}
                >
                  <For each={group.samples}>
                    {(sample) => (
                      <div style={{ "margin-bottom": "4px" }}>
                        <span
                          class="usage-overview-label"
                          style={{ "font-family": "var(--font-mono)", "font-size": "11px" }}
                        >
                          {sample.id.slice(0, 12)}…
                        </span>
                        <span class="usage-overview-label" style={{ "margin-left": "8px" }}>
                          {sample.detail}
                        </span>
                        <Show when={sample.preview}>
                          <div class="usage-overview-label" style={{ "font-size": "11px", opacity: 0.7 }}>
                            {sample.preview}
                          </div>
                        </Show>
                      </div>
                    )}
                  </For>
                </div>
              </Show>
            </div>
          )
        }}
      </For>
      <div style={{ "margin-top": "12px" }}>
        <Button
          type="button"
          variant="secondary"
          size="small"
          disabled={props.disabled}
          onClick={() => props.onReencode(undefined)}
        >
          Re-encode {props.kind} for all {total.toLocaleString()} records
        </Button>
        <span class="usage-overview-label" style={{ "margin-left": "8px" }}>
          Estimated: {estimateDuration(total)}
        </span>
      </div>
    </SettingsSubsection>
  )
}

// ── Experience Panel ─────────────────────────────────────────────────────────

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
      <EncodingHealthSection />
    </SettingsPage>
  )
}
