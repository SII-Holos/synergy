import type { Accessor } from "solid-js"
import { Show } from "solid-js"
import { useNavigate } from "@solidjs/router"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { Tooltip } from "@ericsanchezok/synergy-ui/tooltip"
import { PromptInput } from "@/components/prompt-input"
import { StatusBar } from "@/components/status-bar"
import { NewSessionGreeting } from "./session-new-view"
import { QuestionPrompt } from "./question-prompt"
import { PermissionDock } from "./permission-dock"
import { SubagentDock } from "./subagent-dock"
import type { usePrompt } from "@/context/prompt"
import type { useSync } from "@/context/sync"
import type { useSDK } from "@/context/sdk"

export function PromptDock(props: {
  ref: (el: HTMLDivElement) => void
  inputRef: (el: HTMLDivElement) => void
  isNewSession: Accessor<boolean>
  showTabs: Accessor<boolean>
  isGlobal: boolean
  sessionID: string | undefined
  prompt: ReturnType<typeof usePrompt>
  sync: ReturnType<typeof useSync>
  sdk: ReturnType<typeof useSDK>
  navigate: (path: string) => void
  handoffPrompt: string
  parentSession: Accessor<{ id: string; title?: string } | undefined>
  backPath?: Accessor<string | undefined>
  newSessionWorktree: Accessor<string>
  onNewSessionWorktreeReset: () => void
  scopeName: Accessor<string>
  branch: Accessor<string | undefined>
  lastModified: Accessor<string | null | undefined>
}) {
  const nav = useNavigate()
  return (
    <div
      ref={props.ref}
      classList={{
        "absolute inset-x-0 bottom-0 flex flex-col justify-center items-center z-50 px-0 pointer-events-none": true,
        "pt-12 pb-0 md:pb-1.5 bg-gradient-to-t from-background-stronger via-background-stronger to-transparent":
          !props.isNewSession(),
        "pb-0 md:pb-1.5": props.isNewSession(),
      }}
      style={{
        transform: props.isNewSession() ? "translateY(-35vh)" : "translateY(0)",
        transition: "transform 400ms ease-out",
      }}
    >
      <div
        classList={{
          "w-full md:px-6 pointer-events-auto": true,
          "md:max-w-200": !props.showTabs(),
        }}
      >
        <Show when={props.isNewSession()}>
          <NewSessionGreeting />
        </Show>
        <Show
          when={props.prompt.ready()}
          fallback={
            <div class="w-full min-h-32 md:min-h-40 rounded-md border border-border-weak-base bg-background-base/50 px-4 py-3 text-text-weak whitespace-pre-wrap pointer-events-none">
              {props.handoffPrompt || "Loading prompt..."}
            </div>
          }
        >
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
          <Show when={props.sessionID}>
            <SubagentDock sessionID={props.sessionID!} />
          </Show>
          <Show when={props.parentSession()}>
            {(parent) => (
              <div class="flex items-center justify-center pb-2">
                <Tooltip value={parent().title || "Parent session"} placement="top">
                  <button
                    type="button"
                    class="flex items-center justify-center gap-1.5 h-8 px-3 rounded-full
                      border border-border-base bg-surface-raised-stronger-non-alpha
                      shadow-sm
                      text-12-medium text-text-weak hover:text-text-base
                      hover:bg-surface-raised-stronger-hover
                      active:scale-95
                      transition-all duration-150"
                    onClick={() => props.navigate(parent().id)}
                  >
                    <Icon name="arrow-left" size="small" />
                    <span>Back to parent</span>
                  </button>
                </Tooltip>
              </div>
            )}
          </Show>
          <Show when={!props.parentSession() && props.backPath?.()}>
            {(from) => (
              <div class="flex items-center justify-center pb-2">
                <button
                  type="button"
                  class="flex items-center justify-center gap-1.5 h-8 px-3 rounded-full
                    border border-border-base bg-surface-raised-stronger-non-alpha
                    shadow-sm
                    text-12-medium text-text-weak hover:text-text-base
                    hover:bg-surface-raised-stronger-hover
                    active:scale-95
                    transition-all duration-150"
                  onClick={() => nav(from())}
                >
                  <Icon name="arrow-left" size="small" />
                  <span>Back</span>
                </button>
              </div>
            )}
          </Show>
          <div class="relative">
            <Show when={props.isGlobal}>
              <div
                class="absolute -inset-6 rounded-[48px] pointer-events-none"
                style={{
                  background: "radial-gradient(ellipse at center, var(--surface-brand-base) 0%, transparent 70%)",
                  opacity: 0.35,
                  filter: "blur(32px)",
                }}
              />
            </Show>
            <PromptInput
              ref={props.inputRef}
              newSessionWorktree={props.newSessionWorktree()}
              onNewSessionWorktreeReset={props.onNewSessionWorktreeReset}
            />
          </div>
        </Show>
        <Show when={props.isNewSession() && !props.isGlobal}>
          <div class="flex items-center justify-center gap-1.5 pt-3 text-12-regular text-text-subtle pointer-events-none">
            <Icon name="folder" size="small" class="text-icon-base" />
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
        <div class="hidden md:block pointer-events-auto">
          <StatusBar />
        </div>
      </div>
    </div>
  )
}
