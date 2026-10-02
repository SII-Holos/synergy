import { createMemo, createResource, createSignal, For, Show, type JSXElement } from "solid-js"
import { useLingui } from "@lingui/solid"
import { Popover } from "@kobalte/core/popover"
import { MenuField } from "@ericsanchezok/synergy-ui/menu-field"
import { Dialog } from "@ericsanchezok/synergy-ui/dialog"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { Spinner } from "@ericsanchezok/synergy-ui/spinner"
import { showToast } from "@ericsanchezok/synergy-ui/toast"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { createSynergyClient } from "@ericsanchezok/synergy-sdk/client"
import type { SkillImportResult, SkillList } from "@ericsanchezok/synergy-sdk/client"
import { useGlobalSDK } from "@/context/global-sdk"
import { usePlatform } from "@/context/platform"
import { useConfirm } from "@/components/dialog/confirm-dialog"
import { deleteSkillConfirm } from "@/components/dialog/confirm-copy"
import { AppPanel } from "@/components/app-panel"
import {
  libraryActionButtonClass,
  libraryCardBaseClass,
  libraryCardHoverClass,
  libraryInsetClass,
  libraryMenuClass,
  libraryMetaLabelClass,
} from "./shared"
import {
  skillCanExport,
  skillCanonicalDiagnostics,
  skillDeclaredCompatibility,
  skillExportErrorPresentation,
  skillExportFilename,
  skillImportAccept,
  skillImportErrorPresentation,
  skillImportScopeOptions,
  skillInvocationLabel,
  skillPathLabel,
  partitionSkillDiagnostics,
  type SkillImportScope,
} from "./skill-view-model"

type SkillScope = "all" | "project" | "global" | "builtin"
type SkillItem = SkillList["items"][number]
type SkillListData = SkillList
type SkillCompatibilityLevel = NonNullable<SkillItem["compatibility"]>["level"]

function skillScopeLabel(skill: SkillItem, _: ReturnType<typeof useLingui>["_"]) {
  switch (skill.scope) {
    case "project":
      return _({ id: "app.library.skills.scope.project", message: "project" })
    case "global":
      return _({ id: "app.library.skills.scope.global", message: "global" })
    case "builtin":
      return _({ id: "app.library.skills.scope.builtin", message: "builtin" })
    default:
      return undefined
  }
}

function importScopeLabel(scope: "project" | "global", _: ReturnType<typeof useLingui>["_"]) {
  return scope === "project"
    ? _({ id: "app.library.skills.import.scope.project", message: "Project" })
    : _({ id: "app.library.skills.import.scope.global", message: "Global" })
}

function skillScopeColor(skill: SkillItem) {
  switch (skill.scope) {
    case "project":
      return "bg-surface-success-weak text-text-on-success-base"
    case "global":
      return "bg-surface-inset-base text-text-base"
    case "builtin":
      return "bg-surface-inset-base text-text-weaker"
    default:
      return "bg-surface-inset-base text-text-weak"
  }
}

function compatibilityTone(level?: SkillCompatibilityLevel) {
  switch (level) {
    case "native":
      return "bg-surface-success-weak text-text-on-success-base ring-border-success-base"
    case "compatible":
      return "workbench-selected-surface text-text-strong ring-border-base/20"
    case "partial":
      return "bg-surface-inset-base text-text-base ring-icon-warning-base/22"
    default:
      return "bg-surface-inset-base text-text-weaker ring-border-base/25"
  }
}

function compatibilityLabel(level?: SkillCompatibilityLevel, _?: ReturnType<typeof useLingui>["_"]) {
  switch (level) {
    case "native":
      return _ ? _({ id: "app.library.skills.compat.native", message: "native" }) : "native"
    case "compatible":
      return _ ? _({ id: "app.library.skills.compat.compatible", message: "compatible" }) : "compatible"
    case "partial":
      return _ ? _({ id: "app.library.skills.compat.partial", message: "partial" }) : "partial"
    default:
      return undefined
  }
}

export function SkillView(props: {
  sdk: ReturnType<typeof useGlobalSDK>
  search: string
  directory?: string
  scopeID?: string
}) {
  const { _ } = useLingui()
  const dialog = useDialog()
  const platform = usePlatform()
  const scopedClient = createMemo(() => {
    if (!props.directory && !props.scopeID) return props.sdk.client
    return createSynergyClient({
      baseUrl: props.sdk.url,
      fetch: platform.fetch,
      directory: props.directory,
      scopeID: props.scopeID,
      throwOnError: true,
    })
  })
  const [filter, setFilter] = createSignal<SkillScope>("all")
  const [reloading, setReloading] = createSignal(false)
  const [diagnosticsExpanded, setDiagnosticsExpanded] = createSignal(false)

  const [skills, { refetch }] = createResource<SkillListData>(async () => {
    const result = await scopedClient().skill.list()
    return (result.data as SkillListData | undefined) ?? { items: [], diagnostics: [], sources: [] }
  })

  async function reloadSkills() {
    setReloading(true)
    try {
      await scopedClient().skill.reload()
      await refetch()
      showToast({
        type: "success",
        title: _({ id: "app.library.skills.reloaded", message: "Skills reloaded" }),
        description: _({ id: "app.library.skills.reloadedDesc", message: "Skill directories rescanned" }),
      })
    } catch {
      showToast({
        type: "error",
        title: _({ id: "app.library.skills.reloadFailed", message: "Failed to reload skills" }),
      })
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

  const diagnostics = createMemo(() => partitionSkillDiagnostics(skills()?.diagnostics ?? []))

  const diagnosticsSummary = createMemo(() => {
    const { failed, shadowed, compat } = diagnostics()
    const segments: string[] = []
    if (failed.length > 0) {
      segments.push(
        _({
          id: "app.library.skills.diagnostics.failed",
          message: "{count, plural, one {# skill failed to load} other {# skills failed to load}}",
          values: { count: failed.length },
        }),
      )
    }
    if (shadowed.length > 0) {
      segments.push(
        _({
          id: "app.library.skills.diagnostics.shadowed",
          message: "{count, plural, one {# skill shadowed} other {# skills shadowed}}",
          values: { count: shadowed.length },
        }),
      )
    }
    if (compat.length > 0) {
      segments.push(
        _({
          id: "app.library.skills.diagnostics.compat",
          message: "{count, plural, one {# compatibility notice} other {# compatibility notices}}",
          values: { count: compat.length },
        }),
      )
    }
    return segments.join(" · ")
  })

  const diagnosticGroups = createMemo(() => {
    const { failed, shadowed, compat } = diagnostics()
    return [
      {
        title: _({ id: "app.library.skills.diagnostics.failedGroup", message: "Failed to load" }),
        items: failed,
      },
      {
        title: _({ id: "app.library.skills.diagnostics.shadowedGroup", message: "Shadowed" }),
        items: shadowed,
      },
      {
        title: _({ id: "app.library.skills.diagnostics.compatGroup", message: "Compatibility notices" }),
        items: compat,
      },
    ].filter((group) => group.items.length > 0)
  })

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
    await scopedClient().skill.remove({ name })
    await refetch()
    showToast({
      type: "info",
      title: _({ id: "app.library.skills.deleted", message: "Skill deleted" }),
      description: _({
        id: "app.library.skills.deletedDesc",
        message: 'Removed "{name}" from disk',
        values: { name },
      }),
    })
  }

  function openSkillDetail(skill: SkillItem) {
    dialog.show(() => (
      <SkillDetailDialog
        skill={skill}
        exporting={exportingName() === skill.name}
        onExport={skillCanExport(skill) ? () => exportSkill(skill) : undefined}
        onDelete={skill.builtin ? undefined : () => deleteSkill(skill.name)}
        onDeleted={() => dialog.close()}
      />
    ))
  }

  const filterLabel = createMemo(() => {
    switch (filter()) {
      case "project":
        return _({ id: "app.library.skills.filter.project", message: "Project skills" })
      case "global":
        return _({ id: "app.library.skills.filter.global", message: "Global skills" })
      case "builtin":
        return _({ id: "app.library.skills.filter.builtin", message: "Built-in skills" })
      default:
        return _({ id: "app.library.skills.filter.all", message: "All skills" })
    }
  })

  const [importOpen, setImportOpen] = createSignal(false)
  const [importMode, setImportMode] = createSignal<"menu" | "url">("menu")
  const [importUrl, setImportUrl] = createSignal("")
  const [importing, setImporting] = createSignal(false)
  const [importScope, setImportScope] = createSignal<SkillImportScope>("global")
  const [exportingName, setExportingName] = createSignal<string>()
  const importScopeOptions = createMemo(() => skillImportScopeOptions(Boolean(props.directory)))
  const selectedImportScope = createMemo<SkillImportScope>(() =>
    importScopeOptions().includes(importScope()) ? importScope() : "global",
  )
  let fileInputRef!: HTMLInputElement

  function resetImport() {
    setImportMode("menu")
    setImportUrl("")
    setImporting(false)
  }

  function showImportSuccess(data: SkillImportResult | undefined, scope: SkillImportScope) {
    showToast({
      type: "success",
      title: _({ id: "app.library.skills.importSuccess", message: "Skill imported" }),
      description: _({
        id: "app.library.skills.importSuccessDesc",
        message: '"{name}" added to {scope}',
        values: { name: data?.name ?? "", scope: importScopeLabel(data?.scope ?? scope, _) },
      }),
    })
  }

  function showImportError(error: unknown) {
    const presentation = skillImportErrorPresentation(error, _)
    const details = presentation.details.map((item) => `${item.label}: ${item.value}`)
    showToast({
      type: "error",
      title: presentation.title,
      description: [presentation.guidance, ...details].join("\n"),
      persistent: true,
    })
  }

  async function handleFileImport(file: File, scope: SkillImportScope = selectedImportScope()) {
    setImporting(true)
    setImportOpen(false)
    try {
      const result = await scopedClient().skill.import({ file, scope })
      await refetch()
      showImportSuccess(result.data as SkillImportResult | undefined, scope)
    } catch (error) {
      showImportError(error)
    }
    setImporting(false)
    resetImport()
  }

  async function handleUrlImport() {
    const url = importUrl().trim()
    if (!url) return
    const scope = selectedImportScope()
    setImporting(true)
    setImportOpen(false)
    try {
      const result = await scopedClient().skill.importUrl({ url, scope })
      await refetch()
      showImportSuccess(result.data as SkillImportResult | undefined, scope)
    } catch (error) {
      showImportError(error)
    }
    setImporting(false)
    resetImport()
  }

  async function exportSkill(skill: SkillItem) {
    if (!skillCanExport(skill) || exportingName()) return
    setExportingName(skill.name)
    try {
      const result = await scopedClient().skill.export({ name: skill.name, format: "zip" }, { parseAs: "blob" })
      const blob = result.data as Blob
      const url = URL.createObjectURL(blob)
      const link = document.createElement("a")
      link.href = url
      link.download = skillExportFilename(skill, result.response.headers.get("Content-Disposition"))
      document.body.append(link)
      link.click()
      link.remove()
      URL.revokeObjectURL(url)
      showToast({
        type: "success",
        title: _({ id: "app.library.skills.exportSuccess", message: "Skill exported" }),
        description: _({
          id: "app.library.skills.exportSuccessDesc",
          message: 'Downloaded "{name}" as a ZIP archive',
          values: { name: skill.name },
        }),
      })
    } catch (error) {
      const presentation = skillExportErrorPresentation(error, _)
      showToast({
        type: "error",
        title: _({ id: "app.library.skills.exportFailed", message: "Export failed" }),
        description: [presentation.title, ...presentation.details.map((item) => `${item.label}: ${item.value}`)].join(
          "\n",
        ),
        persistent: true,
      })
    }
    setExportingName(undefined)
  }

  return (
    <div class="library-list-pane">
      <div class="library-list-toolbar">
        <div class="library-toolbar-left">
          <MenuField
            value={filter()}
            ariaLabel={_({ id: "app.library.skills.filter.aria", message: "Filter skills" })}
            triggerLabel={filterLabel()}
            placement="bottom-start"
            surfaceClass="library-filter-menu"
            options={[
              {
                value: "all",
                label: _({ id: "app.library.skills.filter.all", message: "All skills" }),
                count: (skills()?.items ?? []).length,
              },
              ...(scopeCounts().project > 0
                ? [
                    {
                      value: "project",
                      label: _({ id: "app.library.skills.filterOption.project", message: "Project" }),
                      count: scopeCounts().project,
                    },
                  ]
                : []),
              ...(scopeCounts().global > 0
                ? [
                    {
                      value: "global",
                      label: _({ id: "app.library.skills.filterOption.global", message: "Global" }),
                      count: scopeCounts().global,
                    },
                  ]
                : []),
              ...(scopeCounts().builtin > 0
                ? [
                    {
                      value: "builtin",
                      label: _({ id: "app.library.skills.filterOption.builtin", message: "Built-in" }),
                      count: scopeCounts().builtin,
                    },
                  ]
                : []),
            ]}
            onChange={(value) => setFilter(value as SkillScope)}
          />
          <span class="library-toolbar-summary">
            {_({
              id: "app.library.skills.count",
              message: "{count} skills",
              values: { count: String(filtered().length) },
            })}
          </span>
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
              <Show
                when={importing()}
                fallback={<Icon name={getSemanticIcon("action.import")} size="small" class="opacity-70" />}
              >
                <Spinner class="size-3" />
              </Show>
              <span>{_({ id: "app.library.skills.import", message: "Import" })}</span>
            </Popover.Trigger>
            <Popover.Portal>
              <Popover.Content class={`w-64 ${libraryMenuClass}`}>
                <Show when={importScopeOptions().length > 1}>
                  <div class="border-b border-border-base/35 px-3 py-2.5">
                    <div class={libraryMetaLabelClass}>
                      {_({ id: "app.library.skills.import.destination", message: "Destination" })}
                    </div>
                    <AppPanel.Selection
                      class="mt-2"
                      label={_({ id: "app.library.skills.import.destination", message: "Destination" })}
                      items={importScopeOptions().map((scope) => ({ id: scope, label: importScopeLabel(scope, _) }))}
                      active={selectedImportScope()}
                      onChange={(scope) => setImportScope(scope as SkillImportScope)}
                    />
                  </div>
                </Show>
                <Show when={importMode() === "menu"}>
                  <div class="flex flex-col gap-0.5">
                    <button
                      type="button"
                      class="menu-field-item"
                      onClick={() => {
                        setImportOpen(false)
                        fileInputRef.click()
                      }}
                    >
                      <Icon name={getSemanticIcon("workspace.add")} size="small" class="text-icon-weak-base shrink-0" />
                      <div class="min-w-0 flex-1">
                        <div class="app-panel-control text-text-base">
                          {_({ id: "app.library.skills.import.uploadArchive", message: "Upload archive" })}
                        </div>
                        <div class="app-panel-caption text-text-weaker">
                          {_({
                            id: "app.library.skills.import.uploadArchiveDesc",
                            message: "Import a local .zip or .skill archive",
                          })}
                        </div>
                      </div>
                    </button>
                    <button type="button" class="menu-field-item" onClick={() => setImportMode("url")}>
                      <Icon name={getSemanticIcon("browser.main")} size="small" class="text-icon-weak-base shrink-0" />
                      <div class="min-w-0 flex-1">
                        <div class="app-panel-control text-text-base">
                          {_({ id: "app.library.skills.import.fromUrl", message: "From URL" })}
                        </div>
                        <div class="app-panel-caption text-text-weaker">
                          {_({
                            id: "app.library.skills.import.fromUrlDesc",
                            message: "Download a .zip or .skill archive",
                          })}
                        </div>
                      </div>
                    </button>
                  </div>
                </Show>
                <Show when={importMode() === "url"}>
                  <div class="flex flex-col gap-2.5 p-3">
                    <div>
                      <div class={libraryMetaLabelClass}>
                        {_({ id: "app.library.skills.import.label", message: "Import" })}
                      </div>
                      <div class="mt-1 app-panel-caption font-medium text-text-strong">
                        {_({ id: "app.library.skills.import.fromUrlHeading", message: "Import from URL" })}
                      </div>
                    </div>
                    <input
                      type="url"
                      placeholder={_({
                        id: "app.library.skills.import.urlPlaceholder",
                        message: "https://example.com/skill.zip",
                      })}
                      class="w-full rounded-[0.95rem] border border-border-base/38 bg-surface-inset-base px-3 py-2.5 app-panel-control text-text-base outline-none ring-1 ring-inset ring-border-base/35 transition-colors placeholder:text-text-weak focus:border-border-base/50 focus:bg-surface-inset-base"
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
                        class="rounded-full px-3 py-1.5 app-panel-caption font-medium text-text-weak ring-1 ring-inset ring-border-base/45 transition-all hover:bg-surface-inset-base hover:text-text-base"
                        onClick={() => setImportMode("menu")}
                      >
                        {_({ id: "app.library.skills.import.back", message: "Back" })}
                      </button>
                      <button
                        type="button"
                        classList={{
                          "rounded-full px-3.5 py-1.5 app-panel-caption font-medium ring-1 ring-inset transition-all": true,
                          "bg-text-strong text-background-base ring-border-base/20 hover:opacity-90":
                            !!importUrl().trim(),
                          "bg-surface-inset-base text-text-weaker ring-border-base/35 pointer-events-none":
                            !importUrl().trim(),
                        }}
                        disabled={!importUrl().trim()}
                        onClick={handleUrlImport}
                      >
                        {_({ id: "app.library.skills.import.button", message: "Import" })}
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
            accept={skillImportAccept()}
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
            <Show
              when={reloading()}
              fallback={<Icon name={getSemanticIcon("action.refresh")} size="small" class="opacity-70" />}
            >
              <Spinner class="size-3" />
            </Show>
            <span>{_({ id: "app.library.skills.reload", message: "Reload" })}</span>
          </button>
        </div>
      </div>

      <Show when={skills.loading}>
        <AppPanel.Loading />
      </Show>

      <Show when={!skills.loading}>
        <Show when={diagnosticGroups().length > 0}>
          <div class="mb-3 rounded-[1.15rem] border border-border-warning-base/35 bg-surface-warning-weak px-4 py-3 ring-1 ring-inset ring-border-weaker-base">
            <button
              type="button"
              class="flex w-full cursor-pointer items-center gap-2 app-panel-caption font-medium text-text-strong"
              onClick={() => setDiagnosticsExpanded((prev) => !prev)}
            >
              <Icon name={getSemanticIcon("state.warning")} size="small" class="text-icon-warning-base shrink-0" />
              <span class="flex-1 text-left">{diagnosticsSummary()}</span>
              <Icon
                name={getSemanticIcon("navigation.expand")}
                size="small"
                class="shrink-0 text-text-weaker transition-transform duration-180"
                classList={{ "rotate-90": diagnosticsExpanded() }}
              />
            </button>
            <Show when={diagnosticsExpanded()}>
              <div class="mt-2 flex flex-col gap-2">
                <For each={diagnosticGroups()}>
                  {(group) => (
                    <div class="flex flex-col gap-2">
                      <div class="mt-1 app-panel-caption font-medium text-text-weaker">{group.title}</div>
                      <For each={group.items}>
                        {(item) => (
                          <div class={`rounded-[0.95rem] px-3 py-2 ${libraryInsetClass}`}>
                            <div class="app-panel-caption font-medium text-text-strong">{item.name}</div>
                            <div class="mt-0.5 app-panel-caption text-text-diff-delete-base break-words">
                              {item.message}
                            </div>
                            <div class="mt-1 app-panel-caption text-text-weaker break-all">{item.path}</div>
                          </div>
                        )}
                      </For>
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
              icon={getSemanticIcon("command.rmslop")}
              title={
                props.search
                  ? _({
                      id: "app.library.skills.empty.search",
                      message: 'No skills match "{query}"',
                      values: { query: props.search },
                    })
                  : _({ id: "app.library.skills.empty.none", message: "No skills loaded" })
              }
              description={_({
                id: "app.library.skills.empty.hint",
                message: "Skills are loaded from SKILL.md files in .synergy/skill/ directories. Use Reload to rescan.",
              })}
            />
          }
        >
          <div class="library-skill-grid">
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
  const { _ } = useLingui()
  const scopeLabel = () => skillScopeLabel(props.skill, _)
  const displayLocation = () => skillPathLabel(props.skill.location)
  const compatibility = () => compatibilityLabel(props.skill.compatibility?.level, _)
  const declaredCompatibility = () => skillDeclaredCompatibility(props.skill)
  const diagnostics = () => skillCanonicalDiagnostics(props.skill)

  return (
    <button
      type="button"
      class={`${libraryCardBaseClass} ${libraryCardHoverClass} library-skill-card text-left`}
      onClick={props.onOpen}
      aria-haspopup="dialog"
      aria-label={_({
        id: "app.library.skills.card.openDetails",
        message: "Open details for {name}",
        values: { name: props.skill.name },
      })}
    >
      <span class="library-skill-card-title app-panel-row-title text-text-strong line-clamp-2">{props.skill.name}</span>
      <span class="app-panel-copy text-text-weak line-clamp-2">{props.skill.description}</span>
      <span class="library-skill-card-meta app-panel-caption text-text-weak">
        <Show when={scopeLabel()}>
          <span>{scopeLabel()}</span>
        </Show>
        <span>{skillInvocationLabel(props.skill, _)}</span>
        <Show when={compatibility()}>
          <span class={compatibilityTone(props.skill.compatibility?.level)}>{compatibility()}</span>
        </Show>
        <Show when={diagnostics().length}>
          <span>
            {_({
              id: "app.library.skills.card.diagnosticsCount",
              message: "{count, plural, one {# diagnostic} other {# diagnostics}}",
              values: { count: diagnostics().length },
            })}
          </span>
        </Show>
      </span>
      <Show when={displayLocation()}>
        <span class="app-panel-caption text-text-weaker truncate" title={props.skill.location}>
          {displayLocation()}
        </span>
      </Show>
    </button>
  )
}

function SkillDetailDialog(props: {
  skill: SkillItem
  exporting: boolean
  onExport?: () => Promise<void>
  onDelete?: () => Promise<void>
  onDeleted: () => void
}) {
  const { _ } = useLingui()
  const dialog = useDialog()
  const confirm = useConfirm()
  const scopeLabel = () => skillScopeLabel(props.skill, _)
  const displayLocation = () => skillPathLabel(props.skill.location)
  const displayEntryFile = () => skillPathLabel(props.skill.entryFile)
  const displayBaseDir = () => skillPathLabel(props.skill.baseDir)
  const compatibility = () => props.skill.compatibility
  const declaredCompatibility = () => skillDeclaredCompatibility(props.skill)
  const diagnostics = () => skillCanonicalDiagnostics(props.skill)

  async function handleDelete() {
    if (!props.onDelete) return
    await props.onDelete()
    props.onDeleted()
  }

  function requestDelete() {
    if (!props.onDelete) return
    confirm.show({
      ...deleteSkillConfirm(props.skill.name),
      onConfirm: handleDelete,
    })
  }

  return (
    <Dialog
      size="wide"
      title={<span class="min-w-0 truncate">{props.skill.name}</span>}
      class="app-panel-detail-dialog dialog-skill-detail"
    >
      <div class="skill-detail-shell">
        <div class="skill-detail-scroll">
          <div class="skill-detail-meta-row">
            <Show when={scopeLabel()}>
              <span class={`skill-detail-chip ${skillScopeColor(props.skill)}`}>{scopeLabel()}</span>
            </Show>
            <Show when={props.skill.source}>
              <span class="skill-detail-chip skill-detail-chip-muted">{props.skill.source}</span>
            </Show>
            <span class="skill-detail-chip skill-detail-chip-muted">{skillInvocationLabel(props.skill, _)}</span>
            <Show when={declaredCompatibility()}>
              <span class="skill-detail-chip skill-detail-chip-muted">{declaredCompatibility()}</span>
            </Show>
            <Show when={compatibilityLabel(props.skill.compatibility?.level)}>
              <span class={`skill-detail-chip ${compatibilityTone(props.skill.compatibility?.level)}`}>
                {_({
                  id: "app.library.skills.card.compatLabel",
                  message: "{level} compatibility",
                  values: { level: compatibilityLabel(props.skill.compatibility?.level) ?? "" },
                })}
              </span>
            </Show>
          </div>

          <SkillDetailSection label={_({ id: "app.library.skills.detail.description", message: "Description" })}>
            <div class="skill-detail-description">{props.skill.description}</div>
          </SkillDetailSection>

          <Show when={displayLocation() || displayEntryFile() || displayBaseDir()}>
            <SkillDetailSection label={_({ id: "app.library.skills.detail.location", message: "Location" })}>
              <div class="skill-detail-rows">
                <Show when={displayLocation()}>
                  <SkillDetailRow
                    label={_({ id: "app.library.skills.detail.skillPath", message: "Skill path" })}
                    value={displayLocation()!}
                    title={props.skill.location}
                  />
                </Show>
                <Show when={displayEntryFile()}>
                  <SkillDetailRow
                    label={_({ id: "app.library.skills.detail.entryFile", message: "Entry file" })}
                    value={displayEntryFile()!}
                    title={props.skill.entryFile}
                  />
                </Show>
                <Show when={displayBaseDir()}>
                  <SkillDetailRow
                    label={_({ id: "app.library.skills.detail.baseDir", message: "Base directory" })}
                    value={displayBaseDir()!}
                    title={props.skill.baseDir}
                  />
                </Show>
              </div>
            </SkillDetailSection>
          </Show>

          <SkillDetailSection label={_({ id: "app.library.skills.detail.invocation", message: "Invocation" })}>
            <div class="skill-detail-rows">
              <SkillDetailRow
                label={_({ id: "app.library.skills.detail.invocationStatus", message: "Status" })}
                value={skillInvocationLabel(props.skill, _)}
                mono={false}
              />
            </div>
          </SkillDetailSection>

          <Show when={compatibility()}>
            <SkillDetailSection label={_({ id: "app.library.skills.detail.compatibility", message: "Compatibility" })}>
              <div class="skill-detail-rows">
                <SkillDetailRow
                  label={_({ id: "app.library.skills.detail.compatLevel", message: "Level" })}
                  value={compatibilityLabel(compatibility()?.level, _) ?? "unknown"}
                  mono={false}
                />
                <Show when={declaredCompatibility()}>
                  <SkillDetailRow
                    label={_({ id: "app.library.skills.detail.declaredCompatibility", message: "Declared" })}
                    value={declaredCompatibility()!}
                    mono={false}
                  />
                </Show>
              </div>
            </SkillDetailSection>
          </Show>

          <Show when={diagnostics().length > 0}>
            <SkillDetailSection label={_({ id: "app.library.skills.detail.diagnostics", message: "Diagnostics" })}>
              <div class="skill-detail-code-list">
                <For each={diagnostics()}>
                  {(item) => (
                    <div class="skill-detail-diagnostic-row">
                      <div class="skill-detail-diagnostic-title">{item.code}</div>
                      <div class="skill-detail-diagnostic-message">{item.message}</div>
                      <Show when={item.path}>
                        <div class="skill-detail-diagnostic-path">{item.path}</div>
                      </Show>
                    </div>
                  )}
                </For>
              </div>
            </SkillDetailSection>
          </Show>
        </div>

        <div class="skill-detail-footer">
          <Show when={props.onDelete}>
            <button type="button" class="skill-detail-button skill-detail-button-danger" onClick={requestDelete}>
              {_({ id: "app.library.skills.detail.delete", message: "Delete skill" })}
            </button>
          </Show>
          <Show when={props.onExport}>
            <button
              type="button"
              class="skill-detail-button skill-detail-button-secondary ml-auto"
              onClick={() => void props.onExport?.()}
              disabled={props.exporting}
              aria-label={_({
                id: "app.library.skills.detail.exportZipAria",
                message: "Export {name} as a ZIP archive",
                values: { name: props.skill.name },
              })}
            >
              <Show when={props.exporting} fallback={<Icon name={getSemanticIcon("action.export")} size="small" />}>
                <Spinner class="size-3" />
              </Show>
              {props.exporting
                ? _({ id: "app.library.skills.detail.exporting", message: "Exporting..." })
                : _({ id: "app.library.skills.detail.exportZip", message: "Export ZIP" })}
            </button>
          </Show>
          <button
            type="button"
            classList={{
              "skill-detail-button skill-detail-button-secondary": true,
              "ml-auto": !props.onExport,
            }}
            onClick={() => dialog.close()}
          >
            {_({ id: "app.library.skills.detail.close", message: "Close" })}
          </button>
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
