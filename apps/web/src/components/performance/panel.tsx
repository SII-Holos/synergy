import { useLingui } from "@lingui/solid"
import { AppPanel } from "@/components/app-panel"
import { PerformanceDashboard } from "./PerformanceDashboard"
import { P } from "./performance-i18n"
import { WorkspaceMobileHeader } from "@/components/workspace/mobile-header"
import { useWorkspaceMobileHeaderClose } from "@/components/workspace/mobile-header-close"
import "./performance-panel.css"

export function PerformancePanel() {
  const { _ } = useLingui()
  const onCloseWorkspace = useWorkspaceMobileHeaderClose()
  return (
    <AppPanel.Root class="performance-workbench">
      <AppPanel.Content>
        <WorkspaceMobileHeader onClose={onCloseWorkspace} />
        <AppPanel.Header class="performance-header">
          <div class="performance-header-inner">
            <AppPanel.HeaderRow>
              <AppPanel.Title>{_(P.panelTitle)}</AppPanel.Title>
            </AppPanel.HeaderRow>
            <AppPanel.Subtitle>{_(P.panelSubtitle)}</AppPanel.Subtitle>
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
