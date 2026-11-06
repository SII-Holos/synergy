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
  const __ = (d: { id: string; message?: string }) => lingui._(d as { id: string; message?: string })
  return (
    <Show when={props.notice}>
      {(notice) => {
        const titleStr = () => __(notice()?.title)
        const detailStr = () => (notice()?.detail ? __(notice()!.detail) : "")
        return (
          <div
            classList={{
              "sb-attention-notice": true,
              "sb-attention-notice--collapsed": !props.isExpanded,
            }}
            data-tone={notice()?.tone}
            aria-live="polite"
          >
            <Tooltip value={`${titleStr()}${detailStr() ? ` — ${detailStr()}` : ""}`} placement="right">
              <button
                type="button"
                class="sb-attention-button"
                aria-label={`${titleStr()}${detailStr() ? `. ${detailStr()}` : ""}`}
                disabled={notice()?.busy}
                onClick={() => {
                  const current = notice()
                  if (current) props.onAction(current)
                }}
              >
                <span class="sb-attention-icon">
                  <Icon name={getSemanticIcon(notice()?.iconToken ?? "product.update")} size="small" />
                </span>
                <Show when={props.isExpanded}>
                  <span class="sb-attention-copy">
                    <span class="sb-attention-title">{titleStr()}</span>
                    <span class="sb-attention-detail">{detailStr()}</span>
                  </span>
                  <Show when={notice()?.actionLabel}>
                    <span class="sb-attention-action">
                      {notice()?.busy ? __(sidebar.busy) : __(notice()!.actionLabel!)}
                    </span>
                  </Show>
                </Show>
              </button>
            </Tooltip>
            <Show when={notice()?.progress != null}>
              <div class="sb-attention-progress" aria-hidden="true">
                <span style={{ "--sb-attention-progress": `${notice()?.progress ?? 0}%` }} />
              </div>
            </Show>
          </div>
        )
      }}
    </Show>
  )
}
