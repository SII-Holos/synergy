import { Show, type Accessor } from "solid-js"
import { Dialog } from "@ericsanchezok/synergy-ui/dialog"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { Tooltip } from "@ericsanchezok/synergy-ui/tooltip"
import "../session/pending-composer-queue.css"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { useLocale } from "@/context/locale"
import type { LoopDisplay } from "./loop-status"

import { loopCopy } from "./loop-status-copy"

const name = (value: LoopDisplay) => (value.kind === "blueprint" ? "BlueprintLoop" : "Light Loop")
const statusCopy = (value: LoopDisplay) =>
  value.kind === "lightloop" && value.stage === "completed" ? loopCopy.lightCompleted : loopCopy[value.stage]

export function LoopStatusEntry(props: {
  value: LoopDisplay
  pending?: boolean
  onOpen?: () => void
  onEdit?: () => void
  onNote?: () => void
  onRemove?: () => void
  onRetry?: () => void
}) {
  const { i18n } = useLocale()
  return (
    <section
      data-component="loop-status-entry"
      data-stage={props.value.stage}
      class="pending-composer-layer"
      aria-label={name(props.value)}
    >
      <div class="pending-composer-row pending-composer-loop">
        <Tooltip value={name(props.value)}>
          <span class="pending-composer-status" aria-label={name(props.value)}>
            <Icon
              name={getSemanticIcon(props.value.kind === "blueprint" ? "blueprint.main" : "prompt.lightLoop")}
              size="small"
            />
          </span>
        </Tooltip>
        <span role="status" title={i18n._(statusCopy(props.value))}>
          {i18n._(statusCopy(props.value))}
        </span>
        <span class="pending-composer-label" title={props.value.title}>
          {props.value.title || name(props.value)}
        </span>
        <div class="pending-composer-actions">
          <Show when={props.value.stage === "unavailable" && props.onRetry}>
            <Tooltip value={i18n._(loopCopy.retry)}>
              <Button
                variant="ghost"
                aria-label={i18n._(loopCopy.retry)}
                onClick={() => props.onRetry?.()}
                disabled={props.pending}
              >
                <Icon name={getSemanticIcon("session.retry")} size="small" />
              </Button>
            </Tooltip>
          </Show>
          <Show when={props.onOpen && (props.value.reason || props.value.detail || props.value.reviewerSessionID)}>
            <Tooltip value={i18n._(loopCopy.details)}>
              <Button
                data-action="loop-details"
                variant="ghost"
                aria-label={i18n._(loopCopy.details)}
                onClick={() => props.onOpen?.()}
              >
                <Icon name={getSemanticIcon("action.info")} size="small" />
              </Button>
            </Tooltip>
          </Show>
          <Show when={props.onNote && props.value.noteID}>
            <Tooltip value={i18n._(loopCopy.openNote)}>
              <Button variant="ghost" aria-label={i18n._(loopCopy.openNote)} onClick={() => props.onNote?.()}>
                <Icon name={getSemanticIcon("blueprint.main")} size="small" />
              </Button>
            </Tooltip>
          </Show>
          <Show when={props.onEdit && props.value.kind === "lightloop" && !props.value.terminal}>
            <Tooltip value={i18n._(loopCopy.edit)}>
              <Button
                variant="ghost"
                aria-label={i18n._(loopCopy.edit)}
                onClick={() => props.onEdit?.()}
                disabled={props.pending}
              >
                <Icon name={getSemanticIcon("action.edit")} size="small" />
              </Button>
            </Tooltip>
          </Show>
          <Show when={props.onRemove && !props.value.terminal}>
            <Tooltip value={i18n._(loopCopy.cancel)}>
              <Button
                variant="ghost"
                aria-label={i18n._(loopCopy.cancel)}
                onClick={() => props.onRemove?.()}
                disabled={props.pending}
              >
                <Icon name={getSemanticIcon("action.remove")} size="small" />
              </Button>
            </Tooltip>
          </Show>
        </div>
      </div>
    </section>
  )
}

export function LoopStatusDialog(props: { value: Accessor<LoopDisplay | undefined>; onReviewer?: () => void }) {
  const { i18n } = useLocale()
  return (
    <Dialog
      title={
        props.value() ? `${name(props.value()!)} · ${i18n._(statusCopy(props.value()!))}` : i18n._(loopCopy.details)
      }
      size="form"
      onEscapeKeyDown={(event) => event.stopPropagation()}
    >
      <Show when={props.value()}>
        {(value) => (
          <div data-slot="dialog-form" data-component="loop-status-details">
            <Show when={value().reason}>
              {(reason) => (
                <section>
                  <h3 class="text-12-medium text-text-weak">
                    {i18n._(
                      value().stage === "failed"
                        ? loopCopy.failure
                        : value().terminal
                          ? loopCopy.result
                          : loopCopy.reason,
                    )}
                  </h3>
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
            <div data-slot="dialog-actions" class="flex-wrap">
              <Show when={props.onReviewer && value().reviewerSessionID}>
                <Button variant="secondary" onClick={() => props.onReviewer?.()}>
                  {i18n._(loopCopy.reviewer)}
                </Button>
              </Show>
            </div>
          </div>
        )}
      </Show>
    </Dialog>
  )
}
