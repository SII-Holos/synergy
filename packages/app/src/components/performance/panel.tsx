import { AppPanel } from "@/components/app-panel"
import { PerformanceDashboard } from "./PerformanceDashboard"

export function PerformancePanel() {
  return (
    <AppPanel.Root class="performance-workbench">
      <AppPanel.Content>
        <AppPanel.Header>
          <AppPanel.HeaderRow>
            <AppPanel.Title>Performance</AppPanel.Title>
          </AppPanel.HeaderRow>
          <AppPanel.Subtitle>
            Live runtime resource usage, trace latency, browser metrics, and performance issues.
          </AppPanel.Subtitle>
        </AppPanel.Header>
        <AppPanel.Body>
          <PerformanceDashboard />
        </AppPanel.Body>
      </AppPanel.Content>
    </AppPanel.Root>
  )
}
