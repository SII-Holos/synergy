import { Show, type JSX } from "solid-js"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { Tooltip } from "@ericsanchezok/synergy-ui/tooltip"

export function SidebarNavigation(props: {
  expanded: boolean
  labels: { expand: string; collapse: string; search: string; newSession: string }
  onToggle: () => void
  onSearch: () => void
  onNew: () => void
  notice?: string
  children?: JSX.Element
}) {
  return (
    <div class="sb-navigation" data-sidebar-navigation>
      <Tooltip value={props.expanded ? props.labels.collapse : props.labels.expand} placement="bottom">
        <button
          type="button"
          class="sb-icon-btn sb-navigation-toggle"
          data-sidebar-toggle
          aria-label={props.expanded ? props.labels.collapse : props.labels.expand}
          aria-expanded={props.expanded}
          onClick={props.onToggle}
        >
          <Icon name={getSemanticIcon("app.sidebar")} size="normal" />
          <Show when={!props.expanded && props.notice}>
            <span class="sb-navigation-notice" role="status" aria-label={props.notice} />
          </Show>
        </button>
      </Tooltip>
      <div class="sb-navigation-brand">{props.children}</div>
      <Tooltip value={props.labels.search} placement="bottom" class="sb-navigation-search">
        <button type="button" class="sb-icon-btn" aria-label={props.labels.search} onClick={props.onSearch}>
          <Icon name={getSemanticIcon("action.search")} size="normal" />
        </button>
      </Tooltip>
      <Show when={!props.expanded}>
        <Tooltip value={props.labels.newSession} placement="bottom">
          <button type="button" class="sb-icon-btn" aria-label={props.labels.newSession} onClick={props.onNew}>
            <Icon name={getSemanticIcon("session.new")} size="normal" />
          </button>
        </Tooltip>
      </Show>
    </div>
  )
}
