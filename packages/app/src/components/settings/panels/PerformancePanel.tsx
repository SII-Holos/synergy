import { PerformanceDashboard } from "@/components/performance/PerformanceDashboard"
import { SettingsPage, SettingsSection } from "../components/SettingsPrimitives"

export function PerformancePanel() {
  return (
    <SettingsPage
      title="Performance"
      description="Live runtime resource usage, trace latency, browser metrics, and performance issues."
    >
      <SettingsSection>
        <PerformanceDashboard />
      </SettingsSection>
    </SettingsPage>
  )
}
