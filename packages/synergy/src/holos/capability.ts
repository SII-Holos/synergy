import z from "zod"
import { RemoteExecution } from "@/tool/remote-execution"

export namespace HolosCapability {
  export const Key = z.enum(["agora", "websearch", "arxiv", "remote_execution"]).meta({ ref: "HolosCapabilityKey" })
  export type Key = z.infer<typeof Key>

  export const Status = z.enum(["available", "locked", "degraded", "unknown"]).meta({ ref: "HolosCapabilityStatus" })
  export type Status = z.infer<typeof Status>

  export const Reason = z
    .enum([
      "not_logged_in",
      "not_connected",
      "quota_unavailable",
      "quota_exhausted",
      "temporarily_unavailable",
      "unknown",
    ])
    .meta({ ref: "HolosCapabilityReason" })
  export type Reason = z.infer<typeof Reason>

  export const Action = z
    .object({
      kind: z
        .enum(["login_holos", "reconnect_holos", "open_settings", "wait"])
        .meta({ ref: "HolosCapabilityActionKind" }),
      label: z.string(),
    })
    .meta({ ref: "HolosCapabilityAction" })
  export type Action = z.infer<typeof Action>

  export const Item = z
    .object({
      key: Key,
      status: Status,
      reason: Reason.optional(),
      title: z.string(),
      description: z.string(),
      action: Action.optional(),
    })
    .meta({ ref: "HolosCapabilityItem" })
  export type Item = z.infer<typeof Item>

  export const State = z.object({ items: Item.array() }).meta({ ref: "HolosCapabilityState" })
  export type State = z.infer<typeof State>

  export type ReadinessInput = {
    ready: boolean
    reason?: "not_logged_in" | "not_connected"
  }

  function actionFor(reason: Reason | undefined): Action | undefined {
    if (reason === "not_logged_in") return { kind: "login_holos", label: "Connect Holos" }
    if (reason === "not_connected") return { kind: "reconnect_holos", label: "Reconnect Holos" }
    if (reason === "temporarily_unavailable") return { kind: "wait", label: "Try again later" }
    return undefined
  }

  function item(input: { key: Key; status: Status; reason?: Reason; title: string; description: string }): Item {
    return {
      ...input,
      action: actionFor(input.reason),
    }
  }

  function readyStatus(readiness: ReadinessInput): { status: Status; reason?: Reason } {
    if (readiness.ready) return { status: "available" }
    return { status: "locked", reason: readiness.reason }
  }

  export async function get(readiness: ReadinessInput): Promise<State> {
    const remoteClientConnected = !!RemoteExecution.getClient()
    const ready = readyStatus(readiness)

    return {
      items: [
        item({
          key: "agora",
          ...ready,
          title: "Agora",
          description: "Community workspaces and collaboration.",
        }),
        item({
          key: "websearch",
          ...ready,
          title: "Web search",
          description: "Search the web with your Holos identity.",
        }),
        item({
          key: "arxiv",
          ...ready,
          title: "arXiv",
          description: "Search and download academic papers.",
        }),
        item({
          key: "remote_execution",
          ...(remoteClientConnected
            ? { status: "available" as const }
            : readiness.ready
              ? { status: "degraded" as const, reason: "temporarily_unavailable" as const }
              : ready),
          title: "Remote execution",
          description: "Run tasks on remote machines.",
        }),
      ],
    }
  }
}
