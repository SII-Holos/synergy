import { randomUUID } from "node:crypto"
import { setTimeout } from "node:timers/promises"
import { z } from "zod"
import {
  ComputerCommandSchema,
  ComputerError,
  ComputerResultSchema,
  computerActionPoints,
  type ComputerCommand,
  type ComputerResult,
  type ComputerObservation,
} from "@ericsanchezok/synergy-computer-protocol"

import { boundedText, describeObservation } from "./observation.js"

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
export type ComputerPermissions = { accessibility: boolean; screen: boolean }
type NativeCall = (name: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>
type Observation = {
  id: string
  pid: number
  windowId: number
  snapshotId?: string
  captureId?: string
  token?: string
  indices: number[]
  quality: ComputerObservation
  expires: number
}
type Run = { session: string; observation?: Observation; updated: number }

// Provenance: https://github.com/trycua/cua/tree/bf6c76786d938070f4ecf1e44004752f69f518b8/libs/cua-driver
// Local adaptation: bounded exact-window observations and one-use action admission.
export class ComputerRuntime {
  private generation = 0
  private readonly runs = new Map<string, Run>()
  private readonly busy = new Set<string>()
  private readonly busyPids = new Set<number>()
  private activeInputs = 0
  private foregroundBusy = false
  constructor(private readonly call: NativeCall) {}

  async execute(
    owner: string,
    command: ComputerCommand,
    signal?: AbortSignal,
    permissions: ComputerPermissions = { accessibility: true, screen: true },
  ): Promise<ComputerResult> {
    const generation = this.generation
    const result = await this.executeCommand(owner, command, signal, permissions)
    if (generation !== this.generation)
      throw new ComputerError(
        "computer_runtime_reset",
        "The native Computer runtime reset during this operation. Its outcome is uncertain; observe again before deciding whether to retry.",
      )
    return result
  }

  private async executeCommand(
    owner: string,
    command: ComputerCommand,
    signal: AbortSignal | undefined,
    permissions: ComputerPermissions,
  ): Promise<ComputerResult> {
    command = ComputerCommandSchema.parse(command)
    signal?.throwIfAborted()
    const foreground =
      command.type === "observe"
        ? command.foreground === true
        : command.type === "action" && command.input.action !== "set_value" && command.input.foreground === true
    const mutating = foreground || command.type === "action"
    if (mutating && !permissions.accessibility)
      throw new ComputerError(
        "computer_permissions_required",
        "Enable Accessibility for Synergy in macOS System Settings, then observe again.",
      )
    if (mutating && (this.foregroundBusy || (foreground && this.activeInputs > 0)))
      throw new ComputerError(
        "computer_input_busy",
        "Another input operation is running. Wait for it to finish, then observe again.",
      )
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
    if (mutating) this.activeInputs++
    if (foreground) this.foregroundBusy = true
    try {
      if (command.type === "release") {
        const run = this.runs.get(owner)
        this.runs.delete(owner)
        if (run) await this.native("end_session", { session: run.session }, signal)
        return { output: "Computer task released.", images: [], metadata: {} }
      }
      if (command.type === "apps") {
        const result = await this.native("list_windows", { on_screen_only: false }, signal)
        const windows = z.array(z.record(z.string(), z.unknown())).safeParse(result.metadata.windows)
        if (!windows.success)
          throw new ComputerError("computer_discovery_invalid", "Window discovery was incomplete. Retry computer_apps.")
        const query = command.query?.toLocaleLowerCase()
        const selected = windows.data.filter(
          (window) =>
            !query ||
            [window.app_name, window.owner_name, window.title, window.window_title].some(
              (value) => typeof value === "string" && value.toLocaleLowerCase().includes(query),
            ),
        )
        return {
          output: boundedText(JSON.stringify(selected, null, 2)).text,
          images: [],
          metadata: { windows: selected },
        }
      }
      const run = this.run(owner)
      if (command.type === "observe") {
        if (!permissions.accessibility && !permissions.screen)
          throw new ComputerError(
            "computer_permissions_required",
            "Enable Accessibility or Screen Recording for Synergy in macOS System Settings, then observe again.",
          )
        for (const other of this.runs.values()) {
          if (other.observation?.pid === command.pid && other.observation.windowId === command.windowId)
            other.observation = undefined
        }
        run.observation = undefined
        if (command.foreground) {
          const activated = await this.native(
            "bring_to_front",
            { session: run.session, pid: command.pid, window_id: command.windowId },
            signal,
          )
          if (activated.metadata.activated !== true)
            throw new ComputerError(
              "computer_foreground_unavailable",
              "The selected window could not be brought to the foreground. Find its current windowId and observe again.",
            )
        }
        const capture = () =>
          this.native(
            "get_window_state",
            {
              session: run.session,
              pid: command.pid,
              window_id: command.windowId,
              max_elements: 1000,
              max_depth: 20,
              timeout_ms: 3000,
              max_image_dimension: 2048,
              query: command.query,
              synergy: true,
              include_accessibility_tree: permissions.accessibility,
              include_screenshot: permissions.screen,
            },
            signal,
          )
        let result = await capture()
        for (let attempt = 0; command.foreground && attempt < 2; attempt++) {
          const quality = z.object({ image_status: z.string() }).safeParse(result.metadata.synergy)
          const failure = z.object({ reason: z.string() }).safeParse(result.metadata.screenshot_error)
          const transition =
            (quality.success && ["invalid", "unverified"].includes(quality.data.image_status)) ||
            (failure.success && failure.data.reason.includes("changed identity"))
          if (!transition) break
          await setTimeout(150, undefined, { signal })
          result = await capture()
        }
        signal?.throwIfAborted()
        const id = randomUUID()
        const described = describeObservation({
          id,
          pid: command.pid,
          windowId: command.windowId,
          query: command.query,
          capturedAt: Date.now(),
          result,
        })
        run.observation = {
          id,
          pid: command.pid,
          windowId: command.windowId,
          snapshotId: described.snapshotId,
          captureId: described.captureId,
          token: described.token,
          indices: described.indices,
          quality: described.observation,
          expires: performance.now() + 60_000,
        }
        const captureError = z
          .object({
            code: z.string().max(100).optional(),
            reason: z
              .string()
              .transform((value) => value.slice(0, 2000))
              .optional(),
          })
          .safeParse(result.metadata.screenshot_error)
        return {
          output: described.output,
          observationId: id,
          observation: described.observation,
          images: described.images,
          metadata: {
            deliveryMode: command.foreground ? "foreground" : "background",
            computerObservation: described.observation,
            ...(captureError.success ? { computerDiagnostics: { captureError: captureError.data } } : {}),
          },
        }
      }
      const observed = run.observation
      run.observation = undefined
      if (!observed || observed.id !== command.input.observationId || observed.expires <= performance.now()) {
        throw new ComputerError(
          "computer_observation_stale",
          "Observe this window again in this task before acting. Each observation permits one action and expires after one minute.",
        )
      }
      const input = command.input
      const availability = observed.quality.actions[input.action]
      if (!availability.available || !observed.token)
        throw new ComputerError(
          "computer_action_unavailable",
          `${input.action} is unavailable: ${availability.reason ?? "target_unverified"}. Observe again or use an available action.`,
        )
      const points = computerActionPoints(input)
      if (points.length) {
        if (observed.quality.image.status !== "valid" || !observed.captureId)
          throw new ComputerError(
            "computer_image_unavailable",
            "Coordinates need a valid window image. Observe again; use foreground:true if background capture is unavailable.",
          )
        if (!command.imageReceipt || !command.imageReceipt.sha256.includes(observed.quality.image.sha256!))
          throw new ComputerError(
            "computer_image_not_delivered",
            "This image was not included in the model request that selected this action. Observe again with an image-capable model.",
          )
        if (
          points.some((point) => point.x >= observed.quality.image.width! || point.y >= observed.quality.image.height!)
        )
          throw new ComputerError(
            "computer_point_out_of_bounds",
            "The point is outside the observed image. Observe again and choose a point within its dimensions.",
          )
      }
      const args: Record<string, unknown> = {
        session: run.session,
        pid: observed.pid,
        window_id: observed.windowId,
        ...(input.action !== "set_value" ? { delivery_mode: input.foreground ? "foreground" : "background" } : {}),
        synergy_guard: observed.token,
      }
      const target = input.action === "drag" ? undefined : input.target
      if (target && "elementIndex" in target) {
        if (!observed.snapshotId || !observed.indices.includes(target.elementIndex))
          throw new ComputerError(
            "computer_snapshot_missing",
            "This element was not returned by the observation. Observe again and use a returned element index.",
          )
        Object.assign(args, { element_index: target.elementIndex, snapshot_id: observed.snapshotId })
      }
      if (target && "x" in target) Object.assign(args, target)
      if (points.length) args.capture_id = observed.captureId
      let tool: string
      if (input.action === "click") {
        tool = input.count === 2 && "elementIndex" in input.target ? "double_click" : "click"
        if (tool === "click") Object.assign(args, { button: input.button ?? "left", count: input.count ?? 1 })
        else if (input.button && input.button !== "left")
          throw new ComputerError(
            "computer_action_unsupported",
            "Double-click an element with the left button, or use image coordinates.",
          )
      } else if (input.action === "type") {
        tool = "type_text"
        args.text = input.text
      } else if (input.action === "key") {
        tool = input.modifiers?.length ? "hotkey" : "press_key"
        if (input.modifiers?.length) args.keys = [...new Set(input.modifiers), input.key]
        else args.key = input.key
      } else if (input.action === "scroll") {
        tool = "scroll"
        Object.assign(args, { direction: input.direction, amount: input.amount, by: "line" })
      } else if (input.action === "drag") {
        tool = "drag"
        Object.assign(args, {
          from_x: input.from.x,
          from_y: input.from.y,
          to_x: input.to.x,
          to_y: input.to.y,
          ...(input.durationSeconds === undefined ? {} : { duration_ms: Math.round(input.durationSeconds * 1000) }),
        })
      } else {
        tool = "set_value"
        args.value = input.value
      }
      const result = await this.native(tool, args, signal)
      const delivery = z.object({ mode: z.enum(["background", "foreground"]) }).safeParse(result.metadata.delivery)
      return {
        ...result,
        images: [],
        metadata: {
          ...result.metadata,
          computerTarget: observed.quality.target,
          deliveryMode: delivery.success
            ? delivery.data.mode
            : input.action !== "set_value" && input.foreground
              ? "foreground"
              : "background",
          ...(points.length && command.imageReceipt
            ? {
                imageAdmission: {
                  callID: command.imageReceipt.callID,
                  sha256: observed.quality.image.sha256,
                  observationId: observed.id,
                },
              }
            : {}),
        },
        output: "Action dispatched. Observe again to verify the result before another action.",
      }
    } finally {
      this.busy.delete(owner)
      if (pid !== undefined) this.busyPids.delete(pid)
      if (mutating) this.activeInputs--
      if (foreground) this.foregroundBusy = false
    }
  }

  reset() {
    this.generation++
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
    const metadata = result.structuredContent ?? {}
    if (result.isError) {
      if (text.includes("computer_target_changed"))
        throw new ComputerError("computer_observation_stale", "The window changed. Observe again before acting.")
      if (metadata.code === "foreground_unavailable")
        throw new ComputerError(
          "computer_foreground_unavailable",
          "The target could not receive foreground input. Observe again before deciding whether to retry.",
        )
      if (metadata.code === "background_unavailable" || metadata.code === "off_space_or_ax_unresolved")
        throw new ComputerError(
          "computer_background_unavailable",
          "Background input is unavailable for this control. Observe again, then use foreground:true if needed.",
        )
      if (
        [
          "window_id_not_found",
          "window_owner_pid_mismatch",
          "window_target_not_found",
          "window_target_resolution_failed",
        ].includes(String(metadata.code))
      )
        throw new ComputerError(
          "computer_window_unavailable",
          "This window no longer belongs to the selected app. Use computer_apps to find its current pid and windowId, then observe it.",
        )
      const refusal = z.object({ code: z.string().regex(/^[a-zA-Z0-9_]{1,100}$/) }).safeParse(metadata.refusal)
      const code = refusal.success ? refusal.data.code : "computer_native_error"
      throw new ComputerError(
        code,
        `${code}: native operation did not complete. Observe the target again before choosing another action.`,
      )
    }
    return ComputerResultSchema.parse({
      output: boundedText(text).text,
      metadata,
      images: result.content.flatMap((x) => (x.type === "image" ? [{ mimeType: x.mimeType, data: x.data }] : [])),
    })
  }
}
