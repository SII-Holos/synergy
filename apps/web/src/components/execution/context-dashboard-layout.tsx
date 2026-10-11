import type { JSX } from "solid-js"

export function ContextDashboardLayout(props: {
  composition: JSX.Element
  metrics: JSX.Element
  history: JSX.Element
  timing: JSX.Element
  contents: JSX.Element
  events: JSX.Element
  activity: JSX.Element
}) {
  return (
    <div class="context-dashboard-layout">
      <div class="context-analysis-column">
        {props.composition}
        {props.metrics}
        <div class="context-history-section">{props.history}</div>
        {props.events}
      </div>
      <div class="context-inspection-column">
        {props.timing}
        {props.contents}
        {props.activity}
      </div>
    </div>
  )
}
