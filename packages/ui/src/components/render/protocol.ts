import { z } from "zod"
import { RenderArtifact } from "@ericsanchezok/synergy-util/render-artifact"

export type HostContext = {
  theme: Record<string, string>
  colorScheme: "light" | "dark"
  locale: string
  width: number
  reducedMotion: boolean
  viewMode: "inline" | "expanded" | "export"
  active: boolean
}
export type RuntimeConfig = {
  nonce: string
  version: string
  interactive: boolean
  offline: boolean
  revision: number
  state: RenderArtifact.Content
  context: HostContext
  labels: Record<string, string>
}
export const FrameMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("resize"), height: z.number().finite().min(0).max(32000) }).strict(),
  z.object({ type: z.literal("escape") }).strict(),
  z
    .object({ type: z.literal("flushed"), requestID: z.string().max(100), error: z.string().max(2000).optional() })
    .strict(),
  z.object({ type: z.literal("error"), message: z.string().max(2000) }).strict(),
  z
    .object({
      type: z.literal("state"),
      revision: z.number().int().nonnegative(),
      requestID: z.string().min(1).max(100),
      content: RenderArtifact.Content,
    })
    .strict(),
  z.object({ type: z.literal("followup"), ...RenderArtifact.FollowUp.shape }).strict(),
])
export type FrameMessage = z.infer<typeof FrameMessage>
export type Control = {
  id: string
  label: string
  type: "number" | "color" | "boolean" | "select"
  value: string | number | boolean
  min?: number
  max?: number
  step?: number
  options?: string[]
  group?: string
  variant?: string
}
export type ViewState = {
  controls: Record<string, Control["value"]>
  variant?: string
  forms?: Record<string, string | boolean>
  scroll?: number
  focus?: string
}
export type RenderRuntime = EventTarget & {
  ready: Promise<void>
  getState(): RenderArtifact.Content
  setState(content: RenderArtifact.Content): Promise<void>
  getHostContext(): HostContext
  requestFollowUp(text: string): Promise<unknown>
  controls(items: Control[], change: (values: Record<string, Control["value"]>) => void): void
  variants(items: Array<{ id: string; label: string; element: HTMLElement }>): void
  annotate(
    element: HTMLElement | SVGElement,
    options: {
      id: string
      label: string
      hitTest?: (x: number, y: number) => { id: string; label: string } | undefined
    },
  ): void
  calendar(
    element: HTMLElement,
    options: {
      events: Array<{ id: string; title: string; start: string; end?: string }>
      onSelect?: (id: string) => void
    },
  ): void
  icon(name: string): SVGElement
}
