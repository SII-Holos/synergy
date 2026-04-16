import { Show } from "solid-js"
import { usePanel } from "@/context/panel"
import { ScopesCardView } from "./scopes-card-view"
import { SessionListView } from "./session-list-view"

export function ScopesPanel() {
  const panel = usePanel()
  const drilldown = panel.scopes.drilldown

  return (
    <Show when={drilldown()} fallback={<ScopesCardView />}>
      {(worktree) => <SessionListView worktree={worktree()} />}
    </Show>
  )
}
