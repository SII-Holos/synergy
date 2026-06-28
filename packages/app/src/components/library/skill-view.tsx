import { createMemo, createResource, createSignal, For, Show, type JSXElement } from "solid-js"
import { Popover } from "@kobalte/core/popover"
import { Dialog } from "@ericsanchezok/synergy-ui/dialog"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { Spinner } from "@ericsanchezok/synergy-ui/spinner"
import { showToast } from "@ericsanchezok/synergy-ui/toast"
import { createSynergyClient } from "@ericsanchezok/synergy-sdk/client"
import { useGlobalSDK } from "@/context/global-sdk"
import { usePlatform } from "@/context/platform"
import { AppPanel } from "@/components/app-panel"
import type { SkillList } from "@ericsanchezok/synergy-sdk/client"
import {
  libraryActionButtonClass,
  libraryCardBaseClass,
  libraryCardHoverClass,
  libraryInsetClass,
  libraryMenuClass,
  libraryMetaLabelClass,
} from "./shared"

type SkillScope = "all" | "project" | "global" | "builtin"
type SkillItem = SkillList["items"][number]
type SkillListData = SkillList
type SkillCompatibilityLevel = NonNullable<SkillItem["compatibility"]>["level"]

function skillScopeLabel(skill: SkillItem) {
  switch (skill.scope) {
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

function skillScopeColor(skill: SkillItem) {
  switch (skill.scope) {
    case "project":
      return "bg-icon-success-base/15 text-icon-success-base"
    case "global":
      return "bg-surface-inset-base text-text-base"
    case "builtin":
      return "bg-surface-inset-base text-text-weaker"
    default:
      return "bg-surface-inset-base text-text-weak"
  }
}

function compactPath(path?: string) {
  if (!path || path === "builtin") return undefined
  const homeDir = path.match(/^\/Users\/[^/]+/)?.[0]
  if (homeDir) return path.replace(homeDir, "~")
  return path
}

function compatibilityTone(level?: SkillCompatibilityLevel) {
  switch (level) {
    case "native":
      return "bg-icon-success-base/10 text-icon-success-base ring-icon-success-base/12"
    case "compatible":
      return "workbench-selected-surface text-text-strong ring-border-base/20"
    case "partial":
      return "bg-icon-warning-base/10 text-icon-warning-base ring-icon-warning-base/12"
    default:
      return "bg-surface-inset-base text-text-weaker ring-border-base/25"
  }
}

function compatibilityLabel(level?: SkillCompatibilityLevel) {
  switch (level) {
    case "native":
      return "native"
    case "compatible":
      return "compatible"
    case "partial":
      return "partial"
    default:
      return undefined
  }
}

export function SkillView(props: { sdk: ReturnType<typeof useGlobalSDK>; search: string; directory?: string }) {
  const dialog = useDialog()
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
  const [filterOpen, setFilterOpen] = createSignal(false)
  const [reloading, setReloading] = createSignal(false)
  const [diagnosticsExpanded, setDiagnosticsExpanded] = createSignal(false)

  const [skills, { refetch }] = createResource<SkillListData>(async () => {
    const result = await scopedClient().skill.list()
    return (result.data as SkillListData | undefined) ?? { items: [], diagnostics: [] }
  })

  async function reloadSkills() {
    setReloading(true)
    try {
      await scopedClient().skill.reload()
      await refetch()
      showToast({ type: "success", title: "Skills reloaded", description: "Skill directories rescanned" })
    } catch {
      showToast({ type: "error", title: "Failed to reload skills" })
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

  async function deleteSkill(name: string) {
    try {
      await scopedClient().skill.remove({ name })
      await refetch()
      showToast({ type: "info", title: "Skill deleted", description: `Removed "${name}" from disk` })
      return true
    } catch {
      showToast({ type: "error", title: "Failed to delete skill" })
      return false
    }
  }

  function openSkillDetail(skill: SkillItem) {
    dialog.show(() => (
      <SkillDetailDialog
        skill={skill}
        onDelete={skill.builtin ? undefined : () => deleteSkill(skill.name)}
        onDeleted={() => dialog.close()}
      />
    ))
  }

  const filterLabel = createMemo(() => {
    switch (filter()) {
      case "project":
        return "Project skills"
      case "global":
        return "Global skills"
      case "builtin":
        return "Built-in skills"
      default:
        return "All skills"
    }
  })

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
      showToast({
        type: "info",
        title: "Skill imported",
        description: `"${data?.name}" added to ${data?.scope ?? scope}`,
      })
    } catch {
      showToast({ type: "error", title: "Import failed", description: "Check that the ZIP contains a valid SKILL.md" })
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
      showToast({
        type: "info",
        title: "Skill imported",
        description: `"${data?.name}" added to ${data?.scope ?? "project"}`,
      })
    } catch {
      showToast({ type: "error", title: "Import failed", description: "Failed to download or extract. Check the URL." })
    }
    setImporting(false)
    resetImport()
  }

  return (
    <div class="library-list-pane">
      <div class="library-list-toolbar">
        <div class="library-toolbar-left">
          <Popover open={filterOpen()} onOpenChange={setFilterOpen} placement="bottom-start" gutter={6}>
            <Popover.Trigger as="button" class="library-control-pill">
              <span>{filterLabel()}</span>
              <Icon name="chevron-down" size="small" class="opacity-60" />
            </Popover.Trigger>
            <Popover.Portal>
              <Popover.Content class={`library-filter-menu ${libraryMenuClass}`}>
                <button
                  type="button"
                  classList={{
                    "library-menu-item": true,
                    "is-active": filter() === "all",
                  }}
                  onClick={() => {
                    setFilter("all")
                    setFilterOpen(false)
                  }}
                >
                  <span>All skills</span>
                  <span class="library-menu-count">{(skills()?.items ?? []).length}</span>
                </button>
                <Show when={scopeCounts().project > 0}>
                  <button
                    type="button"
                    classList={{
                      "library-menu-item": true,
                      "is-active": filter() === "project",
                    }}
                    onClick={() => {
                      setFilter("project")
                      setFilterOpen(false)
                    }}
                  >
                    <span>Project</span>
                    <span class="library-menu-count">{scopeCounts().project}</span>
                  </button>
                </Show>
                <Show when={scopeCounts().global > 0}>
                  <button
                    type="button"
                    classList={{
                      "library-menu-item": true,
                      "is-active": filter() === "global",
                    }}
                    onClick={() => {
                      setFilter("global")
                      setFilterOpen(false)
                    }}
                  >
                    <span>Global</span>
                    <span class="library-menu-count">{scopeCounts().global}</span>
                  </button>
                </Show>
                <Show when={scopeCounts().builtin > 0}>
                  <button
                    type="button"
                    classList={{
                      "library-menu-item": true,
                      "is-active": filter() === "builtin",
                    }}
                    onClick={() => {
                      setFilter("builtin")
                      setFilterOpen(false)
                    }}
                  >
                    <span>Built-in</span>
                    <span class="library-menu-count">{scopeCounts().builtin}</span>
                  </button>
                </Show>
              </Popover.Content>
            </Popover.Portal>
          </Popover>
          <span class="library-toolbar-summary">{filtered().length} skills</span>
        </div>
        <div class="library-toolbar-right">
          <Popover
            open={importOpen()}
            onOpenChange={(open) => {
              setImportOpen(open)
              if (!open) resetImport()
            }}
            placement="bottom-end"
            gutter={6}
          >
            <Popover.Trigger
              as="button"
              class={`${libraryActionButtonClass} ${importing() ? "pointer-events-none text-text-weaker" : ""}`}
              disabled={importing()}
            >
              <Show when={importing()} fallback={<Icon name="download" size="small" class="opacity-70" />}>
                <Spinner class="size-3" />
              </Show>
              <span>Import</span>
            </Popover.Trigger>
            <Popover.Portal>
              <Popover.Content class={`w-64 ${libraryMenuClass}`}>
                <Show when={importMode() === "menu"}>
                  <div class="p-1.5">
                    <button
                      type="button"
                      class="flex w-full items-center gap-2.5 rounded-[0.9rem] px-3 py-2 text-left text-12-medium text-text-base transition-colors hover:bg-surface-inset-base"
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
                      class="flex w-full items-center gap-2.5 rounded-[0.9rem] px-3 py-2 text-left text-12-medium text-text-base transition-colors hover:bg-surface-inset-base"
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
                  <div class="flex flex-col gap-2.5 p-3">
                    <div>
                      <div class={libraryMetaLabelClass}>Import</div>
                      <div class="mt-1 text-12-medium text-text-strong">Import from URL</div>
                    </div>
                    <input
                      type="url"
                      placeholder="https://example.com/skill.zip"
                      class="w-full rounded-[0.95rem] border border-border-base/38 bg-surface-inset-base px-3 py-2.5 text-13-regular text-text-base outline-none ring-1 ring-inset ring-border-base/35 transition-colors placeholder:text-text-weak focus:border-border-base/50 focus:bg-surface-inset-base"
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
                        class="rounded-full px-3 py-1.5 text-11-medium text-text-weak ring-1 ring-inset ring-border-base/45 transition-all hover:bg-surface-inset-base hover:text-text-base"
                        onClick={() => setImportMode("menu")}
                      >
                        Back
                      </button>
                      <button
                        type="button"
                        classList={{
                          "rounded-full px-3.5 py-1.5 text-11-medium ring-1 ring-inset transition-all": true,
                          "bg-text-strong text-background-base ring-border-base/20 hover:opacity-90":
                            !!importUrl().trim(),
                          "bg-surface-inset-base text-text-weaker ring-border-base/35 pointer-events-none":
                            !importUrl().trim(),
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
            class={`${libraryActionButtonClass} ${reloading() ? "pointer-events-none text-text-weaker" : ""}`}
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

      <Show when={skills.loading}>
        <AppPanel.Loading />
      </Show>

      <Show when={!skills.loading}>
        <Show when={diagnostics().length > 0}>
          <div class="mb-3 rounded-[1.15rem] border border-border-warning-base/35 bg-[rgba(196,132,36,0.08)] px-4 py-3 shadow-[inset_0_1px_0_rgba(214,204,190,0.07)]">
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
                    <div class={`rounded-[0.95rem] px-3 py-2 ${libraryInsetClass}`}>
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
            <AppPanel.Empty
              icon="sparkles"
              title={props.search ? `No skills match "${props.search}"` : "No skills loaded"}
              description="Skills are loaded from SKILL.md files in .synergy/skill/ directories. Use Reload to rescan."
            />
          }
        >
          <div class="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
            <For each={filtered()}>
              {(skill: SkillItem) => <SkillCard skill={skill} onOpen={() => openSkillDetail(skill)} />}
            </For>
          </div>
        </Show>
      </Show>
    </div>
  )
}

function SkillCard(props: { skill: SkillItem; onOpen: () => void }) {
  const scopeLabel = () => skillScopeLabel(props.skill)
  const displayLocation = () => compactPath(props.skill.location)
  const scriptsCount = () => props.skill.scripts?.length ?? 0
  const referencesCount = () => props.skill.references?.length ?? 0
  const compatibility = () => compatibilityLabel(props.skill.compatibility?.level)

  return (
    <div class={`${libraryCardBaseClass} ${libraryCardHoverClass} h-full`}>
      <div class="flex h-full flex-col gap-3 p-4">
        <div class="flex items-start gap-3">
          <div class="min-w-0 flex-1">
            <div class="flex min-w-0 items-start gap-2">
              <span class="min-w-0 flex-1 text-13-medium leading-snug text-text-strong break-words">
                {props.skill.name}
              </span>
              <Show when={scopeLabel()}>
                <span
                  class={`shrink-0 rounded-full px-2.5 py-1 text-[10px] font-medium ring-1 ring-inset ring-border-base/10 ${skillScopeColor(props.skill)}`}
                >
                  {scopeLabel()}
                </span>
              </Show>
            </div>
          </div>
          <button
            type="button"
            class="flex size-7 shrink-0 items-center justify-center rounded-full bg-surface-inset-base text-icon-weak ring-1 ring-inset ring-border-base/40 transition-all hover:bg-surface-raised-base-hover hover:text-text-base"
            onClick={props.onOpen}
            title={`Open details for ${props.skill.name}`}
            aria-label={`Open details for ${props.skill.name}`}
          >
            <Icon name="arrow-up-right" size="small" />
          </button>
        </div>

        <p class="text-12-regular leading-relaxed text-text-weak/90 whitespace-pre-wrap line-clamp-4">
          {props.skill.description}
        </p>

        <div class="mt-auto flex flex-col gap-2.5 pt-1">
          <Show when={displayLocation()}>
            <div class={`flex items-center gap-2 px-3 py-2.5 ${libraryInsetClass}`} title={props.skill.location}>
              <Icon name="file-text" size="small" class="shrink-0 text-icon-weak" />
              <span class="min-w-0 truncate text-10-regular text-text-weaker">{displayLocation()}</span>
            </div>
          </Show>

          <div class="flex flex-wrap items-center gap-1.5">
            <Show when={scriptsCount() > 0}>
              <span class="rounded-full bg-icon-warning-base/10 px-2.5 py-1 text-[10px] font-medium text-icon-warning-base ring-1 ring-inset ring-icon-warning-base/12">
                {scriptsCount()} script{scriptsCount() === 1 ? "" : "s"}
              </span>
            </Show>
            <Show when={referencesCount() > 0}>
              <span class="rounded-full bg-surface-inset-base px-2.5 py-1 text-[10px] font-medium text-text-base ring-1 ring-inset ring-border-base/35">
                {referencesCount()} reference{referencesCount() === 1 ? "" : "s"}
              </span>
            </Show>
            <Show when={compatibility()}>
              <span
                class={`rounded-full px-2.5 py-1 text-[10px] font-medium ring-1 ring-inset ${compatibilityTone(props.skill.compatibility?.level)}`}
              >
                {compatibility()}
              </span>
            </Show>
          </div>
        </div>
      </div>
    </div>
  )
}

function SkillDetailDialog(props: { skill: SkillItem; onDelete?: () => Promise<boolean>; onDeleted: () => void }) {
  const dialog = useDialog()
  const [deleting, setDeleting] = createSignal(false)
  const [confirmingDelete, setConfirmingDelete] = createSignal(false)
  const scopeLabel = () => skillScopeLabel(props.skill)
  const displayLocation = () => compactPath(props.skill.location)
  const displayEntryFile = () => compactPath(props.skill.entryFile)
  const displayBaseDir = () => compactPath(props.skill.baseDir)
  const compatibility = () => props.skill.compatibility

  async function handleDelete() {
    if (!props.onDelete || deleting()) return
    setDeleting(true)
    const deleted = await props.onDelete()
    setDeleting(false)
    if (deleted) props.onDeleted()
    else setConfirmingDelete(false)
  }

  return (
    <Dialog title={<span class="min-w-0 truncate">{props.skill.name}</span>} class="dialog-skill-detail">
      <div class="skill-detail-shell">
        <div class="skill-detail-scroll">
          <div class="skill-detail-meta-row">
            <Show when={scopeLabel()}>
              <span class={`skill-detail-chip ${skillScopeColor(props.skill)}`}>{scopeLabel()}</span>
            </Show>
            <Show when={props.skill.source}>
              <span class="skill-detail-chip skill-detail-chip-muted">{props.skill.source}</span>
            </Show>
            <Show when={compatibilityLabel(props.skill.compatibility?.level)}>
              <span class={`skill-detail-chip ${compatibilityTone(props.skill.compatibility?.level)}`}>
                {compatibilityLabel(props.skill.compatibility?.level)} compatibility
              </span>
            </Show>
          </div>

          <SkillDetailSection label="Description">
            <div class="skill-detail-description">{props.skill.description}</div>
          </SkillDetailSection>

          <Show when={displayLocation() || displayEntryFile() || displayBaseDir()}>
            <SkillDetailSection label="Location">
              <div class="skill-detail-rows">
                <Show when={displayLocation()}>
                  <SkillDetailRow label="Skill path" value={displayLocation()!} title={props.skill.location} />
                </Show>
                <Show when={displayEntryFile()}>
                  <SkillDetailRow label="Entry file" value={displayEntryFile()!} title={props.skill.entryFile} />
                </Show>
                <Show when={displayBaseDir()}>
                  <SkillDetailRow label="Base directory" value={displayBaseDir()!} title={props.skill.baseDir} />
                </Show>
              </div>
            </SkillDetailSection>
          </Show>

          <Show when={compatibility()}>
            <SkillDetailSection label="Compatibility">
              <div class="skill-detail-rows">
                <SkillDetailRow
                  label="Level"
                  value={compatibilityLabel(compatibility()?.level) ?? "unknown"}
                  mono={false}
                />
              </div>
              <Show when={(compatibility()?.warnings?.length ?? 0) > 0}>
                <SkillDetailList title="Warnings" items={compatibility()?.warnings ?? []} tone="warning" />
              </Show>
              <Show when={(compatibility()?.unsupported?.length ?? 0) > 0}>
                <SkillDetailList title="Unsupported" items={compatibility()?.unsupported ?? []} tone="danger" />
              </Show>
            </SkillDetailSection>
          </Show>

          <Show when={(props.skill.references?.length ?? 0) > 0}>
            <SkillDetailSection label="References">
              <SkillCodeList items={props.skill.references ?? []} />
            </SkillDetailSection>
          </Show>

          <Show when={(props.skill.scripts?.length ?? 0) > 0}>
            <SkillDetailSection label="Scripts">
              <SkillCodeList items={props.skill.scripts ?? []} />
            </SkillDetailSection>
          </Show>
        </div>

        <div classList={{ "skill-detail-footer": true, "is-confirming": confirmingDelete() }}>
          <Show
            when={confirmingDelete() && props.onDelete}
            fallback={
              <>
                <Show when={props.onDelete}>
                  <button
                    type="button"
                    class="skill-detail-button skill-detail-button-danger"
                    onClick={() => setConfirmingDelete(true)}
                  >
                    Delete skill
                  </button>
                </Show>
                <button
                  type="button"
                  class="skill-detail-button skill-detail-button-secondary ml-auto"
                  onClick={() => dialog.close()}
                >
                  Close
                </button>
              </>
            }
          >
            <div class="skill-delete-confirm-copy">
              <div class="skill-delete-confirm-title">Delete this skill?</div>
              <div class="skill-delete-confirm-text">
                This removes "{props.skill.name}" from disk. This cannot be undone.
              </div>
            </div>
            <div class="skill-delete-confirm-actions">
              <button
                type="button"
                class="skill-detail-button skill-detail-button-secondary"
                onClick={() => setConfirmingDelete(false)}
                disabled={deleting()}
              >
                Keep skill
              </button>
              <button
                type="button"
                classList={{
                  "skill-detail-button skill-detail-button-danger-solid": true,
                  "is-disabled": deleting(),
                }}
                onClick={handleDelete}
                disabled={deleting()}
              >
                <Show when={deleting()} fallback="Delete">
                  <span class="inline-flex items-center gap-1.5">
                    <Spinner class="size-3" />
                    Deleting...
                  </span>
                </Show>
              </button>
            </div>
          </Show>
        </div>
      </div>
    </Dialog>
  )
}

function SkillDetailSection(props: { label: string; children: JSXElement }) {
  return (
    <section class="skill-detail-section">
      <div class="skill-detail-label">{props.label}</div>
      {props.children}
    </section>
  )
}

function SkillDetailRow(props: { label: string; value: string; title?: string; mono?: boolean }) {
  return (
    <div class="skill-detail-row" title={props.title}>
      <div class="skill-detail-row-label">{props.label}</div>
      <div
        classList={{
          "skill-detail-row-value": true,
          "is-mono": props.mono !== false,
        }}
      >
        {props.value}
      </div>
    </div>
  )
}

function SkillDetailList(props: { title: string; items: string[]; tone: "warning" | "danger" }) {
  const toneClass = () =>
    props.tone === "warning"
      ? "bg-icon-warning-base/8 text-icon-warning-base ring-icon-warning-base/12"
      : "bg-text-diff-delete-base/8 text-text-diff-delete-base ring-text-diff-delete-base/12"

  return (
    <div class={`skill-detail-notice ${toneClass()}`}>
      <div class="skill-detail-notice-title">{props.title}</div>
      <For each={props.items}>{(item) => <p>{item}</p>}</For>
    </div>
  )
}

function SkillCodeList(props: { items: string[] }) {
  return (
    <div class="skill-detail-code-list">
      <For each={props.items}>{(item) => <div class="skill-detail-code-row">{item}</div>}</For>
    </div>
  )
}
