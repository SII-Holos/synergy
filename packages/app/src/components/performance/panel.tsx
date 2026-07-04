import { AppPanel } from "@/components/app-panel"
import { PerformanceDashboard } from "./PerformanceDashboard"
import "./performance-panel.css"

export function PerformancePanel() {
  return (
    <AppPanel.Root class="performance-workbench">
      <AppPanel.Content>
        <AppPanel.Header class="performance-header">
          <div class="performance-header-inner">
            <AppPanel.HeaderRow>
              <AppPanel.Title>Performance</AppPanel.Title>
            </AppPanel.HeaderRow>
            <AppPanel.Subtitle>
              Live runtime resource usage, trace latency, browser metrics, and performance issues.
            </AppPanel.Subtitle>
          </div>
        </AppPanel.Header>
        <AppPanel.Body padding={false} class="performance-body">
          <div class="performance-stage">
            <PerformanceDashboard />
          </div>
        </AppPanel.Body>
      </AppPanel.Content>
    </AppPanel.Root>
  )
}
