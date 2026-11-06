import type { I18n } from "@lingui/core"
import { useLingui } from "@lingui/solid"
import type { BrowserAgentActivity } from "@ericsanchezok/synergy-browser-core"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { browser as B } from "@/locales/messages"
import type { BrowserCatalog } from "./browser-catalog"
import "./browser-tab.css"

export function browserTabActivity(catalog: BrowserCatalog | undefined, pageId?: string, sessionID?: string) {
  if (!catalog || !pageId || !sessionID) return
  const activities = catalog.store.agentActivitiesFor(sessionID).filter((item) => item.pageId === pageId)
  return activities.findLast((item) => item.kind !== "idle") ?? activities.at(-1)
}

export function browserTabDescription(i18n: Pick<I18n, "_">, activity?: BrowserAgentActivity) {
  if (!activity) return
  return i18n._({
    ...B.agentActivity,
    values: { kind: activity.kind },
  })
}

export function BrowserTabIcon(props: { activity?: BrowserAgentActivity }) {
  const lingui = useLingui()
  const description = () => browserTabDescription(lingui, props.activity)
  return (
    <span
      class="browser-tab-icon"
      data-browser-agent-kind={props.activity?.kind}
      role={props.activity ? "img" : undefined}
      aria-label={description()}
      title={description()}
    >
      <Icon name={getSemanticIcon(props.activity ? "agent.identity" : "browser.main")} size="small" />
    </span>
  )
}
