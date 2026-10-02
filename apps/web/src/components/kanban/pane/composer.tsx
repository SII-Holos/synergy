import { Show, createMemo, createSignal } from "solid-js"
import { useLingui } from "@lingui/solid"
import type { MessageDescriptor } from "@lingui/core"
import type { Agent, Session, SessionStatus } from "@ericsanchezok/synergy-sdk/client"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { RadioGroup } from "@ericsanchezok/synergy-ui/radio-group"
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
  draft?: string
  onDraftChange?: (value: string) => void
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
  const [localDraft, setLocalDraft] = createSignal("")
  const draft = () => props.draft ?? localDraft()
  const setDraft = (value: string) => {
    if (props.onDraftChange) props.onDraftChange(value)
    else setLocalDraft(value)
  }
  const [sending, setSending] = createSignal(false)
  const [agent, setAgent] = createSignal<string | undefined>(props.session?.agentOverride)
  const [switchingProfile, setSwitchingProfile] = createSignal(false)
  const [agentOpen, setAgentOpen] = createSignal(false)
  const [profileOpen, setProfileOpen] = createSignal(false)
  const [workflowOpen, setWorkflowOpen] = createSignal(false)
  const [actionError, setActionError] = createSignal<string>()

  const profile = createMemo<ControlProfileId>(() => props.session?.controlProfile ?? "guarded")
  const workflow = createMemo<BoardWorkflowKind>(() => workflowKindOf(props.session))
  const profileVisual = createMemo(() => permissionModeVisual(profile()))
  const visibleAgents = createMemo(() => props.agents.filter((a) => !a.hidden && a.mode !== "subagent"))
  const currentAgent = createMemo(() => agent() ?? visibleAgents()[0]?.name ?? _(kanbanPage.composerDefaultAgent))

  const run = async (action: () => Promise<void>) => {
    try {
      setActionError(undefined)
      await action()
    } catch (error) {
      setActionError(error instanceof Error ? error.message : _(kanbanPage.sendFailed))
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
    setActionError(undefined)
    try {
      await props.onSend(text, { agent: agent() })
      setDraft("")
    } catch (error) {
      setActionError(error instanceof Error ? error.message : _(kanbanPage.sendFailed))
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
            open={agentOpen()}
            onOpenChange={setAgentOpen}
            variant="menu"
            title={_(kanbanPage.composerAgent)}
            triggerAs={(triggerProps) => (
              <button
                {...triggerProps}
                type="button"
                class="kanban-composer-chip"
                aria-label={_(kanbanPage.composerAgent)}
              >
                <Icon name={getSemanticIcon("agents.main")} size="small" />
                <span class="kanban-composer-chip-label">{currentAgent()}</span>
              </button>
            )}
          >
            <RadioGroup
              class="app-panel-selection kanban-composer-choice"
              orientation="vertical"
              aria-label={_(kanbanPage.composerAgent)}
              options={visibleAgents()}
              current={visibleAgents().find((item) => item.name === currentAgent())}
              value={(item) => item.name}
              label={(item) => item.name}
              onSelect={(item) => {
                if (item) setAgent(item.name)
                setAgentOpen(false)
              }}
            />
          </Popover>
        </Show>
        <Popover
          open={profileOpen()}
          onOpenChange={setProfileOpen}
          variant="menu"
          title={_(kanbanPage.composerPermission)}
          triggerAs={(triggerProps) => (
            <button
              {...triggerProps}
              type="button"
              class="kanban-composer-chip"
              aria-label={_(kanbanPage.composerPermission)}
            >
              <Icon name={getSemanticIcon(profileVisual().icon)} size="small" />
              <span class="kanban-composer-chip-label">{translateModeCopy(profileVisual().shortLabel)}</span>
            </button>
          )}
        >
          <RadioGroup
            class="app-panel-selection kanban-composer-choice"
            orientation="vertical"
            aria-label={_(kanbanPage.composerPermission)}
            disabled={switchingProfile()}
            options={PERMISSION_MODES}
            current={PERMISSION_MODES.find((item) => item.id === profile())}
            value={(item) => item.id}
            label={(item) => translateModeCopy(item.label)}
            onSelect={(item) => {
              if (!item || switchingProfile()) return
              setSwitchingProfile(true)
              void run(() => props.onUpdateProfile(item.id)).finally(() => {
                setSwitchingProfile(false)
                setProfileOpen(false)
              })
            }}
          />
        </Popover>
        <Popover
          open={workflowOpen()}
          onOpenChange={setWorkflowOpen}
          variant="menu"
          title={_(kanbanPage.composerWorkflow)}
          triggerAs={(triggerProps) => (
            <button
              {...triggerProps}
              type="button"
              class="kanban-composer-chip"
              aria-label={_(kanbanPage.composerWorkflow)}
            >
              <Icon name={getSemanticIcon("cortex.main")} size="small" />
              <span class="kanban-composer-chip-label">{workflowLabel(workflow(), _)}</span>
            </button>
          )}
        >
          <RadioGroup
            class="app-panel-selection kanban-composer-choice"
            orientation="vertical"
            aria-label={_(kanbanPage.composerWorkflow)}
            options={["none", "plan", "lattice", "boss"] as BoardWorkflowKind[]}
            current={workflow()}
            label={(kind) => workflowLabel(kind, _)}
            onSelect={(kind) => {
              if (!kind) return
              void run(() => props.onSetWorkflow(kind)).finally(() => setWorkflowOpen(false))
            }}
          />
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
          aria-label={_({ id: "app.kanban.messageLabel", message: "Message this session" })}
          disabled={sending()}
          onInput={(event) => setDraft(event.currentTarget.value)}
        />
        <button
          class="kanban-pane-send"
          type="submit"
          aria-label={_({ id: "app.kanban.sendLabel", message: "Send message" })}
          disabled={sending() || !draft().trim()}
        >
          <Icon name={getSemanticIcon("prompt.send")} size="small" />
        </button>
      </form>
      <Show when={actionError()}>
        <p class="kanban-composer-error app-panel-caption" role="alert">
          {actionError()}
        </p>
      </Show>
    </div>
  )
}
