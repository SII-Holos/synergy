import { Show } from "solid-js"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { Tooltip } from "@ericsanchezok/synergy-ui/tooltip"
import { useLingui } from "@lingui/solid"
import { sidebar } from "@/locales/messages"
import type { AppAttentionNotice } from "./app-attention"

export function SidebarAttentionNotice(props: {
  notice?: AppAttentionNotice
  isExpanded: boolean
  onAction: (notice: AppAttentionNotice) => void
}) {
  const lingui = useLingui()
  const __ = (d: { id: string; message?: string }) => lingui._(d as { id: string; message: string })
  return (
    <Show when={props.notice}>
      {(notice) => {
        const n = notice()
        const titleStr = () => __(n.title)
        const detailStr = () => (n.detail ? __(n.detail) : "")
        return (
          <div
            classList={{
              "sb-attention-notice": true,
              "sb-attention-notice--collapsed": !props.isExpanded,
            }}
            data-tone={n.tone}
            aria-live="polite"
          >
            <Tooltip value={`${titleStr()}${detailStr() ? ` — ${detailStr()}` : ""}`} placement="right">
              <button
                type="button"
                class="sb-attention-button"
                aria-label={`${titleStr()}${detailStr() ? `. ${detailStr()}` : ""}`}
                disabled={n.busy}
                onClick={() => props.onAction(n)}
              >
                <span class="sb-attention-icon">
                  <Icon name={getSemanticIcon(n.iconToken)} size="small" />
                </span>
                <Show when={props.isExpanded}>
                  <span class="sb-attention-copy">
                    <span class="sb-attention-title">{titleStr()}</span>
                    <span class="sb-attention-detail">{detailStr()}</span>
                  </span>
                  <Show when={n.actionLabel}>
                    <span class="sb-attention-action">{n.busy ? __(sidebar.busy) : __(n.actionLabel!)}</span>
                  </Show>
                </Show>
              </button>
            </Tooltip>
            <Show when={n.progress != null}>
              <div class="sb-attention-progress" aria-hidden="true">
                <span style={{ "--sb-attention-progress": `${n.progress ?? 0}%` }} />
              </div>
            </Show>
          </div>
        )
      }}
    </Show>
  )
}
