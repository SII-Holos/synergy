import { createContext, useContext, type ParentProps } from "solid-js"
import { RenderArtifact } from "@ericsanchezok/synergy-util/render-artifact"

export function readRenderState(metadata: unknown): RenderArtifact.State {
  if (!metadata || typeof metadata !== "object" || !("visualState" in metadata)) return RenderArtifact.emptyState()
  try {
    return RenderArtifact.state({ visualState: JSON.parse(JSON.stringify(metadata.visualState)) })
  } catch {
    return RenderArtifact.emptyState()
  }
}

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
  observe?(
    target: RenderArtifact.Target,
    update: (state: RenderArtifact.State) => void,
    unavailable: () => void,
  ): () => void
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
