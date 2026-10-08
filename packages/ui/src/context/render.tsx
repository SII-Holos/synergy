import { createContext, useContext, type ParentProps } from "solid-js"
import type { RenderArtifact } from "@ericsanchezok/synergy-util/render-artifact"

export class RenderStateConflict extends Error {
  constructor(
    message: string,
    readonly state: RenderArtifact.State,
  ) {
    super(message)
    this.name = "RenderStateConflict"
  }
}

export interface RenderHost {
  read(
    target: RenderArtifact.Target,
    signal: AbortSignal,
  ): Promise<{ source: RenderArtifact.Source; state: RenderArtifact.State }>
  write(target: RenderArtifact.Target, input: RenderArtifact.Write): Promise<RenderArtifact.State>
  followUp(
    target: RenderArtifact.Target,
    source: RenderArtifact.Source,
    input: RenderArtifact.FollowUp,
  ): Promise<"sent" | "cancelled">
}
const Context = createContext<RenderHost>()
export function RenderProvider(props: ParentProps<{ value: RenderHost }>) {
  return <Context.Provider value={props.value}>{props.children}</Context.Provider>
}
export function useRenderHost() {
  return useContext(Context)
}
