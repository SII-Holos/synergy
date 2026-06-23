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
    icon: "notebook-pen",
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
      "Audit your recent changes — list issues only, do NOT fix them yet. Evaluate along these axes: (1) Readability — are names self-describing? Does each unit have a single clear responsibility, or does it scatter related concerns? (2) Structural hygiene — dead code, leftover transitional code, unused imports, stale layers, speculative abstraction? Flag anything that doesn't earn its place. (3) Design integrity — unnecessary wrappers, indirection, functions that add callsite depth without clarity or reuse? Every layer must justify itself. (4) Error handling — are error paths covered? Are null, empty, boundary, and failure states handled explicitly? (5) Consistency — do naming, error handling, module layout, and imports match surrounding conventions? Be specific — cite file names, line ranges, and concrete examples. I'll review your findings before deciding what to fix.",
  },
  {
    icon: "zap",
    label: "Start",
    description: "Start implementing the current plan",
    prompt:
      "Your proposal looks good — go ahead and implement it. Prioritize clean, professional code: no redundant logic, no dead code, no leftover patches. Behavior should be tested, names should communicate domain meaning, structure should be locally consistent. If the right solution requires refactoring at a deeper level rather than layering fixes on top, do that. Quality checks must pass at the end. Treat the codebase with care — every line should earn its place.",
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
