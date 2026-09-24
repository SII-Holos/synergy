import { z } from "zod"
import { DarwinCoalition } from "./darwin-coalition"
import { WindowsJob } from "./windows-job"
import { LinuxTree } from "./linux-tree"

export namespace OwnedTree {
  export const Reference = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("darwin-coalition"), bootID: z.string(), coalitionID: z.string() }),
    z.object({ kind: z.literal("windows-job"), name: z.string() }),
    LinuxTree.Reference.extend({ kind: z.literal("linux-subreaper") }),
  ])
  export type Reference = z.infer<typeof Reference>

  export function capture(pid: number): Reference {
    if (process.platform === "darwin") return { kind: "darwin-coalition", ...DarwinCoalition.capture(pid) }
    if (process.platform === "win32") return { kind: "windows-job", ...WindowsJob.capture(pid) }
    if (process.platform === "linux") return { kind: "linux-subreaper", ...LinuxTree.capture(pid) }
    throw new Error("Native process ownership is unavailable on this platform")
  }
  export function current(): Reference {
    if (process.platform === "darwin") return { kind: "darwin-coalition", ...DarwinCoalition.current() }
    if (process.platform === "win32") return { kind: "windows-job", ...WindowsJob.capture(process.pid) }
    if (process.platform === "linux") return { kind: "linux-subreaper", ...LinuxTree.current() }
    throw new Error("Native process ownership is unavailable on this platform")
  }
  export function inspect(reference: Reference) {
    if (reference.kind === "linux-subreaper") return LinuxTree.inspect(reference)
    return reference.kind === "darwin-coalition" ? DarwinCoalition.inspect(reference) : WindowsJob.inspect(reference)
  }
  export function hasDescendants(reference: Reference) {
    if (reference.kind === "linux-subreaper") return !LinuxTree.drained()
    const value =
      reference.kind === "darwin-coalition" ? DarwinCoalition.inspect(reference) : WindowsJob.inspect(reference)
    return value.state === "active" && value.processes > 1
  }
  export function complete(reference: Reference) {
    if (reference.kind === "linux-subreaper") LinuxTree.complete()
  }
  export function retire(reference: Reference) {
    if (reference.kind === "linux-subreaper") LinuxTree.retire(reference)
  }
  export function terminate(reference: Reference, signal: "SIGTERM" | "SIGKILL" = "SIGTERM") {
    if (reference.kind === "darwin-coalition") DarwinCoalition.terminate(reference, signal)
    else if (reference.kind === "windows-job") WindowsJob.terminate(reference)
    else LinuxTree.terminate(reference)
  }
  export function terminateDescendants(reference: Reference, signal: "SIGTERM" | "SIGKILL") {
    if (reference.kind === "darwin-coalition") DarwinCoalition.terminateDescendants(signal)
    else if (reference.kind === "windows-job") WindowsJob.terminateDescendants(reference)
    else LinuxTree.terminateDescendants(signal)
  }
}
