import { createMemo, createResource, createSignal, For, Show } from "solid-js"
import { Popover } from "@kobalte/core/popover"
import { Dialog } from "@ericsanchezok/synergy-ui/dialog"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { Spinner } from "@ericsanchezok/synergy-ui/spinner"
import { showToast } from "@ericsanchezok/synergy-ui/toast"
import { createSynergyClient } from "@ericsanchezok/synergy-sdk/client"
import { useGlobalSDK } from "@/context/global-sdk"
import { usePlatform } from "@/context/platform"
import { Panel } from "@/components/panel"
import type { SkillList } from "@ericsanchezok/synergy-sdk/client"
import {
  engramActionButtonClass,
  engramCardBaseClass,
  engramCardHoverClass,
  engramInsetClass,
  engramMenuClass,
  engramMetaLabelClass,
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
      return "bg-text-interactive-base/10 text-text-interactive-base"
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
      return "bg-text-interactive-base/10 text-text-interactive-base ring-text-interactive-base/12"
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

export function SkillView(props: {
  sdk: ReturnType<typeof useGlobalSDK>
  search: string
  directory?: string
  onRegisterRefetch: (fn: () => void) => void
}) {
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
  const [reloading, setReloading] = createSignal(false)
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

  async function deleteSkill(name: string) {
    try {
      await scopedClient().skill.remove({ name })
      await refetch()
      showToast({ title: "Skill deleted", description: `Removed "${name}" from disk` })
      return true
    } catch {
      showToast({ title: "Failed to delete skill" })
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
              gutter={6}
            >
              <Popover.Trigger
                as="button"
                class={`${engramActionButtonClass} ${importing() ? "pointer-events-none text-text-weaker" : ""}`}
                disabled={importing()}
              >
                <Show when={importing()} fallback={<Icon name="download" size="small" class="opacity-70" />}>
                  <Spinner class="size-3" />
                </Show>
                <span>Import</span>
              </Popover.Trigger>
              <Popover.Portal>
                <Popover.Content class={`w-64 ${engramMenuClass}`}>
                  <Show when={importMode() === "menu"}>
                    <div class="p-1.5">
                      <button
                        type="button"
                        class="flex w-full items-center gap-2.5 rounded-[0.9rem] px-3 py-2 text-left text-12-medium text-text-base transition-colors hover:bg-surface-inset-base/55"
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
                        class="flex w-full items-center gap-2.5 rounded-[0.9rem] px-3 py-2 text-left text-12-medium text-text-base transition-colors hover:bg-surface-inset-base/55"
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
                        <div class={engramMetaLabelClass}>Import</div>
                        <div class="mt-1 text-12-medium text-text-strong">Import from URL</div>
                      </div>
                      <input
                        type="url"
                        placeholder="https://example.com/skill.zip"
                        class="w-full rounded-[0.95rem] border border-border-base/38 bg-surface-inset-base/58 px-3 py-2.5 text-13-regular text-text-base outline-none ring-1 ring-inset ring-border-base/35 transition-colors placeholder:text-text-weak focus:border-text-interactive-base/40 focus:bg-surface-inset-base/7"
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
                          class="rounded-full px-3 py-1.5 text-11-medium text-text-weak ring-1 ring-inset ring-border-base/45 transition-all hover:bg-surface-inset-base/4 hover:text-text-base"
                          onClick={() => setImportMode("menu")}
                        >
                          Back
                        </button>
                        <button
                          type="button"
                          classList={{
                            "rounded-full px-3.5 py-1.5 text-11-medium ring-1 ring-inset transition-all": true,
                            "bg-text-interactive-base text-white ring-text-interactive-base/15 hover:bg-text-interactive-base/90":
                              !!importUrl().trim(),
                            "bg-surface-inset-base/6 text-text-weaker ring-border-base/35 pointer-events-none":
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
              class={`${engramActionButtonClass} ${reloading() ? "pointer-events-none text-text-weaker" : ""}`}
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
                      <div class={`rounded-[0.95rem] px-3 py-2 ${engramInsetClass}`}>
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
            <div class="grid grid-cols-1 gap-2.5 sm:grid-cols-2 xl:grid-cols-3">
              <For each={filtered()}>
                {(skill: SkillItem) => <SkillCard skill={skill} onOpen={() => openSkillDetail(skill)} />}
              </For>
            </div>
          </Show>
        </Show>
      </Panel.Body>
    </>
  )
}

function SkillCard(props: { skill: SkillItem; onOpen: () => void }) {
  const scopeLabel = () => skillScopeLabel(props.skill)
  const displayLocation = () => compactPath(props.skill.location)
  const scriptsCount = () => props.skill.scripts?.length ?? 0
  const referencesCount = () => props.skill.references?.length ?? 0
  const compatibility = () => compatibilityLabel(props.skill.compatibility?.level)

  return (
    <div class={`${engramCardBaseClass} ${engramCardHoverClass} h-full`}>
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
            class="flex size-7 shrink-0 items-center justify-center rounded-full bg-surface-inset-base/55 text-icon-weak ring-1 ring-inset ring-border-base/40 transition-all hover:bg-surface-raised-base hover:text-text-base"
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
            <div class={`flex items-center gap-2 px-3 py-2.5 ${engramInsetClass}`} title={props.skill.location}>
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
              <span class="rounded-full bg-text-interactive-base/10 px-2.5 py-1 text-[10px] font-medium text-text-interactive-base ring-1 ring-inset ring-text-interactive-base/12">
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
  const scopeLabel = () => skillScopeLabel(props.skill)
  const displayLocation = () => compactPath(props.skill.location)
  const displayEntryFile = () => compactPath(props.skill.entryFile)
  const displayBaseDir = () => compactPath(props.skill.baseDir)
  const compatibility = () => props.skill.compatibility

  async function handleDelete() {
    if (!props.onDelete || deleting()) return
    if (!confirm(`Delete skill "${props.skill.name}"?`)) return
    setDeleting(true)
    const deleted = await props.onDelete()
    setDeleting(false)
    if (deleted) props.onDeleted()
  }

  return (
    <Dialog
      title={
        <div class="flex min-w-0 items-center gap-2.5 pr-2">
          <span class="min-w-0 truncate">{props.skill.name}</span>
          <Show when={scopeLabel()}>
            <span
              class={`shrink-0 rounded-full px-2.5 py-1 text-[10px] font-medium ring-1 ring-inset ring-border-base/10 ${skillScopeColor(props.skill)}`}
            >
              {scopeLabel()}
            </span>
          </Show>
        </div>
      }
      description={
        <div class="flex flex-wrap items-center gap-1.5">
          <Show when={props.skill.source}>
            <span class="rounded-full bg-surface-inset-base px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.12em] text-text-weaker ring-1 ring-inset ring-border-base/20">
              {props.skill.source}
            </span>
          </Show>
          <Show when={compatibilityLabel(props.skill.compatibility?.level)}>
            <span
              class={`rounded-full px-2.5 py-1 text-[10px] font-medium ring-1 ring-inset ${compatibilityTone(props.skill.compatibility?.level)}`}
            >
              {compatibilityLabel(props.skill.compatibility?.level)} compatibility
            </span>
          </Show>
        </div>
      }
      class="dialog-skill-detail"
    >
      <div class="flex min-h-full flex-col">
        <div class="flex flex-1 flex-col gap-4 px-5 pb-5">
          <SkillDetailSection label="Description">
            <div class={`px-4 py-3.5 ${engramInsetClass}`}>
              <div class="text-13-regular leading-relaxed text-text-base whitespace-pre-wrap break-words">
                {props.skill.description}
              </div>
            </div>
          </SkillDetailSection>

          <Show when={displayLocation() || displayEntryFile() || displayBaseDir()}>
            <SkillDetailSection label="Location">
              <div class="grid grid-cols-1 gap-2 md:grid-cols-2">
                <Show when={displayLocation()}>
                  <SkillDetailField label="Skill path" value={displayLocation()!} title={props.skill.location} />
                </Show>
                <Show when={displayEntryFile()}>
                  <SkillDetailField label="Entry file" value={displayEntryFile()!} title={props.skill.entryFile} />
                </Show>
                <Show when={displayBaseDir()}>
                  <SkillDetailField label="Base directory" value={displayBaseDir()!} title={props.skill.baseDir} />
                </Show>
              </div>
            </SkillDetailSection>
          </Show>

          <Show when={compatibility()}>
            <SkillDetailSection label="Compatibility">
              <div class={`flex flex-col gap-3 px-4 py-3.5 ${engramInsetClass}`}>
                <div class="flex flex-wrap items-center gap-2">
                  <span class={engramMetaLabelClass}>Level</span>
                  <span
                    class={`rounded-full px-2.5 py-1 text-[10px] font-medium ring-1 ring-inset ${compatibilityTone(compatibility()?.level)}`}
                  >
                    {compatibilityLabel(compatibility()?.level)}
                  </span>
                </div>
                <Show when={(compatibility()?.warnings?.length ?? 0) > 0}>
                  <SkillDetailList title="Warnings" items={compatibility()?.warnings ?? []} tone="warning" />
                </Show>
                <Show when={(compatibility()?.unsupported?.length ?? 0) > 0}>
                  <SkillDetailList title="Unsupported" items={compatibility()?.unsupported ?? []} tone="danger" />
                </Show>
              </div>
            </SkillDetailSection>
          </Show>

          <Show when={(props.skill.references?.length ?? 0) > 0}>
            <SkillDetailSection label="References">
              <SkillCodeList items={props.skill.references ?? []} accent="interactive" />
            </SkillDetailSection>
          </Show>

          <Show when={(props.skill.scripts?.length ?? 0) > 0}>
            <SkillDetailSection label="Scripts">
              <SkillCodeList items={props.skill.scripts ?? []} accent="warning" />
            </SkillDetailSection>
          </Show>
        </div>

        <div class="sticky bottom-0 flex items-center gap-2 border-t border-border-base/25 bg-surface-raised-base/95 px-5 py-3 backdrop-blur-sm">
          <Show when={props.onDelete}>
            <button
              type="button"
              classList={{
                "rounded-full px-3.5 py-1.5 text-11-medium ring-1 ring-inset transition-all": true,
                "text-text-diff-delete-base ring-text-diff-delete-base/15 hover:bg-text-diff-delete-base/8":
                  !deleting(),
                "pointer-events-none text-text-weaker ring-border-base/35": deleting(),
              }}
              onClick={handleDelete}
              disabled={deleting()}
            >
              <Show when={deleting()} fallback="Delete skill">
                <span class="inline-flex items-center gap-1.5">
                  <Spinner class="size-3" />
                  Deleting...
                </span>
              </Show>
            </button>
          </Show>
          <div class="ml-auto flex items-center gap-2">
            <button
              type="button"
              class="rounded-full px-3.5 py-1.5 text-11-medium text-text-weak ring-1 ring-inset ring-border-base/45 transition-all hover:bg-surface-inset-base/4 hover:text-text-base"
              onClick={() => dialog.close()}
            >
              Close
            </button>
          </div>
        </div>
      </div>
    </Dialog>
  )
}

function SkillDetailSection(props: { label: string; children: any }) {
  return (
    <section class="flex flex-col gap-2.5">
      <div class={engramMetaLabelClass}>{props.label}</div>
      {props.children}
    </section>
  )
}

function SkillDetailField(props: { label: string; value: string; title?: string }) {
  return (
    <div class={`px-3.5 py-3 ${engramInsetClass}`} title={props.title}>
      <div class={engramMetaLabelClass}>{props.label}</div>
      <div class="mt-1.5 break-all font-mono text-[11px] leading-relaxed text-text-weaker">{props.value}</div>
    </div>
  )
}

function SkillDetailList(props: { title: string; items: string[]; tone: "warning" | "danger" }) {
  const toneClass = () =>
    props.tone === "warning"
      ? "bg-icon-warning-base/8 text-icon-warning-base ring-icon-warning-base/12"
      : "bg-text-diff-delete-base/8 text-text-diff-delete-base ring-text-diff-delete-base/12"

  return (
    <div class="flex flex-col gap-2">
      <div class={engramMetaLabelClass}>{props.title}</div>
      <div class="flex flex-col gap-1.5">
        <For each={props.items}>
          {(item) => (
            <div class={`rounded-[0.9rem] px-3 py-2 text-11-regular leading-relaxed ring-1 ring-inset ${toneClass()}`}>
              {item}
            </div>
          )}
        </For>
      </div>
    </div>
  )
}

function SkillCodeList(props: { items: string[]; accent: "interactive" | "warning" }) {
  const accentClass = () =>
    props.accent === "interactive"
      ? "bg-text-interactive-base/6 ring-text-interactive-base/12"
      : "bg-icon-warning-base/6 ring-icon-warning-base/12"

  return (
    <div class={`flex flex-col gap-1.5 px-3 py-3 ${engramInsetClass}`}>
      <For each={props.items}>
        {(item) => (
          <div class={`rounded-[0.85rem] px-3 py-2 ring-1 ring-inset ${accentClass()}`}>
            <div class="break-all font-mono text-[11px] leading-relaxed text-text-base">{item}</div>
          </div>
        )}
      </For>
    </div>
  )
}
