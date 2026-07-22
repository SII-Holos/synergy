export type MemoryCategory =
  | "user"
  | "self"
  | "relationship"
  | "interaction"
  | "workflow"
  | "coding"
  | "writing"
  | "asset"
  | "insight"
  | "knowledge"
  | "personal"
  | "general"

export const MEMORY_CATEGORIES: MemoryCategory[] = [
  "user",
  "self",
  "relationship",
  "interaction",
  "workflow",
  "coding",
  "writing",
  "asset",
  "insight",
  "knowledge",
  "personal",
  "general",
]

export const categoryColors: Record<MemoryCategory, string> = {
  user: "bg-chart-series-1/20 text-text-strong",
  self: "bg-chart-series-2/20 text-text-strong",
  relationship: "bg-chart-series-3/20 text-text-strong",
  interaction: "bg-chart-series-4/20 text-text-strong",
  workflow: "bg-chart-series-5/20 text-text-strong",
  coding: "bg-chart-series-6/20 text-text-strong",
  writing: "bg-chart-series-7/20 text-text-strong",
  asset: "bg-chart-series-8/20 text-text-strong",
  insight: "bg-chart-series-9/20 text-text-strong",
  knowledge: "bg-avatar-background-cyan text-text-strong",
  personal: "bg-avatar-background-lime text-text-strong",
  general: "bg-surface-inset-base text-text-weak",
}
