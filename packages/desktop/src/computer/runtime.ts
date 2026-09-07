import { randomUUID } from "node:crypto"
import { z } from "zod"
import {
  ComputerCommandSchema,
  ComputerError,
  ComputerResultSchema,
  type ComputerCommand,
  type ComputerResult,
} from "@ericsanchezok/synergy-computer"

const NativeResult = z.object({
  isError: z.boolean().optional(),
  content: z
    .array(
      z.discriminatedUnion("type", [
        z.object({ type: z.literal("text"), text: z.string().max(1_000_000) }),
        z.object({
          type: z.literal("image"),
          mimeType: z.enum(["image/png", "image/jpeg"]),
          data: z.string().max(8 * 1024 * 1024),
        }),
      ]),
    )
    .max(20),
  structuredContent: z.record(z.string(), z.unknown()).optional(),
})
type NativeCall = (name: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>
type Observation = { id: string; pid: number; windowId: number; snapshotId?: string; expires: number }
type Run = { session: string; observation?: Observation; updated: number }

// Cua v0.23.2: exact-window snapshots and per-PID background mutation serialization.
// https://github.com/trycua/cua/tree/cua-driver-rs-v0.23.2/libs/cua-driver
export class ComputerRuntime {
  private readonly runs = new Map<string, Run>()
  private readonly busy = new Set<string>()
  private readonly busyPids = new Set<number>()
  constructor(private readonly call: NativeCall) {}

  async execute(owner: string, command: ComputerCommand, signal?: AbortSignal): Promise<ComputerResult> {
    command = ComputerCommandSchema.parse(command)
    signal?.throwIfAborted()
    if (this.busy.has(owner))
      throw new ComputerError("computer_busy", "Another Computer action in this task is still running.")
    const pid =
      command.type === "observe"
        ? command.pid
        : command.type === "action"
          ? this.runs.get(owner)?.observation?.pid
          : undefined
    if (pid !== undefined && this.busyPids.has(pid))
      throw new ComputerError(
        "computer_application_busy",
        "Another operation in this application is still running. Retry observation when it finishes.",
      )
    this.busy.add(owner)
    if (pid !== undefined) this.busyPids.add(pid)
    try {
      if (command.type === "release") {
        const run = this.runs.get(owner)
        this.runs.delete(owner)
        if (run) await this.native("end_session", { session: run.session }, signal)
        return { output: "Computer task released.", images: [], metadata: {} }
      }
      if (command.type === "apps") return this.native("list_windows", { on_screen_only: true }, signal)
      const run = this.run(owner)
      if (command.type === "observe") {
        for (const other of this.runs.values()) {
          if (other.observation?.pid === command.pid && other.observation.windowId === command.windowId)
            other.observation = undefined
        }
        run.observation = undefined
        const result = await this.native(
          "get_window_state",
          {
            session: run.session,
            pid: command.pid,
            window_id: command.windowId,
            max_elements: 1000,
            max_depth: 20,
          },
          signal,
        )
        signal?.throwIfAborted()
        const id = randomUUID()
        const snapshotId = z
          .string()
          .regex(/^s[0-9a-f]{8}$/)
          .optional()
          .parse(result.metadata.snapshot_id)
        run.observation = { id, pid: command.pid, windowId: command.windowId, snapshotId, expires: Date.now() + 60_000 }
        return {
          ...result,
          observationId: id,
          output: `Observation ${id}. Coordinates are pixels in this window screenshot.\n${result.output}`,
        }
      }
      const observed = run.observation
      run.observation = undefined
      if (!observed || observed.id !== command.input.observationId || observed.expires < Date.now()) {
        throw new ComputerError(
          "computer_observation_stale",
          "Observe this window again in this task before acting. Each observation permits one action and expires after one minute.",
        )
      }
      const input = command.input
      const args: Record<string, unknown> = {
        session: run.session,
        pid: observed.pid,
        window_id: observed.windowId,
        delivery_mode: "background",
      }
      let tool: string
      if (input.action === "click") {
        if (!observed.snapshotId)
          throw new ComputerError(
            "computer_snapshot_missing",
            "Observe again or use a screenshot point; no native element snapshot is available.",
          )
        tool = "click"
        Object.assign(args, { element_index: input.elementIndex, snapshot_id: observed.snapshotId })
      } else if (input.action === "point") {
        tool = "click"
        Object.assign(args, { x: input.x, y: input.y })
      } else if (input.action === "type") {
        tool = "type_text"
        args.text = input.text
      } else if (input.action === "key") {
        tool = "press_key"
        args.key = input.key
      } else {
        tool = "scroll"
        Object.assign(args, { direction: input.direction, amount: input.amount, by: "line" })
      }
      const result = await this.native(tool, args, signal)
      return {
        ...result,
        output: `${result.output}\nObserve again to verify the outcome before another action. Do not repeat an unverified action automatically.`,
      }
    } finally {
      this.busy.delete(owner)
      if (pid !== undefined) this.busyPids.delete(pid)
    }
  }

  reset() {
    this.runs.clear()
  }

  private run(owner: string): Run {
    for (const [key, run] of this.runs) {
      if (!this.busy.has(key) && Date.now() - run.updated > 240_000) this.runs.delete(key)
    }
    let run = this.runs.get(owner)
    if (!run) {
      if (this.runs.size >= 64)
        throw new ComputerError(
          "computer_capacity",
          "Computer Use has too many active tasks. Retry after an idle task expires.",
        )
      run = { session: `synergy-${randomUUID()}`, updated: Date.now() }
      this.runs.set(owner, run)
    }
    run.updated = Date.now()
    return run
  }

  private async native(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<ComputerResult> {
    const result = NativeResult.parse(await this.call(name, args, signal))
    const text = result.content.flatMap((x) => (x.type === "text" ? [x.text] : [])).join("\n")
    if (result.isError)
      throw new ComputerError("computer_native_error", text.slice(0, 20_000) || "The native Computer action failed.")
    const metadata = result.structuredContent ?? {}
    return ComputerResultSchema.parse({
      output: (JSON.stringify(metadata) + "\n" + text).slice(0, 900_000),
      metadata,
      images: result.content.flatMap((x) => (x.type === "image" ? [{ mimeType: x.mimeType, data: x.data }] : [])),
    })
  }
}
