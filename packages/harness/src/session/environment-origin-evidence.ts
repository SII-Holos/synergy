import type { EnvironmentOriginSchema } from "../environment/origin-schema"
import type { MessageV2 } from "./message-v2"
import type { Info } from "./types"
import type { RolloutSchema } from "./rollout/schema"

export namespace SessionEnvironmentOriginEvidence {
  export interface Evidence {
    session: Pick<Info, "id" | "scope" | "environmentID" | "paused" | "time">
    root: MessageV2.Info
    message: MessageV2.Info
    run: RolloutSchema.RunRecord
    tool: RolloutSchema.ToolExecutionRecord | undefined
  }

  export function verifySession(
    origin: Readonly<EnvironmentOriginSchema.Session>,
    session: Evidence["session"],
    target?: Readonly<{ scopeID: string; environmentID?: string }>,
  ) {
    if (session.id !== origin.sessionID || session.scope.id !== origin.scopeID)
      throw new Error("Environment origin belongs to another Session or Scope")
    if (target?.environmentID && session.environmentID !== target.environmentID)
      throw new Error("Environment origin differs from its Session's selected Environment")
  }

  export function verify(
    origin: Readonly<EnvironmentOriginSchema.Session>,
    evidence: Evidence,
    admission: boolean,
    target?: Readonly<{ scopeID: string; environmentID?: string }>,
  ): asserts evidence is Evidence & { tool: RolloutSchema.ToolExecutionRecord } {
    const { session, root, message, run, tool } = evidence
    verifySession(origin, session, target)
    if (
      root.role !== "user" ||
      root.sessionID !== origin.sessionID ||
      !root.isRoot ||
      root.rootID !== root.id ||
      root.id !== origin.rootID ||
      message.role !== "assistant" ||
      message.id !== origin.messageID ||
      message.sessionID !== session.id ||
      message.rootID !== root.id ||
      run.id !== origin.runID ||
      run.id !== root.id ||
      run.owner.kind !== "session" ||
      run.owner.scopeID !== origin.scopeID ||
      run.owner.sessionID !== origin.sessionID ||
      !tool ||
      tool.owner.kind !== "session" ||
      tool.owner.scopeID !== origin.scopeID ||
      tool.owner.sessionID !== origin.sessionID ||
      tool.runID !== origin.runID ||
      tool.messageID !== origin.messageID ||
      tool.toolCallID !== origin.callID ||
      tool.tool !== origin.tool
    )
      throw new Error("Environment origin does not match its canonical native root, Run and tool call")
    if (
      admission &&
      (session.paused ||
        session.time.archived ||
        run.status !== "running" ||
        run.cancelRequestedAt ||
        run.recording === "failed" ||
        tool.status !== "running")
    )
      throw new Error("Environment origin cannot start another native effect")
  }
}
