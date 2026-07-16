import { Show } from "solid-js"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { Tooltip } from "@ericsanchezok/synergy-ui/tooltip"
import { useLingui } from "@lingui/solid"
import type { AppAttentionNotice } from "./app-attention"

export function SidebarAttentionNotice(props: {
  notice?: AppAttentionNotice
  isExpanded: boolean
  onAction: (notice: AppAttentionNotice) => void
}) {
  const { _ } = useLingui()
  return (
    <Show when={props.notice}>
      {(notice) => {
        const titleStr = () => _(notice().title)
        const detailStr = () => (notice().detail ? _(notice().detail) : "")
        return (
          <div
            classList={{
              "sb-attention-notice": true,
              "sb-attention-notice--collapsed": !props.isExpanded,
            }}
            data-tone={notice().tone}
            aria-live="polite"
          >
            <Tooltip value={`${titleStr()}${detailStr() ? ` — ${detailStr()}` : ""}`} placement="right">
              <button
                type="button"
                class="sb-attention-button"
                aria-label={`${titleStr()}${detailStr() ? `. ${detailStr()}` : ""}`}
                disabled={notice().busy}
                onClick={() => props.onAction(notice())}
              >
                <span class="sb-attention-icon">
                  <Icon name={getSemanticIcon(notice().iconToken)} size="small" />
                </span>
                <Show when={props.isExpanded}>
                  <span class="sb-attention-copy">
                    <span class="sb-attention-title">{titleStr()}</span>
                    <span class="sb-attention-detail">{detailStr()}</span>
                  </span>
                  <Show when={notice().actionLabel}>
                    <span class="sb-attention-action">
                      {notice().busy ? _({ id: "attention.busy", message: "Working..." }) : _(notice().actionLabel!)}
                    </span>
                  </Show>
                </Show>
              </button>
            </Tooltip>
            <Show when={notice().progress != null}>
              <div class="sb-attention-progress" aria-hidden="true">
                <span style={{ "--sb-attention-progress": `${notice().progress ?? 0}%` }} />
              </div>
            </Show>
          </div>
        )
      }}
    </Show>
  )
}
