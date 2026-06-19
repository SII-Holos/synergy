interface HolosProfile {
  name: string
  bio?: string
}

import { AppPanel } from "@/components/app-panel"
import { AgentCard } from "./agent-card"
import { StatsSection } from "@/components/stats/stats-section"

export function HubView(props: {
  profile: HolosProfile | null
  agentId: string | null
  connectionStatus: string
  loggedIn: boolean
  isGuest: boolean
  connecting: boolean
  reconnecting: boolean
  onDisconnect: () => void
  onReconnect: () => void
  onConnectHolos: () => void
}) {
  return (
    <>
      <AppPanel.Section label="Profile">
        <AgentCard
          profile={props.profile}
          agentId={props.agentId}
          connectionStatus={props.connectionStatus}
          loggedIn={props.loggedIn}
          isGuest={props.isGuest}
          connecting={props.connecting}
          reconnecting={props.reconnecting}
          onDisconnect={props.onDisconnect}
          onReconnect={props.onReconnect}
          onConnectHolos={props.onConnectHolos}
        />
      </AppPanel.Section>
      <AppPanel.Section label="Usage Trends">
        <StatsSection />
      </AppPanel.Section>
    </>
  )
}
