import type { Nature, NatureTool } from "./model"

export type NatureCommand =
  | { type: "init"; generation: number; state: Nature }
  | { type: "active"; generation: number; value: boolean }
  | { type: "paint"; generation: number; tool: NatureTool; x: number; y: number }
  | { type: "settings"; generation: number; wind: number; lowGravity: boolean }
  | { type: "step"; generation: number }
  | { type: "ack"; generation: number }

export type NatureFrame = { type: "frame"; generation: number; state: Nature }
