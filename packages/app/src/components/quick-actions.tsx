import { createEffect, createSignal, For, Show } from "solid-js"
import { Icon, type IconName } from "@ericsanchezok/synergy-ui/icon"
import { Tooltip } from "@ericsanchezok/synergy-ui/tooltip"
import "./quick-actions.css"

interface CommandAction {
  icon: IconName
  label: string
  commandId: string
}

interface PromptAction {
  icon: IconName
  label: string
  description: string
  prompt: string
}

const COMMANDS: CommandAction[] = [
  { icon: "undo-2", label: "Undo", commandId: "session.undo" },
  { icon: "redo-2", label: "Redo", commandId: "session.redo" },
  { icon: "minimize", label: "Compact", commandId: "session.compact" },
]

const PROMPTS: PromptAction[] = [
  {
    icon: "scroll-text",
    label: "Note",
    description: "Save last response as a note",
    prompt:
      "Save your most recent substantive response as a note. Capture the key points, structure, and useful detail — keep it informative and well-organized, but don't feel obligated to preserve every word verbatim. Let the content guide the title.",
  },
  {
    icon: "scan-eye",
    label: "Review",
    description: "Review recent changes for issues",
    prompt:
      "Review the changes you just made. Check for correctness, edge cases, potential regressions, and consistency with the existing codebase. Flag anything that looks off.",
  },
  {
    icon: "rocket",
    label: "Continue",
    description: "Continue where you left off",
    prompt: "Continue where you left off.",
  },
  {
    icon: "git-merge",
    label: "Commit",
    description: "Create a git commit",
    prompt:
      "Create a git commit with a clear, conventional commit message that accurately describes what was done and why. Only stage and commit files that you personally modified or created during this session — do not stage, modify, delete, or touch any files or changes made by others. Never delete or overwrite code that has been modified by others. Always stage files explicitly by path (never use git add . or git add -A). If you are unsure whether a change is yours, skip it and ask the user first. Better to under-commit than over-commit.",
  },
  {
    icon: "microscope",
    label: "Audit",
    description: "Audit recent changes and ensure quality",
    prompt:
      "Audit all recent changes thoroughly. Create a DAG to track each review phase. Run through this pipeline, fixing issues after each phase before continuing to the next: (1) Readability — are names self-describing? Does each unit have a single, clear responsibility? Are concerns grouped cohesively, not scattered? (2) Structural hygiene — is there dead code, leftover transitional code, unused imports, stale layers, or speculative abstraction? Remove what does not earn its place. (3) Design integrity — does any logic wrap itself in unnecessary functions, wrappers, or indirection that add callsite depth without adding clarity or reuse? Does any module have responsibilities that belong elsewhere? (4) Error and edge-case handling — are error paths covered? Are null, empty, boundary, and failure states handled explicitly? (5) Consistency — do naming, error handling, module layout, and import style match surrounding conventions? Run quality gates (format, lint, typecheck, tests) after every fix phase. At the end, confirm all gates are green.",
  },
  {
    icon: "zap",
    label: "Start",
    description: "Start implementing the current plan",
    prompt:
      "Begin implementation. Create a DAG to plan and track the work, including these phases: map the relevant code → design the approach → test (write failing tests first) → implement → verify (run quality gates) → review (security, performance, API compatibility where applicable). Apply professional engineering standards: behavior is tested before implementation, names communicate domain meaning, structure is locally consistent and free of dead code, quality checks pass mechanically. If any phase uncovers a deeper issue that requires refactoring rather than layering a fix, address it. Verify at the end that all quality gates are green.",
  },
]

interface QuickActionsProps {
  onSend: (prompt: string) => void
  onCommand: (commandId: string) => void
  disabled?: boolean
  class?: string
}

export function QuickActions(props: QuickActionsProps) {
  const [open, setOpen] = createSignal(false)

  createEffect(() => {
    if (props.disabled && open()) setOpen(false)
  })

  return (
    <div class={props.class ?? "absolute -top-3 right-5 z-20"}>
      <Show when={open()}>
        <div class="qa-cloud absolute bottom-full right-0 mb-1.5">
          <div class="flex flex-wrap items-center justify-end gap-1.5 max-w-80">
            <For each={COMMANDS}>
              {(action, i) => (
                <Tooltip placement="left" value={action.label}>
                  <button
                    type="button"
                    disabled={props.disabled}
                    class="qa-bubble qa-bubble-icon"
                    style={{ "animation-delay": `${i() * 30}ms` }}
                    onClick={() => props.onCommand(action.commandId)}
                  >
                    <Icon name={action.icon} size="small" />
                  </button>
                </Tooltip>
              )}
            </For>
            <For each={PROMPTS}>
              {(action, i) => (
                <Tooltip placement="left" value={action.description}>
                  <button
                    type="button"
                    disabled={props.disabled}
                    class="qa-bubble qa-bubble-pill"
                    style={{ "animation-delay": `${(COMMANDS.length + i()) * 30}ms` }}
                    onClick={() => props.onSend(action.prompt)}
                  >
                    <Icon name={action.icon} size="small" />
                    {action.label}
                  </button>
                </Tooltip>
              )}
            </For>
          </div>
        </div>
      </Show>
      <Tooltip placement="top" value={open() ? "Close quick actions" : "Quick actions"}>
        <button
          type="button"
          disabled={props.disabled}
          class="qa-trigger flex items-center justify-center size-6 rounded-full bg-surface-raised-stronger-non-alpha border border-border-base text-icon-weak hover:text-icon-base hover:bg-surface-raised-base-hover active:scale-90 transition-all shadow-xs"
          onClick={() => setOpen(!open())}
        >
          <Icon name={open() ? "chevron-down" : "chevron-up"} size="small" />
        </button>
      </Tooltip>
    </div>
  )
}
