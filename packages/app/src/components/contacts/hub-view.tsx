interface HolosProfile {
  name: string
  bio?: string
}

import { Show } from "solid-js"
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
      <section class="rounded-[1.35rem] bg-surface-raised-base/95 p-3 shadow-[inset_0_1px_0_rgba(214,204,190,0.08),inset_0_-1px_0_rgba(24,28,38,0.04)]">
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
      </section>

      <div class="mt-6">
        <StatsSection />
      </div>
    </>
  )
}
