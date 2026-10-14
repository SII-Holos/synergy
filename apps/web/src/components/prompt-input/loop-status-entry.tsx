import { Show, type Accessor } from "solid-js"
import { Dialog } from "@ericsanchezok/synergy-ui/dialog"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { useLocale } from "@/context/locale"
import type { LoopDisplay } from "./loop-status"

import { loopCopy } from "./loop-status-copy"

const name = (value: LoopDisplay) => (value.kind === "blueprint" ? "BlueprintLoop" : "Light Loop")

export function LoopStatusEntry(props: { value: LoopDisplay; onOpen: () => void }) {
  const { i18n } = useLocale()
  return (
    <div data-component="loop-status-entry" data-stage={props.value.stage} class="px-3 pt-2">
      <button
        type="button"
        onClick={() => props.onOpen()}
        aria-label={`${name(props.value)} · ${i18n._(loopCopy[props.value.stage])}`}
        class="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left text-text-base hover:bg-surface-raised-base-hover focus-visible:outline-2 focus-visible:outline-border-active"
      >
        <Icon
          name={getSemanticIcon(props.value.kind === "blueprint" ? "blueprint.main" : "prompt.lightLoop")}
          size="small"
          class="shrink-0"
        />
        <span class="min-w-0 flex-1">
          <span class="flex flex-wrap items-center gap-x-2 text-12-medium">
            <span>{name(props.value)}</span>
            <span class="text-text-weak" role="status">
              {i18n._(loopCopy[props.value.stage])}
            </span>
          </span>
          <span class="block truncate text-12-regular text-text-weak">
            {props.value.title || i18n._(props.value.pending ? loopCopy.pending : loopCopy.details)}
          </span>
        </span>
        <Icon name={getSemanticIcon("navigation.expand")} size="small" class="shrink-0 text-icon-weak-base" />
      </button>
    </div>
  )
}

export function LoopStatusDialog(props: {
  value: Accessor<LoopDisplay | undefined>
  onEdit?: () => void
  onNote?: () => void
  onReviewer?: () => void
  onRemove?: () => void
  onRetry?: () => void
}) {
  const { i18n } = useLocale()
  return (
    <Dialog title={i18n._(loopCopy.details)} size="form" onEscapeKeyDown={(event) => event.stopPropagation()}>
      <Show when={props.value()}>
        {(value) => (
          <div data-slot="dialog-form" data-component="loop-status-details">
            <div class="flex flex-wrap gap-2 text-14-medium">
              <span>{name(value())}</span>
              <span role="status">{i18n._(loopCopy[value().stage])}</span>
            </div>
            <div class="text-13-regular whitespace-pre-wrap break-words">
              {value().title || i18n._(value().pending ? loopCopy.pending : loopCopy.details)}
            </div>
            <Show when={value().reason}>
              {(reason) => (
                <section>
                  <h3 class="text-12-medium text-text-weak">{i18n._(loopCopy.reason)}</h3>
                  <p class="text-13-regular whitespace-pre-wrap break-words">{reason()}</p>
                </section>
              )}
            </Show>
            <Show when={value().detail}>
              {(detail) => (
                <section>
                  <h3 class="text-12-medium text-text-weak">{i18n._(loopCopy.result)}</h3>
                  <p class="text-13-regular whitespace-pre-wrap break-words">{detail()}</p>
                </section>
              )}
            </Show>
            <Show when={!value().terminal && !value().pending}>
              <p class="text-12-regular text-text-weak">{i18n._(loopCopy.controls)}</p>
            </Show>
            <div data-slot="dialog-actions" class="flex-wrap">
              <Show when={value().stage === "unavailable"}>
                <Button variant="secondary" onClick={() => props.onRetry?.()}>
                  {i18n._(loopCopy.retry)}
                </Button>
              </Show>
              <Show when={props.onNote && value().noteID}>
                <Button variant="secondary" onClick={() => props.onNote?.()}>
                  {i18n._(loopCopy.openNote)}
                </Button>
              </Show>
              <Show when={props.onReviewer && value().reviewerSessionID}>
                <Button variant="secondary" onClick={() => props.onReviewer?.()}>
                  {i18n._(loopCopy.reviewer)}
                </Button>
              </Show>
              <Show when={props.onEdit && value().kind === "lightloop" && !value().terminal && !value().pending}>
                <Button variant="secondary" onClick={() => props.onEdit?.()}>
                  {i18n._(loopCopy.edit)}
                </Button>
              </Show>
              <Show when={props.onRemove && value().pending}>
                <Button variant="secondary" onClick={() => props.onRemove?.()}>
                  {i18n._(loopCopy.remove)}
                </Button>
              </Show>
            </div>
          </div>
        )}
      </Show>
    </Dialog>
  )
}
