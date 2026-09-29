import { createHash } from "node:crypto"
import { z } from "zod"
import type { ComputerObservation, ComputerResult } from "@ericsanchezok/synergy-computer-protocol"

const Guard = z.object({
  token: z.string().min(1).max(200).optional(),
  image_status: z.enum(["valid", "unavailable", "unverified", "invalid"]),
  reason: z.string().max(200).optional(),
  source: z.string().max(100).optional(),
  width: z.number().int().positive().max(2048).optional(),
  height: z.number().int().positive().max(2048).optional(),
  sha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
})
const Element = z.object({ element_index: z.number().int().nonnegative() })
export const COMPUTER_TEXT_BYTES = 32 * 1024

export function boundedText(text: string, budget = COMPUTER_TEXT_BYTES) {
  if (Buffer.byteLength(text) <= budget) return { text, truncated: false }
  const footer = "\nContent truncated. Observe with query to narrow the accessibility results."
  const lines: string[] = []
  let size = Buffer.byteLength(footer)
  for (const line of text.split("\n")) {
    const bytes = Buffer.byteLength(line) + 1
    if (size + bytes > budget) break
    lines.push(line)
    size += bytes
  }
  return { text: lines.join("\n") + footer, truncated: true }
}

export function describeObservation(input: {
  id: string
  pid: number
  windowId: number
  query?: string
  capturedAt: number
  result: ComputerResult
}) {
  const { result } = input
  const metadata = result.metadata
  const parsed = Guard.safeParse(metadata.synergy)
  const guard = parsed.success ? parsed.data : undefined
  const snapshotId =
    typeof metadata.snapshot_id === "string" && /^s[0-9a-f]{8}$/.test(metadata.snapshot_id)
      ? metadata.snapshot_id
      : undefined
  const elements = z.array(Element).safeParse(metadata.elements)
  const indices = elements.success ? elements.data.map((x) => x.element_index) : []
  const tree = typeof metadata.tree_markdown === "string" ? metadata.tree_markdown : ""
  const axAvailable = !!snapshotId && (tree.length > 0 || indices.length > 0)
  const image = result.images[0]
  const validImage =
    !!image &&
    guard?.image_status === "valid" &&
    !!guard.width &&
    !!guard.height &&
    !!guard.sha256 &&
    createHash("sha256").update(Buffer.from(image.data, "base64")).digest("hex") === guard.sha256 &&
    typeof metadata.capture_id === "string" &&
    metadata.screenshot_frame_valid !== false
  const imageStatus = validImage
    ? "valid"
    : guard?.image_status === "valid"
      ? "invalid"
      : (guard?.image_status ?? "unverified")
  const imageReason = validImage
    ? undefined
    : (guard?.reason ?? (image ? "capture_proof_missing" : "capture_unavailable"))
  const action = (enabled: boolean, reason: string) =>
    !guard?.token
      ? { available: false, reason: "target_unverified" }
      : enabled
        ? { available: true }
        : { available: false, reason }
  const observation: ComputerObservation = {
    version: 2,
    id: input.id,
    target: {
      pid: input.pid,
      windowId: input.windowId,
      app: typeof metadata.app_name === "string" ? metadata.app_name.slice(0, 500) : "",
      title: typeof metadata.window_title === "string" ? metadata.window_title.slice(0, 2000) : "",
    },
    capturedAt: input.capturedAt,
    expiresAt: input.capturedAt + 60_000,
    ax: {
      status: !axAvailable ? "unavailable" : metadata.elements_complete === true ? "available" : "partial",
      truncated: metadata.truncated === true || metadata.timed_out === true,
      ...(!axAvailable ? { reason: "accessibility_unavailable" } : {}),
      ...(input.query ? { query: input.query } : {}),
    },
    image: {
      status: imageStatus,
      reason: imageReason,
      ...(validImage ? { width: guard.width, height: guard.height, sha256: guard.sha256, source: guard.source } : {}),
    },
    actions: {
      click: action(indices.length > 0 || validImage, "target_unavailable"),
      type: action(indices.length > 0 || validImage, "target_unavailable"),
      key: action(true, "target_unverified"),
      scroll: action(true, "target_unverified"),
      drag: action(validImage, imageReason ?? "capture_unavailable"),
      set_value: action(indices.length > 0, "accessibility_unavailable"),
    },
  }
  const actions = Object.entries(observation.actions)
    .map(([name, state]) => `${name}: ${state.available ? "available" : state.reason}`)
    .join("; ")
  const header = [
    `Window ${input.pid}/${input.windowId}: ${observation.target.app} — ${observation.target.title}`,
    `Observation ${input.id} (one action, 60 seconds).`,
    `AX: ${observation.ax.status}${input.query ? `; query=${JSON.stringify(input.query)}` : ""}. Image: ${imageStatus}${imageReason ? ` (${imageReason})` : `; ${guard?.width}×${guard?.height} pixels`}.`,
    actions,
    ...(observation.ax.status === "partial"
      ? ["AX results may be incomplete; missing text does not establish absence."]
      : []),
    ...(validImage ? ["Coordinates are pixels in this image."] : []),
    ...(imageStatus !== "valid"
      ? ["If an image is needed, observe with foreground:true to bring this window forward and capture again."]
      : []),
  ].join("\n")
  const output = boundedText(header + (tree ? `\n${tree}` : ""))
  observation.ax.truncated ||= output.truncated
  return {
    observation,
    output: output.text,
    images: validImage ? [image] : [],
    snapshotId,
    captureId: validImage ? String(metadata.capture_id) : undefined,
    token: guard?.token,
    indices,
  }
}
