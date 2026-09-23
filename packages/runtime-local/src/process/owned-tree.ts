import { z } from "zod"
import { DarwinCoalition } from "./darwin-coalition"
import { WindowsJob } from "./windows-job"

export namespace OwnedTree {
  export const Reference = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("darwin-coalition"), bootID: z.string(), coalitionID: z.string() }),
    z.object({ kind: z.literal("windows-job"), name: z.string() }),
  ])
  export type Reference = z.infer<typeof Reference>

  export function capture(pid: number): Reference {
    if (process.platform === "darwin") return { kind: "darwin-coalition", ...DarwinCoalition.capture(pid) }
    if (process.platform === "win32") return { kind: "windows-job", ...WindowsJob.capture(pid) }
    throw new Error("Native process ownership is unavailable on this platform")
  }
  export function current(): Reference {
    if (process.platform === "darwin") return { kind: "darwin-coalition", ...DarwinCoalition.current() }
    if (process.platform === "win32") return { kind: "windows-job", ...WindowsJob.capture(process.pid) }
    throw new Error("Native process ownership is unavailable on this platform")
  }
  export function inspect(reference: Reference) {
    return reference.kind === "darwin-coalition" ? DarwinCoalition.inspect(reference) : WindowsJob.inspect(reference)
  }
  export function terminate(reference: Reference, signal: "SIGTERM" | "SIGKILL" = "SIGTERM") {
    if (reference.kind === "darwin-coalition") DarwinCoalition.terminate(reference, signal)
    else WindowsJob.terminate(reference)
  }
  export function terminateDescendants(reference: Reference, signal: "SIGTERM" | "SIGKILL") {
    if (reference.kind === "darwin-coalition") DarwinCoalition.terminateDescendants(signal)
    else WindowsJob.terminateDescendants(reference)
  }
}
