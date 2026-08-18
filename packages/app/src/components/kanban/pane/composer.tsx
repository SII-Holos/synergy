import { For, Show, createMemo, createSignal } from "solid-js"
import { useLingui } from "@lingui/solid"
import type { MessageDescriptor } from "@lingui/core"
import type { Agent, Session, SessionStatus } from "@ericsanchezok/synergy-sdk/client"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { Popover } from "@ericsanchezok/synergy-ui/popover"
import { showToast } from "@ericsanchezok/synergy-ui/toast"
import type { ControlProfileId } from "@/context/input"
import { useLocale } from "@/context/locale"
import { PERMISSION_MODES, permissionModeVisual } from "@/components/prompt-input/permission-modes"
import { kanbanPage } from "@/locales/messages"
import { translateDescriptor } from "@/locales/translate"

/** Workflow kinds the board composer can set (lightloop needs extra prompts). */
export type BoardWorkflowKind = "none" | "plan" | "lattice" | "boss"

function workflowKindOf(session: Session | undefined): BoardWorkflowKind {
  const kind = session?.workflow?.kind
  if (kind === "plan") return "plan"
  if (kind === "lattice") return "lattice"
  if (kind === "boss") return "boss"
  return "none"
}

function workflowLabel(kind: BoardWorkflowKind, _: (d: { id: string; message: string }) => string): string {
  switch (kind) {
    case "plan":
      return _(kanbanPage.workflowPlan)
    case "lattice":
      return _(kanbanPage.workflowLattice)
    case "boss":
      return _(kanbanPage.workflowBoss)
    case "none":
      return _(kanbanPage.workflowNone)
  }
}

/**
 * Full-featured board composer: agent picker (applies to the next send),
 * control-profile selector, orchestration-mode menu, and a status bar —
 * all backed by the same backend operations the session page uses, but
 * targeted at this pane's scope/session through the injected client.
 */
export function KanbanPaneComposer(props: {
  sessionID: string
  agents: Agent[]
  session?: Session
  status?: SessionStatus
  onSend: (text: string, options?: { agent?: string }) => Promise<void>
  onUpdateProfile: (profile: ControlProfileId) => Promise<void>
  onSetWorkflow: (kind: BoardWorkflowKind) => Promise<void>
}) {
  const { _ } = useLingui()
  const { controller, i18n } = useLocale()
  const translateModeCopy = (descriptor: MessageDescriptor) => {
    controller.activeLocale()
    return translateDescriptor(descriptor, i18n)
  }
  const [draft, setDraft] = createSignal("")
  const [sending, setSending] = createSignal(false)
  const [agent, setAgent] = createSignal<string | undefined>(props.session?.agentOverride)

  const profile = createMemo<ControlProfileId>(() => props.session?.controlProfile ?? "guarded")
  const workflow = createMemo<BoardWorkflowKind>(() => workflowKindOf(props.session))
  const profileVisual = createMemo(() => permissionModeVisual(profile()))
  const statusText = createMemo(() => {
    const s = props.status
    if (!s || s.type === "idle") return _(kanbanPage.statusIdle)
    if (s.type === "busy") return s.description ?? _(kanbanPage.statusBusy)
    if (s.type === "retry") return _(kanbanPage.statusRetry)
    if (s.type === "recovering") return _(kanbanPage.statusRecovering)
    return ""
  })
  const visibleAgents = createMemo(() => props.agents.filter((a) => !a.hidden && a.mode !== "subagent"))
  const currentAgent = createMemo(() => agent() ?? visibleAgents()[0]?.name ?? _(kanbanPage.composerDefaultAgent))

  const run = async (action: () => Promise<void>) => {
    try {
      await action()
    } catch (error) {
      showToast({
        type: "error",
        title: _(kanbanPage.sendFailed),
        description: error instanceof Error ? error.message : undefined,
      })
    }
  }

  const submitDraft = async () => {
    const text = draft().trim()
    if (!text || sending()) return
    setSending(true)
    try {
      await props.onSend(text, { agent: agent() })
      setDraft("")
    } catch (error) {
      showToast({
        type: "error",
        title: _(kanbanPage.sendFailed),
        description: error instanceof Error ? error.message : undefined,
      })
    } finally {
      setSending(false)
    }
  }

  return (
    <div class="kanban-pane-composer">
      <div class="kanban-pane-composer-toolbar">
        <Show when={visibleAgents().length > 0}>
          <Popover
            trigger={
              <button class="kanban-composer-chip" title={_(kanbanPage.composerAgent)}>
                <Icon name={getSemanticIcon("agents.main")} size="small" />
                <span class="kanban-composer-chip-label">{currentAgent()}</span>
              </button>
            }
            title={_(kanbanPage.composerAgent)}
          >
            <div class="kanban-pane-span-menu" role="listbox" aria-label={_(kanbanPage.composerAgent)}>
              <For each={visibleAgents()}>
                {(candidate) => (
                  <button
                    class="kanban-pane-span-item"
                    data-active={candidate.name === currentAgent() || undefined}
                    onClick={() => setAgent(candidate.name)}
                  >
                    {candidate.name}
                  </button>
                )}
              </For>
            </div>
          </Popover>
        </Show>
        <Popover
          trigger={
            <button class="kanban-composer-chip" title={_(kanbanPage.composerPermission)}>
              <Icon name={getSemanticIcon(profileVisual().icon)} size="small" />
              <span class="kanban-composer-chip-label">{translateModeCopy(profileVisual().shortLabel)}</span>
            </button>
          }
          title={_(kanbanPage.composerPermission)}
        >
          <div class="kanban-pane-span-menu" role="listbox" aria-label={_(kanbanPage.composerPermission)}>
            <For each={PERMISSION_MODES}>
              {(mode) => (
                <button
                  class="kanban-pane-span-item"
                  data-active={mode.id === profile() || undefined}
                  onClick={() => void run(() => props.onUpdateProfile(mode.id))}
                >
                  {translateModeCopy(mode.label)}
                </button>
              )}
            </For>
          </div>
        </Popover>
        <Popover
          trigger={
            <button class="kanban-composer-chip" title={_(kanbanPage.composerWorkflow)}>
              <Icon name={getSemanticIcon("cortex.main")} size="small" />
              <span class="kanban-composer-chip-label">{workflowLabel(workflow(), _)}</span>
            </button>
          }
          title={_(kanbanPage.composerWorkflow)}
        >
          <div class="kanban-pane-span-menu" role="listbox" aria-label={_(kanbanPage.composerWorkflow)}>
            <For each={["none", "plan", "lattice", "boss"] as const}>
              {(kind) => (
                <button
                  class="kanban-pane-span-item"
                  data-active={kind === workflow() || undefined}
                  onClick={() => void run(() => props.onSetWorkflow(kind))}
                >
                  {workflowLabel(kind, _)}
                </button>
              )}
            </For>
          </div>
        </Popover>
      </div>
      <form
        class="kanban-pane-composer-input-row"
        onSubmit={(event) => {
          event.preventDefault()
          void submitDraft()
        }}
      >
        <input
          class="kanban-pane-input"
          type="text"
          value={draft()}
          placeholder={_(kanbanPage.sendPlaceholder)}
          disabled={sending()}
          onInput={(event) => setDraft(event.currentTarget.value)}
        />
        <button class="kanban-pane-send" type="submit" disabled={sending() || !draft().trim()}>
          <Icon name={getSemanticIcon("prompt.send")} size="small" />
        </button>
      </form>
      <div class="kanban-pane-statusbar">
        <span class={`kanban-status-dot kanban-status-dot-${props.status?.type ?? "idle"}`} aria-hidden="true" />
        <span class="kanban-status-text">{statusText()}</span>
        <span class="kanban-status-sep" aria-hidden="true" />
        <span class="kanban-status-meta">
          {_(kanbanPage.composerAgent)}: {currentAgent()}
        </span>
        <span class="kanban-status-meta">
          {_(kanbanPage.composerPermission)}: {translateModeCopy(profileVisual().shortLabel)}
        </span>
        <span class="kanban-status-meta">
          {_(kanbanPage.composerWorkflow)}: {workflowLabel(workflow(), _)}
        </span>
      </div>
    </div>
  )
}
