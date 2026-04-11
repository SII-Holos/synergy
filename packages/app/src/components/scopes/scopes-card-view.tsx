import { createMemo, createSignal, For, Show } from "solid-js"
import { useNavigate, useParams } from "@solidjs/router"
import { Popover } from "@kobalte/core/popover"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { Avatar } from "@ericsanchezok/synergy-ui/avatar"
import { Tooltip } from "@ericsanchezok/synergy-ui/tooltip"
import { base64Decode, base64Encode } from "@ericsanchezok/synergy-util/encode"
import { getFilename } from "@ericsanchezok/synergy-util/path"
import { getAvatarColors, type AvatarColorKey } from "@/context/layout"
import { useGlobalSync } from "@/context/global-sync"
import { useGlobalSDK } from "@/context/global-sdk"
import { useCommand } from "@/context/command"
import { usePanel } from "@/context/panel"
import { useServer } from "@/context/server"
import { Panel } from "@/components/panel"
import { relativeTime } from "@/utils/time"
import type { Session } from "@ericsanchezok/synergy-sdk/client"

const AVATAR_COLOR_KEYS: AvatarColorKey[] = ["pink", "mint", "orange", "purple", "cyan", "lime"]

const colorSwatchStyles: Record<AvatarColorKey, string> = {
  pink: "bg-[var(--avatar-background-pink)]",
  mint: "bg-[var(--avatar-background-mint)]",
  orange: "bg-[var(--avatar-background-orange)]",
  purple: "bg-[var(--avatar-background-purple)]",
  cyan: "bg-[var(--avatar-background-cyan)]",
  lime: "bg-[var(--avatar-background-lime)]",
}

export function ScopesCardView() {
  const globalSync = useGlobalSync()
  const globalSDK = useGlobalSDK()
  const params = useParams()
  const command = useCommand()
  const panel = usePanel()
  const server = useServer()
  const navigate = useNavigate()

  const [search, setSearch] = createSignal("")

  const currentDir = createMemo(() => (params.dir ? base64Decode(params.dir) : undefined))
  const homePath = createMemo(() => globalSync.data.path?.home)

  const allScopes = createMemo(() => {
    const seen = new Set<string>()
    return [...globalSync.data.scope]
      .filter((s) => {
        if (s.worktree === homePath()) return false
        if (seen.has(s.id)) return false
        seen.add(s.id)
        return true
      })
      .sort((a, b) => {
        const ta = a.time?.updated ?? a.time?.created ?? 0
        const tb = b.time?.updated ?? b.time?.created ?? 0
        return tb - ta
      })
  })

  const filteredScopes = createMemo(() => {
    const q = search().toLowerCase().trim()
    if (!q) return allScopes()
    return allScopes().filter((p) => {
      const name = (p.name || getFilename(p.worktree)).toLowerCase()
      return name.includes(q) || p.worktree.toLowerCase().includes(q)
    })
  })

  function scopeMeta(worktree: string, sandboxes?: string[]) {
    const dirs = [worktree, ...(sandboxes ?? [])]
    let sessions: Session[] = []
    let branch: string | undefined
    for (const dir of dirs) {
      const [store] = globalSync.child(dir)
      sessions = sessions.concat(store.session.filter((s: Session) => !s.parentID))
      if (!branch && store.vcs?.branch) branch = store.vcs.branch
    }
    sessions.sort((a: Session, b: Session) => {
      const ta = a.time?.updated ?? a.time?.created ?? 0
      const tb = b.time?.updated ?? b.time?.created ?? 0
      return tb - ta
    })
    const latest = sessions[0]
    return {
      count: sessions.length,
      branch,
      latestTitle: latest?.title,
      latestTime: latest?.time?.updated ?? latest?.time?.created,
    }
  }

  return (
    <Panel.Root>
      <Panel.Header>
        <Panel.HeaderRow>
          <Panel.Title>Projects</Panel.Title>
          <Panel.Count>{allScopes().length} projects</Panel.Count>
        </Panel.HeaderRow>
        <Panel.Search value={search()} onInput={setSearch} placeholder="Search projects..." />
      </Panel.Header>

      <Panel.Body padding="tight">
        <button
          type="button"
          class="w-full flex items-center justify-center gap-2 px-3 py-2.5 mb-3 rounded-xl border border-dashed border-border-base/50 text-13-medium text-text-weak hover:text-text-interactive-base hover:border-text-interactive-base/30 hover:bg-surface-interactive-base/5 transition-all duration-150 cursor-pointer"
          onClick={() => command.trigger("project.open")}
        >
          <Icon name="folder-plus" size="small" />
          <span>New project</span>
        </button>
        <Show when={filteredScopes().length > 0}>
          <div class="grid grid-cols-2 gap-2">
            <For each={filteredScopes()}>
              {(project, index) => {
                const meta = createMemo(() => scopeMeta(project.worktree, project.sandboxes))
                return (
                  <ScopeCard
                    name={project.name || getFilename(project.worktree)}
                    worktree={project.worktree}
                    index={index}
                    iconUrl={project.icon?.url}
                    iconColor={project.icon?.color}
                    vcs={project.vcs}
                    branch={meta().branch}
                    sessions={meta().count}
                    latestTitle={meta().latestTitle}
                    latestTime={meta().latestTime}
                    updatedAt={project.time?.updated ?? project.time?.created}
                    isActive={(() => {
                      const dir = currentDir()
                      if (!dir) return false
                      return dir === project.worktree || (project.sandboxes ?? []).includes(dir)
                    })()}
                    onEnter={() => panel.scopes.open(project.worktree)}
                    onNewSession={() => {
                      navigate(`/${base64Encode(project.worktree)}/session`)
                      panel.close()
                    }}
                    onUpdateName={async (name) => {
                      await globalSDK.client.scope.update({ scopeID: project.id, name: name || undefined })
                    }}
                    onUpdateColor={async (color) => {
                      await globalSDK.client.scope.update({ scopeID: project.id, icon: { color } })
                    }}
                    onRemove={async () => {
                      await globalSDK.client.scope.remove({ scopeID: project.id })

                      const directories = [project.worktree, ...(project.sandboxes ?? [])]
                      for (const directory of directories) {
                        server.scopes.close(directory)
                      }

                      const dir = currentDir()
                      if (dir && directories.includes(dir)) {
                        navigate(`/${base64Encode("global")}/session`, { replace: true })
                      }
                    }}
                  />
                )
              }}
            </For>
          </div>
        </Show>

        <Show when={filteredScopes().length === 0 && search()}>
          <Panel.Empty icon="search" title={`No projects match "${search()}"`} />
        </Show>

        <Show when={filteredScopes().length === 0 && !search() && allScopes().length === 0}>
          <Panel.Empty icon="folder" title="No projects yet" description="Open a project directory to get started." />
        </Show>
      </Panel.Body>
    </Panel.Root>
  )
}

function ScopeCard(props: {
  name: string
  worktree: string
  index: () => number
  iconUrl?: string
  iconColor?: string
  vcs?: string
  branch?: string
  sessions: number
  latestTitle?: string
  latestTime?: number
  updatedAt?: number
  isActive: boolean
  onEnter: () => void
  onNewSession: () => void
  onUpdateName: (name: string) => Promise<void>
  onUpdateColor: (color: string) => Promise<void>
  onRemove: () => Promise<void>
}) {
  const colors = createMemo(() => getAvatarColors(props.iconColor))
  const [settingsOpen, setSettingsOpen] = createSignal(false)
  const [removing, setRemoving] = createSignal(false)

  async function handleRemove() {
    setRemoving(true)
    try {
      await props.onRemove()
      setSettingsOpen(false)
    } catch {}
    setRemoving(false)
  }

  return (
    <div
      classList={{
        "group/card relative flex flex-col rounded-xl p-3 transition-all cursor-pointer border overflow-hidden": true,
        "bg-surface-raised-base-hover border-text-interactive-base/25 shadow-sm": props.isActive,
        "bg-surface-raised-base border-border-base/25 hover:bg-surface-raised-base-hover hover:border-border-base/40 hover:shadow-md hover:-translate-y-0.5":
          !props.isActive,
      }}
      style={{
        animation: `cardPopIn 0.35s cubic-bezier(0.34, 1.56, 0.64, 1) both`,
        "animation-delay": `${props.index() * 50}ms`,
      }}
      onClick={props.onEnter}
    >
      <div class="flex items-center gap-2.5 mb-2">
        <Avatar
          fallback={props.name}
          src={props.iconUrl}
          size="small"
          background={colors().background}
          foreground={colors().foreground}
        />
        <div class="flex-1 min-w-0">
          <div
            classList={{
              "text-13-medium truncate leading-tight": true,
              "text-text-strong": props.isActive,
              "text-text-base": !props.isActive,
            }}
          >
            {props.name}
          </div>
        </div>
      </div>

      <div class="flex flex-col gap-1 min-w-0">
        <Show when={props.branch}>
          <div class="flex items-center gap-1.5 min-w-0">
            <Icon name="git-branch" size="small" class="text-icon-weaker shrink-0 size-3" />
            <span class="text-11-regular text-text-weak truncate">{props.branch}</span>
          </div>
        </Show>

        <div class="flex items-center gap-1.5 text-11-regular text-text-weak">
          <Show when={props.sessions > 0}>
            <span>{props.sessions} sessions</span>
          </Show>
          <Show when={props.sessions > 0 && props.vcs}>
            <span class="text-text-weaker">·</span>
          </Show>
          <Show when={props.vcs}>
            <span>{props.vcs}</span>
          </Show>
          <Show when={!props.sessions && !props.vcs && props.updatedAt}>
            <span>{relativeTime(props.updatedAt!)}</span>
          </Show>
        </div>

        <Show when={props.latestTitle}>
          <div class="flex items-center gap-1.5 min-w-0 mt-0.5">
            <Icon name="message-square" size="small" class="text-icon-weaker shrink-0 size-3" />
            <span class="text-11-regular text-text-weaker truncate">{props.latestTitle}</span>
          </div>
        </Show>
      </div>

      <div
        class="absolute top-2 right-2 flex items-center gap-0.5 opacity-0 group-hover/card:opacity-100 focus-within:opacity-100 transition-opacity z-10"
        classList={{ "opacity-100": settingsOpen() }}
      >
        <Tooltip value="New session" placement="bottom">
          <button
            type="button"
            class="flex items-center justify-center size-6 rounded-md text-icon-weak hover:text-text-interactive-base hover:bg-surface-interactive-base/10 transition-all duration-150"
            onClick={(e: MouseEvent) => {
              e.stopPropagation()
              props.onNewSession()
            }}
          >
            <Icon name="plus" size="small" />
          </button>
        </Tooltip>

        <Popover open={settingsOpen()} onOpenChange={setSettingsOpen} placement="bottom-end" gutter={4}>
          <Popover.Trigger
            as="button"
            class="flex items-center justify-center size-6 rounded-md text-icon-weak hover:text-icon-base hover:bg-surface-raised-base-active transition-all duration-150"
            onClick={(e: MouseEvent) => e.stopPropagation()}
          >
            <Icon name="ellipsis" size="small" />
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Content
              class="w-52 rounded-xl border border-border-base/40 bg-surface-raised-stronger-non-alpha shadow-lg z-50 outline-none overflow-hidden p-3 flex flex-col gap-3"
              onClick={(e: MouseEvent) => e.stopPropagation()}
            >
              <input
                type="text"
                class="w-full px-2.5 py-1.5 rounded-lg border border-border-base bg-surface-inset-base text-12-regular text-text-base outline-none focus:border-border-base transition-colors"
                value={props.name}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    props.onUpdateName(e.currentTarget.value.trim())
                    setSettingsOpen(false)
                  }
                  if (e.key === "Escape") setSettingsOpen(false)
                }}
                onBlur={(e) => props.onUpdateName(e.currentTarget.value.trim())}
              />
              <div class="flex items-center gap-1.5">
                <For each={AVATAR_COLOR_KEYS}>
                  {(color) => (
                    <button
                      type="button"
                      classList={{
                        "size-5 rounded-full transition-all": true,
                        [colorSwatchStyles[color]]: true,
                        "ring-2 ring-text-interactive-base ring-offset-1 ring-offset-[var(--surface-raised-stronger-non-alpha)]":
                          props.iconColor === color,
                        "hover:scale-110": props.iconColor !== color,
                      }}
                      onClick={() => props.onUpdateColor(color)}
                    />
                  )}
                </For>
              </div>
              <button
                type="button"
                classList={{
                  "w-full px-2.5 py-1.5 rounded-lg text-11-medium transition-colors": true,
                  "bg-text-diff-delete-base/10 text-text-diff-delete-base hover:bg-text-diff-delete-base/20":
                    !removing(),
                  "opacity-50 pointer-events-none bg-text-diff-delete-base/10 text-text-diff-delete-base": removing(),
                }}
                onClick={handleRemove}
                disabled={removing()}
              >
                {removing() ? "Removing..." : "Remove"}
              </button>
            </Popover.Content>
          </Popover.Portal>
        </Popover>
      </div>
    </div>
  )
}
