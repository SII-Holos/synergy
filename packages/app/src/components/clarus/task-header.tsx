import { Show, createMemo, type Component } from "solid-js"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { deriveClarusTaskComposerState } from "@/composables/use-clarus-task-meta"
import type { ClarusTaskBindingSnapshot, ClarusTaskEndpointSnapshot } from "@/composables/use-clarus-task-meta"
import type { SessionEndpoint } from "@ericsanchezok/synergy-sdk"

const CLARUS_HEADER_CLASS =
  "flex items-center gap-2 px-4 py-2 mx-3 md:mx-6 mt-1 rounded-md bg-surface-raised-base border border-border-weak-base text-12-regular"

function clarusStatusDotClass(status: string) {
  const base = "size-1.5 rounded-full shrink-0"
  switch (status) {
    case "waiting":
    case "connected":
      return `${base} bg-icon-warning-base`
    case "running":
      return `${base} bg-icon-success-base animate-pulse`
    case "needs_attention":
      return `${base} bg-icon-critical-base`
    case "submitted":
    case "acknowledged":
      return `${base} bg-icon-info-base`
    case "submitting":
    case "dispatched":
      return `${base} bg-icon-info-base animate-pulse`
    case "expired":
    case "cancelled":
    case "failed":
    case "ambiguous":
    case "rejected":
      return `${base} bg-border-strong-base`
    default:
      return `${base} bg-border-strong-base`
  }
}

export const ClarusTaskHeader: Component<{
  endpoint: SessionEndpoint | undefined
  binding: ClarusTaskBindingSnapshot | undefined
}> = (props) => {
  const state = createMemo(() => deriveClarusTaskComposerState(props.endpoint, props.binding))

  const s = createMemo(() => state())

  const showHeader = createMemo(() => s().isClarusTask && s().binding != null)

  const binding = createMemo(() => (showHeader() ? s().binding! : undefined))
  const ep = createMemo(() => (showHeader() ? s().endpoint : undefined))

  return (
    <Show when={showHeader()}>
      <div class={CLARUS_HEADER_CLASS}>
        <Icon name={getSemanticIcon("clarus.task")} size="small" class="text-icon-weak-base shrink-0" />

        <div class="min-w-0 flex items-center gap-2 flex-wrap">
          <span class="text-text-base font-medium truncate">{binding()!.title}</span>

          <Show when={binding()!.phase}>
            <span class="text-text-subtle shrink-0">{binding()!.phase}</span>
          </Show>
        </div>

        <Show when={ep()}>
          <span class="text-text-subtle shrink-0 ml-auto flex items-center gap-1.5">
            <span class={clarusStatusDotClass(binding()!.status)} />
            <span>{s().headerStatusLabel}</span>
          </span>
        </Show>

        <Show when={s().headerResultLabel}>
          <span class="text-text-subtle shrink-0">{s().headerResultLabel}</span>
        </Show>
      </div>
    </Show>
  )
}
