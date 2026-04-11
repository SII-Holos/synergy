import { createMemo, createResource, createSignal, For, Show } from "solid-js"
import { Popover } from "@kobalte/core/popover"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { Spinner } from "@ericsanchezok/synergy-ui/spinner"
import { showToast } from "@ericsanchezok/synergy-ui/toast"
import { createSynergyClient } from "@ericsanchezok/synergy-sdk/client"
import { useGlobalSDK } from "@/context/global-sdk"
import { usePlatform } from "@/context/platform"
import { Panel } from "@/components/panel"
import type { SkillList } from "@ericsanchezok/synergy-sdk/client"

type SkillScope = "all" | "project" | "global" | "builtin"
type SkillItem = SkillList["items"][number]
type SkillDiagnostic = SkillList["diagnostics"][number]
type SkillListData = SkillList

export function SkillView(props: {
  sdk: ReturnType<typeof useGlobalSDK>
  search: string
  directory?: string
  onRegisterRefetch: (fn: () => void) => void
}) {
  const platform = usePlatform()
  const scopedClient = createMemo(() => {
    if (!props.directory) return props.sdk.client
    return createSynergyClient({
      baseUrl: props.sdk.url,
      fetch: platform.fetch,
      directory: props.directory,
      throwOnError: true,
    })
  })
  const [filter, setFilter] = createSignal<SkillScope>("all")
  const [reloading, setReloading] = createSignal(false)
  const [expandedCards, setExpandedCards] = createSignal<Set<string>>(new Set())
  const [diagnosticsExpanded, setDiagnosticsExpanded] = createSignal(false)

  const [skills, { refetch }] = createResource<SkillListData>(async () => {
    const result = await scopedClient().skill.list()
    return (result.data as SkillListData | undefined) ?? { items: [], diagnostics: [] }
  })

  props.onRegisterRefetch(() => refetch())

  async function reloadSkills() {
    setReloading(true)
    try {
      await scopedClient().skill.reload()
      await refetch()
      showToast({ title: "Skills reloaded", description: "Skill directories rescanned" })
    } catch {
      showToast({ title: "Failed to reload skills" })
    }
    setReloading(false)
  }

  const filtered = createMemo(() => {
    let list = skills()?.items ?? []
    const f = filter()
    if (f !== "all") {
      list = list.filter((s) => s.scope === f)
    }
    const q = props.search.toLowerCase().trim()
    if (q) {
      list = list.filter((s) => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q))
    }
    return list
  })

  const diagnostics = createMemo(() => skills()?.diagnostics ?? [])

  const scopeCounts = createMemo(() => {
    const counts = { project: 0, global: 0, builtin: 0 }
    for (const s of skills()?.items ?? []) {
      const scope = s.scope
      if (scope === "project") counts.project++
      else if (scope === "global") counts.global++
      else if (scope === "builtin") counts.builtin++
    }
    return counts
  })

  function toggleCard(name: string) {
    setExpandedCards((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }

  async function deleteSkill(name: string, e: MouseEvent) {
    e.stopPropagation()
    try {
      await scopedClient().skill.remove({ name })
      setExpandedCards((prev) => {
        const next = new Set(prev)
        next.delete(name)
        return next
      })
      await refetch()
      showToast({ title: "Skill deleted", description: `Removed "${name}" from disk` })
    } catch {
      showToast({ title: "Failed to delete skill" })
    }
  }

  const [importOpen, setImportOpen] = createSignal(false)
  const [importMode, setImportMode] = createSignal<"menu" | "url">("menu")
  const [importUrl, setImportUrl] = createSignal("")
  const [importing, setImporting] = createSignal(false)
  let fileInputRef!: HTMLInputElement

  function resetImport() {
    setImportMode("menu")
    setImportUrl("")
    setImporting(false)
  }

  async function handleFileImport(file: File, scope: "project" | "global" = "global") {
    setImporting(true)
    setImportOpen(false)
    try {
      const result = await scopedClient().skill.import({ file, scope })
      await refetch()
      const data = result.data as any
      showToast({ title: "Skill imported", description: `"${data?.name}" added to ${data?.scope ?? scope}` })
    } catch {
      showToast({ title: "Import failed", description: "Check that the ZIP contains a valid SKILL.md" })
    }
    setImporting(false)
    resetImport()
  }

  async function handleUrlImport() {
    const url = importUrl().trim()
    if (!url) return
    setImporting(true)
    setImportOpen(false)
    try {
      const result = await scopedClient().skill.importUrl({ url, scope: "global" })
      await refetch()
      const data = result.data as any
      showToast({ title: "Skill imported", description: `"${data?.name}" added to ${data?.scope ?? "project"}` })
    } catch {
      showToast({ title: "Import failed", description: "Failed to download or extract. Check the URL." })
    }
    setImporting(false)
    resetImport()
  }

  return (
    <>
      <Panel.SubHeader>
        <div class="flex items-center gap-1.5 flex-wrap">
          <Panel.FilterChip active={filter() === "all"} onClick={() => setFilter("all")}>
            All
            <Show when={(skills()?.items ?? []).length > 0}>
              <span class="ml-0.5">{(skills()?.items ?? []).length}</span>
            </Show>
          </Panel.FilterChip>
          <Show when={scopeCounts().project > 0}>
            <Panel.FilterChip active={filter() === "project"} onClick={() => setFilter("project")}>
              Project
              <span class="ml-0.5">{scopeCounts().project}</span>
            </Panel.FilterChip>
          </Show>
          <Show when={scopeCounts().global > 0}>
            <Panel.FilterChip active={filter() === "global"} onClick={() => setFilter("global")}>
              Global
              <span class="ml-0.5">{scopeCounts().global}</span>
            </Panel.FilterChip>
          </Show>
          <Show when={scopeCounts().builtin > 0}>
            <Panel.FilterChip active={filter() === "builtin"} onClick={() => setFilter("builtin")}>
              Builtin
              <span class="ml-0.5">{scopeCounts().builtin}</span>
            </Panel.FilterChip>
          </Show>
          <div class="ml-auto flex items-center gap-0.5">
            <Popover
              open={importOpen()}
              onOpenChange={(open) => {
                setImportOpen(open)
                if (!open) resetImport()
              }}
              placement="bottom-end"
              gutter={4}
            >
              <Popover.Trigger
                as="button"
                classList={{
                  "flex items-center gap-1 px-2 py-1 rounded-lg text-12-medium transition-colors": true,
                  "text-text-weak hover:text-text-base hover:bg-surface-raised-base-hover": !importing(),
                  "text-text-weaker pointer-events-none": importing(),
                }}
                disabled={importing()}
              >
                <Show when={importing()} fallback={<Icon name="download" size="small" class="opacity-70" />}>
                  <Spinner class="size-3" />
                </Show>
                <span>Import</span>
              </Popover.Trigger>
              <Popover.Portal>
                <Popover.Content class="w-64 rounded-xl border border-border-weak-base/40 bg-surface-raised-stronger-non-alpha shadow-lg z-50 outline-none overflow-hidden">
                  <Show when={importMode() === "menu"}>
                    <div class="py-1.5">
                      <button
                        type="button"
                        class="w-full px-3 py-2 flex items-center gap-2.5 text-left text-13-regular text-text-base hover:bg-surface-raised-base-hover transition-colors"
                        onClick={() => {
                          setImportOpen(false)
                          fileInputRef.click()
                        }}
                      >
                        <Icon name="folder-plus" size="small" class="text-icon-weak shrink-0" />
                        <div class="min-w-0">
                          <div class="text-13-regular text-text-base">Upload ZIP</div>
                          <div class="text-11-regular text-text-weaker">Import from a local .zip file</div>
                        </div>
                      </button>
                      <button
                        type="button"
                        class="w-full px-3 py-2 flex items-center gap-2.5 text-left text-13-regular text-text-base hover:bg-surface-raised-base-hover transition-colors"
                        onClick={() => setImportMode("url")}
                      >
                        <Icon name="globe" size="small" class="text-icon-weak shrink-0" />
                        <div class="min-w-0">
                          <div class="text-13-regular text-text-base">From URL</div>
                          <div class="text-11-regular text-text-weaker">Download and import a .zip URL</div>
                        </div>
                      </button>
                    </div>
                  </Show>
                  <Show when={importMode() === "url"}>
                    <div class="p-3 flex flex-col gap-2.5">
                      <div class="text-12-medium text-text-strong">Import from URL</div>
                      <input
                        type="url"
                        placeholder="https://example.com/skill.zip"
                        class="w-full px-3 py-2 rounded-lg bg-surface-inset-base/60 text-13-regular text-text-base placeholder:text-text-weak outline-none border border-border-base/30 focus:border-text-interactive-base/50 transition-colors"
                        value={importUrl()}
                        onInput={(e) => setImportUrl(e.currentTarget.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") handleUrlImport()
                        }}
                        autofocus
                      />
                      <div class="flex items-center justify-end gap-2">
                        <button
                          type="button"
                          class="px-2.5 py-1 rounded-lg text-12-medium text-text-weak hover:text-text-base transition-colors"
                          onClick={() => setImportMode("menu")}
                        >
                          Back
                        </button>
                        <button
                          type="button"
                          classList={{
                            "px-3 py-1 rounded-lg text-12-medium transition-colors": true,
                            "bg-text-interactive-base text-white hover:bg-text-interactive-base/90":
                              !!importUrl().trim(),
                            "bg-surface-inset-base text-text-weaker pointer-events-none": !importUrl().trim(),
                          }}
                          disabled={!importUrl().trim()}
                          onClick={handleUrlImport}
                        >
                          Import
                        </button>
                      </div>
                    </div>
                  </Show>
                </Popover.Content>
              </Popover.Portal>
            </Popover>
            <input
              ref={fileInputRef}
              type="file"
              accept=".zip,.skill"
              class="hidden"
              onChange={(e) => {
                const file = (e.target as HTMLInputElement).files?.[0]
                if (file) handleFileImport(file)
                e.target.value = ""
              }}
            />
            <button
              type="button"
              classList={{
                "flex items-center gap-1 px-2 py-1 rounded-lg text-12-medium transition-colors": true,
                "text-text-weak hover:text-text-base hover:bg-surface-raised-base-hover": !reloading(),
                "text-text-weaker pointer-events-none": reloading(),
              }}
              onClick={reloadSkills}
              disabled={reloading()}
            >
              <Show when={reloading()} fallback={<Icon name="refresh-ccw" size="small" class="opacity-70" />}>
                <Spinner class="size-3" />
              </Show>
              <span>Reload</span>
            </button>
          </div>
        </div>
      </Panel.SubHeader>

      <Panel.Body>
        <Show when={skills.loading}>
          <Panel.Loading />
        </Show>

        <Show when={!skills.loading}>
          <Show when={diagnostics().length > 0}>
            <div class="mb-3 rounded-2xl border border-border-warning-base/40 bg-surface-warning-base/10 px-4 py-3">
              <button
                type="button"
                class="flex w-full cursor-pointer items-center gap-2 text-12-medium text-text-strong"
                onClick={() => setDiagnosticsExpanded((prev) => !prev)}
              >
                <Icon name="shield-alert" size="small" class="text-icon-warning-base shrink-0" />
                <span class="flex-1 text-left">
                  {diagnostics().length} skill{diagnostics().length === 1 ? "" : "s"} skipped during load
                </span>
                <Icon
                  name="chevron-right"
                  size="small"
                  class="shrink-0 text-text-weaker transition-transform duration-200"
                  classList={{ "rotate-90": diagnosticsExpanded() }}
                />
              </button>
              <Show when={diagnosticsExpanded()}>
                <div class="mt-2 flex flex-col gap-2">
                  <For each={diagnostics()}>
                    {(item) => (
                      <div class="rounded-xl bg-surface-raised-base/60 px-3 py-2">
                        <div class="text-11-medium text-text-strong">{item.name}</div>
                        <div class="mt-0.5 text-11-regular text-text-diff-delete-base break-words">{item.message}</div>
                        <div class="mt-1 text-10-regular text-text-weaker break-all">{item.path}</div>
                      </div>
                    )}
                  </For>
                </div>
              </Show>
            </div>
          </Show>

          <Show
            when={filtered().length > 0}
            fallback={
              <Panel.Empty
                icon="sparkles"
                title={props.search ? `No skills match "${props.search}"` : "No skills loaded"}
                description="Skills are loaded from SKILL.md files in .synergy/skill/ directories. Use Reload to rescan."
              />
            }
          >
            <div class="flex flex-col gap-2">
              <For each={filtered()}>
                {(skill: SkillItem) => (
                  <SkillCard
                    skill={skill}
                    expanded={expandedCards().has(skill.name)}
                    onToggle={() => toggleCard(skill.name)}
                    onDelete={(e) => deleteSkill(skill.name, e)}
                  />
                )}
              </For>
            </div>
          </Show>
        </Show>
      </Panel.Body>
    </>
  )
}

function SkillCard(props: {
  skill: SkillItem
  expanded: boolean
  onToggle: () => void
  onDelete: (e: MouseEvent) => void
}) {
  const scopeLabel = () => {
    switch (props.skill.scope) {
      case "project":
        return "project"
      case "global":
        return "global"
      case "builtin":
        return "builtin"
      default:
        return undefined
    }
  }

  const scopeColor = () => {
    switch (props.skill.scope) {
      case "project":
        return "bg-icon-success-base/15 text-icon-success-base"
      case "global":
        return "bg-text-interactive-base/10 text-text-interactive-base"
      case "builtin":
        return "bg-surface-inset-base text-text-weaker"
      default:
        return "bg-surface-inset-base text-text-weak"
    }
  }

  const displayLocation = () => {
    const loc = props.skill.location
    if (!loc || loc === "builtin") return undefined
    const home = "~"
    const homeDir = loc.match(/^\/Users\/[^/]+/)?.[0]
    if (homeDir) return loc.replace(homeDir, home)
    return loc
  }

  const hasResources = () => (props.skill.references?.length ?? 0) > 0 || (props.skill.scripts?.length ?? 0) > 0

  return (
    <div
      classList={{
        "flex flex-col rounded-2xl bg-surface-raised-base border border-border-base/30 transition-all cursor-pointer overflow-hidden": true,
        "bg-surface-raised-base-hover shadow-md shadow-black/[0.08] border-border-base/50": props.expanded,
        "hover:bg-surface-raised-base-hover hover:border-border-base/50": !props.expanded,
      }}
      onClick={props.onToggle}
    >
      <div class="p-4 flex flex-col gap-2">
        <div class="flex items-start gap-2">
          <span class="text-13-medium text-text-strong flex-1 min-w-0 leading-snug truncate">{props.skill.name}</span>
          <div class="flex items-center gap-1 shrink-0">
            <Show when={scopeLabel()}>
              <span class={`px-1.5 py-0.5 rounded-md text-10-medium shrink-0 ${scopeColor()}`}>{scopeLabel()}</span>
            </Show>
            <Show when={props.expanded && !props.skill.builtin}>
              <button
                type="button"
                class="flex items-center justify-center size-5 rounded-md text-icon-weak hover:text-text-diff-delete-base hover:bg-surface-raised-base-active transition-colors"
                onClick={props.onDelete}
              >
                <Icon name="x" size="small" />
              </button>
            </Show>
          </div>
        </div>

        <p
          classList={{
            "text-12-regular text-text-weak leading-relaxed": true,
            "line-clamp-2": !props.expanded,
          }}
        >
          {props.skill.description}
        </p>

        <Show when={props.expanded}>
          <div class="flex flex-col gap-2 mt-0.5">
            <Show when={displayLocation()}>
              <div class="text-11-regular text-text-weaker truncate" title={props.skill.location}>
                {displayLocation()}
              </div>
            </Show>

            <Show when={hasResources()}>
              <div class="flex items-center gap-1.5 flex-wrap">
                <For each={props.skill.scripts ?? []}>
                  {(script) => (
                    <span class="px-1.5 py-0.5 rounded-md bg-icon-warning-base/10 text-10-medium text-icon-warning-base">
                      {script}
                    </span>
                  )}
                </For>
                <For each={props.skill.references ?? []}>
                  {(ref) => (
                    <span class="px-1.5 py-0.5 rounded-md bg-text-interactive-base/10 text-10-medium text-text-interactive-base">
                      {ref}
                    </span>
                  )}
                </For>
              </div>
            </Show>
          </div>
        </Show>

        <div class="flex items-center justify-end mt-0.5">
          <Icon
            name="chevron-down"
            size="small"
            class="text-icon-weak transition-transform"
            classList={{ "rotate-180": props.expanded }}
          />
        </div>
      </div>
    </div>
  )
}
