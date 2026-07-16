import { Show, createMemo, createSignal, untrack, type JSX } from "solid-js"
import type { Accessor } from "solid-js"
import { useNavigate } from "@solidjs/router"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { Tooltip } from "@ericsanchezok/synergy-ui/tooltip"
import { PromptInput } from "@/components/prompt-input"
import { StatusBar } from "@/components/status-bar"
import { NewSessionGreeting } from "./session-new-view"
import { QuestionPrompt } from "./question-prompt"
import { PermissionDock } from "./permission-dock"
import { SessionInbox } from "./session-inbox"
import { SubagentSessionFooter } from "./subagent-session-footer"
import { type SessionMeta } from "@/composables/use-session-meta"
import type { usePrompt } from "@/context/prompt"
import type { useSync } from "@/context/sync"
import type { useSDK } from "@/context/sdk"
import type {
  NewSessionWorkspaceSelection,
  SessionWorkspaceProgress,
  SessionWorkspaceProgressActions,
} from "./worktree-session"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { promptDockBackPath, promptDockBackToParentID, promptDockForkSourceID } from "./prompt-dock-model"
import { PromptDockFloatLayer } from "./prompt-dock-float-layer"
import { S } from "./session-i18n"
import { useLocale } from "@/context/locale"

export function PromptDock(props: {
  ref: (el: HTMLDivElement) => void
  inputRef: (el: HTMLDivElement) => void
  isNewSession: Accessor<boolean>
  showTabs: Accessor<boolean>
  workspaceOpen?: Accessor<boolean>
  isGlobal: boolean
  sessionID: string | undefined
  prompt: ReturnType<typeof usePrompt>
  sync: ReturnType<typeof useSync>
  sdk: ReturnType<typeof useSDK>
  navigate: (path: string) => void
  handoffPrompt: string
  meta: Accessor<SessionMeta>
  parentTitle?: string
  forkedFromID?: string
  forkedFromTitle?: string
  backPath?: Accessor<string | undefined>
  newSessionWorkspaceSelection: Accessor<NewSessionWorkspaceSelection>
  newSessionCanonicalDirectory: Accessor<string | undefined>
  newSessionCurrentDirectory: Accessor<string | undefined>
  onNewSessionWorkspaceSelectionChange: (selection: NewSessionWorkspaceSelection) => void
  onNewSessionWorkspaceSelectionReset: () => void
  onNewSessionStartProgress: (input: {
    sessionID: string
    progress: SessionWorkspaceProgress | null
    actions?: SessionWorkspaceProgressActions
  }) => void
  workspaceTransitionPending: Accessor<boolean>
  scopeName: Accessor<string>
  branch: Accessor<string | undefined>
  lastModified: Accessor<string | null | undefined>
  rollbackActive?: boolean
}) {
  const { i18n } = useLocale()
  const _ = (d: { id: string; message: string }) => i18n._(d)
  const nav = useNavigate()
  const meta = createMemo(() => props.meta())
  const backToParentID = createMemo(() => promptDockBackToParentID(meta()))
  const forkSourceID = createMemo(() => promptDockForkSourceID(meta(), props.forkedFromID))
  const returnPath = createMemo(() => promptDockBackPath(meta(), props.backPath?.()))
  const cortex = createMemo(() => meta().cortex)
  const [priorityControl, setPriorityControl] = createSignal<JSX.Element | undefined>(undefined)
  const subagentFooter = createMemo(() => {
    const delegation = cortex()
    if (!delegation || !props.sessionID) return undefined
    return { delegation, sessionID: props.sessionID, parentSessionID: meta().parentID ?? undefined }
  })

  return (
    <div
      ref={props.ref}
      classList={{
        "relative md:absolute md:inset-x-0 md:bottom-0 flex flex-col justify-center items-center z-50 px-0 pointer-events-none safe-bottom pb-0 md:pb-3": true,
        "pt-12": !props.isNewSession(),
      }}
      style={{
        transform: props.isNewSession() ? "translateY(-35vh)" : "translateY(0)",
        transition: "transform 400ms ease-out",
      }}
    >
      <div
        classList={{
          "w-full min-w-0 px-3 md:px-6 pointer-events-auto relative": true,
          "md:max-w-[54rem]": !props.showTabs(),
        }}
      >
        <Show when={props.sessionID}>
          <PromptDockFloatLayer sessionID={props.sessionID!} priorityControl={priorityControl()} />
        </Show>
        <Show when={props.isNewSession()}>
          <NewSessionGreeting />
        </Show>
        <Show
          when={props.prompt.ready()}
          fallback={
            <div class="w-full min-h-32 md:min-h-40 rounded-md border border-border-weak-base bg-background-base/50 px-4 py-3 text-text-weak whitespace-pre-wrap pointer-events-none">
              {props.handoffPrompt || _(S.dockLoadingPrompt)}
            </div>
          }
        >
          <Show
            when={meta().isReadOnly}
            fallback={
              <>
                <Show when={props.sessionID}>
                  <PermissionDock sessionID={props.sessionID!} />
                </Show>
                <Show when={props.sessionID ? props.sync.data.question[props.sessionID]?.[0] : undefined}>
                  {(request) => (
                    <div class="mb-3">
                      <QuestionPrompt request={request()} />
                    </div>
                  )}
                </Show>
                <Show when={backToParentID()}>
                  {(parentID) => (
                    <div class="flex items-center justify-center pb-2">
                      <Tooltip value={props.parentTitle || _(S.dockParentSession)} placement="top">
                        <button
                          type="button"
                          class="workbench-control-surface workbench-control-surface-hover flex items-center justify-center gap-1.5 h-8 px-3 rounded-full
                          border border-border-base
                          text-12-medium text-text-weak hover:text-text-base
                          active:scale-95
                          transition-all duration-150"
                          onClick={() => props.navigate(untrack(parentID))}
                        >
                          <Icon name={getSemanticIcon("navigation.back")} size="small" />
                          <span>{_(S.dockBackToParent)}</span>
                        </button>
                      </Tooltip>
                    </div>
                  )}
                </Show>
                <Show when={forkSourceID()}>
                  {(sourceID) => (
                    <div class="flex items-center justify-center pb-2">
                      <Tooltip value={props.forkedFromTitle || _(S.dockForkSourceTooltip)} placement="top">
                        <button
                          type="button"
                          class="workbench-control-surface workbench-control-surface-hover flex items-center justify-center gap-1.5 h-8 px-3 rounded-full
                          border border-border-base
                          text-12-medium text-text-weak hover:text-text-base
                          active:scale-95
                          transition-all duration-150"
                          onClick={() => props.navigate(untrack(sourceID))}
                        >
                          <Icon name={getSemanticIcon("workspace.worktree")} size="small" />
                          <span>{_(S.dockForkedFrom)}</span>
                        </button>
                      </Tooltip>
                    </div>
                  )}
                </Show>
                <Show when={returnPath()}>
                  {(from) => (
                    <div class="flex items-center justify-center pb-2">
                      <button
                        type="button"
                        class="workbench-control-surface workbench-control-surface-hover flex items-center justify-center gap-1.5 h-8 px-3 rounded-full
                        border border-border-base
                        text-12-medium text-text-weak hover:text-text-base
                        active:scale-95
                        transition-all duration-150"
                        onClick={() => nav(untrack(from))}
                      >
                        <Icon name={getSemanticIcon("navigation.back")} size="small" />
                        <span>{_(S.dockBack)}</span>
                      </button>
                    </div>
                  )}
                </Show>
                <div class="relative">
                  <PromptInput
                    ref={props.inputRef}
                    newSessionWorkspaceSelection={props.newSessionWorkspaceSelection()}
                    newSessionCanonicalDirectory={props.newSessionCanonicalDirectory()}
                    newSessionCurrentDirectory={props.newSessionCurrentDirectory()}
                    newSessionCanCreateWorktree={!props.isGlobal}
                    onNewSessionWorkspaceSelectionChange={props.onNewSessionWorkspaceSelectionChange}
                    onNewSessionWorkspaceSelectionReset={props.onNewSessionWorkspaceSelectionReset}
                    onNewSessionStartProgress={props.onNewSessionStartProgress}
                    workspaceTransitionPending={props.workspaceTransitionPending()}
                    hideAgentSelector={!meta().showInputBar}
                    onPriorityControlChange={(control) => setPriorityControl(() => control)}
                  />
                  <Show when={props.sessionID}>
                    <SessionInbox
                      sessionID={props.sessionID!}
                      sync={props.sync}
                      sdk={props.sdk}
                      freezeHint={props.rollbackActive}
                    />
                  </Show>
                </div>
              </>
            }
          >
            <Show when={props.sessionID}>
              <PermissionDock sessionID={props.sessionID!} />
            </Show>
            <Show when={subagentFooter()}>
              {(footer) => (
                <SubagentSessionFooter
                  cortex={footer().delegation}
                  sessionID={footer().sessionID}
                  parentSessionID={footer().parentSessionID}
                />
              )}
            </Show>
          </Show>
        </Show>
        <Show when={props.isNewSession() && !props.isGlobal}>
          <div class="flex items-center justify-center gap-1.5 pt-3 text-12-regular text-text-subtle pointer-events-none">
            <Icon name={getSemanticIcon("workspace.main")} size="small" class="text-icon-base" />
            <span class="text-text-base">{props.scopeName()}</span>
            <Show when={props.branch()}>
              <span>·</span>
              <span>{props.branch()}</span>
            </Show>
            <Show when={props.lastModified()}>
              <span>·</span>
              <span>{props.lastModified()}</span>
            </Show>
          </div>
        </Show>
        <Show when={!props.isNewSession()}>
          <div class="pointer-events-auto">
            <StatusBar />
          </div>
        </Show>
      </div>
    </div>
  )
}
