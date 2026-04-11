import z from "zod"
import { Tool } from "./tool"

// ── Shared schemas ──

const NodeObject = z.object({
  label: z.string(),
  group: z.string().optional(),
  description: z.string().optional(),
  style: z.enum(["default", "primary", "dashed", "muted"]).optional(),
})

const DiagramNode = z.union([z.string(), NodeObject])

const EdgeObject = z.object({
  from: z.string(),
  to: z.string(),
  label: z.string().optional(),
})

const DiagramEdge = z.union([z.string(), EdgeObject])

const CompareCell = z.union([
  z.string(),
  z.object({
    value: z.string(),
    sentiment: z.enum(["positive", "negative", "neutral"]).optional(),
  }),
])

const SequenceStep = z.union([
  z.string(),
  z.object({
    from: z.string().optional(),
    to: z.string().optional(),
    action: z.string(),
    note: z.string().optional(),
    style: z.enum(["solid", "dashed", "highlight"]).optional(),
  }),
])

const TimelineEvent = z.union([
  z.string(),
  z.object({
    date: z.string(),
    title: z.string(),
    description: z.string().optional(),
    style: z.enum(["default", "primary", "muted"]).optional(),
  }),
])

type TreeNodeRaw = string | TreeNodeShape
interface TreeNodeShape {
  label: string
  description?: string
  style?: "default" | "primary" | "muted"
  children?: TreeNodeRaw[]
}

const TreeNodeInput: z.ZodType<TreeNodeRaw> = z.lazy(() =>
  z.union([
    z.string(),
    z.object({
      label: z.string(),
      description: z.string().optional(),
      style: z.enum(["default", "primary", "muted"]).optional(),
      children: z.array(TreeNodeInput).optional(),
    }),
  ]),
)

const ChartSeries = z.object({
  name: z.string(),
  values: z.array(z.number()),
})

const ChartSegment = z.object({
  label: z.string(),
  value: z.number(),
})

// ── Variant inputs ──

const GraphInput = z.object({
  type: z.literal("graph"),
  title: z.string(),
  nodes: z.array(DiagramNode),
  edges: z.array(DiagramEdge).optional(),
  direction: z.enum(["TB", "LR"]).optional(),
})

const CompareInput = z.object({
  type: z.literal("compare"),
  title: z.string(),
  headers: z.array(z.string()),
  rows: z.array(z.array(CompareCell)),
  caption: z.string().optional(),
})

const SequenceInput = z.object({
  type: z.literal("sequence"),
  title: z.string(),
  actors: z.array(z.string()).optional(),
  steps: z.array(SequenceStep),
})

const TimelineInput = z.object({
  type: z.literal("timeline"),
  title: z.string(),
  events: z.array(TimelineEvent),
})

const TreeInput = z.object({
  type: z.literal("tree"),
  title: z.string(),
  root: TreeNodeInput,
})

const ChartInput = z.object({
  type: z.literal("chart"),
  title: z.string(),
  variant: z.enum(["bar", "line", "pie"]),
  labels: z.array(z.string()).optional(),
  series: z.array(ChartSeries).optional(),
  segments: z.array(ChartSegment).optional(),
})

const VariantInput = z.discriminatedUnion("type", [
  GraphInput,
  CompareInput,
  SequenceInput,
  TimelineInput,
  TreeInput,
  ChartInput,
])

const parameters = z
  .object({
    type: z.enum(["graph", "compare", "sequence", "timeline", "tree", "chart"]),
    title: z.string(),
    nodes: z.array(DiagramNode).optional(),
    edges: z.array(DiagramEdge).optional(),
    direction: z.enum(["TB", "LR"]).optional(),
    headers: z.array(z.string()).optional(),
    rows: z.array(z.array(CompareCell)).optional(),
    caption: z.string().optional(),
    actors: z.array(z.string()).optional(),
    steps: z.array(SequenceStep).optional(),
    events: z.array(TimelineEvent).optional(),
    root: TreeNodeInput.optional(),
    variant: z.enum(["bar", "line", "pie"]).optional(),
    labels: z.array(z.string()).optional(),
    series: z.array(ChartSeries).optional(),
    segments: z.array(ChartSegment).optional(),
  })
  .superRefine((input, ctx) => {
    const result = VariantInput.safeParse(input)
    if (result.success) return
    for (const issue of result.error.issues) {
      ctx.addIssue({
        code: "custom",
        path: issue.path,
        message: issue.message,
      })
    }
  })

// ── Namespace ──

export namespace Diagram {
  export type Input = z.infer<typeof VariantInput>

  export interface NormalizedNode {
    label: string
    group?: string
    description?: string
    style?: string
  }

  export interface NormalizedEdge {
    from: string
    to: string
    label?: string
  }

  export interface NormalizedCell {
    value: string
    sentiment?: string
  }

  export interface NormalizedStep {
    from?: string
    to?: string
    action: string
    note?: string
    style?: string
  }

  export interface NormalizedEvent {
    date: string
    title: string
    description?: string
    style?: string
  }

  export interface NormalizedTreeNode {
    label: string
    description?: string
    style?: string
    children: NormalizedTreeNode[]
  }

  export interface NormalizedSeries {
    name: string
    values: number[]
  }

  export interface NormalizedSegment {
    label: string
    value: number
  }

  export interface GraphDocument {
    type: "graph"
    title: string
    direction?: string
    nodes: NormalizedNode[]
    edges: NormalizedEdge[]
  }

  export interface CompareDocument {
    type: "compare"
    title: string
    headers: string[]
    rows: NormalizedCell[][]
    caption?: string
  }

  export interface SequenceDocument {
    type: "sequence"
    title: string
    actors: string[]
    steps: NormalizedStep[]
  }

  export interface TimelineDocument {
    type: "timeline"
    title: string
    events: NormalizedEvent[]
  }

  export interface TreeDocument {
    type: "tree"
    title: string
    root: NormalizedTreeNode
  }

  export interface ChartDocument {
    type: "chart"
    title: string
    variant: "bar" | "line" | "pie"
    labels: string[]
    series: NormalizedSeries[]
    segments: NormalizedSegment[]
  }

  export type Document =
    | GraphDocument
    | CompareDocument
    | SequenceDocument
    | TimelineDocument
    | TreeDocument
    | ChartDocument

  // ── Normalization helpers ──

  const EDGE_RE = /^(.+?)\s*->\s*(.+?)(?:\s*:\s*(.+))?$/

  export function normalizeNode(raw: z.infer<typeof DiagramNode>): NormalizedNode {
    if (typeof raw === "string") return { label: raw }
    return { label: raw.label, group: raw.group, description: raw.description, style: raw.style }
  }

  export function normalizeEdge(raw: z.infer<typeof DiagramEdge>): NormalizedEdge | undefined {
    if (typeof raw === "string") {
      const m = raw.match(EDGE_RE)
      if (!m) return undefined
      return { from: m[1].trim(), to: m[2].trim(), label: m[3]?.trim() }
    }
    return { from: raw.from, to: raw.to, label: raw.label }
  }

  export function normalizeCell(raw: z.infer<typeof CompareCell>): NormalizedCell {
    if (typeof raw === "string") return { value: raw }
    return { value: raw.value, sentiment: raw.sentiment }
  }

  export function normalizeStep(raw: z.infer<typeof SequenceStep>): NormalizedStep {
    if (typeof raw === "string") return { action: raw }
    return { from: raw.from, to: raw.to, action: raw.action, note: raw.note, style: raw.style }
  }

  export function normalizeEvent(raw: z.infer<typeof TimelineEvent>): NormalizedEvent {
    if (typeof raw === "string") return { date: "", title: raw }
    return { date: raw.date, title: raw.title, description: raw.description, style: raw.style }
  }

  export function normalizeTreeNode(raw: z.infer<typeof TreeNodeInput>): NormalizedTreeNode {
    if (typeof raw === "string") return { label: raw, children: [] }
    return {
      label: raw.label,
      description: raw.description,
      style: raw.style,
      children: (raw.children ?? []).map(normalizeTreeNode),
    }
  }

  // ── Parse + normalize ──

  export function parse(input: z.infer<typeof parameters>): Input {
    switch (input.type) {
      case "graph":
        return {
          type: "graph",
          title: input.title,
          nodes: input.nodes!,
          edges: input.edges,
          direction: input.direction,
        }
      case "compare":
        return {
          type: "compare",
          title: input.title,
          headers: input.headers!,
          rows: input.rows!,
          caption: input.caption,
        }
      case "sequence":
        return { type: "sequence", title: input.title, actors: input.actors, steps: input.steps! }
      case "timeline":
        return { type: "timeline", title: input.title, events: input.events! }
      case "tree":
        return { type: "tree", title: input.title, root: input.root! }
      case "chart":
        return {
          type: "chart",
          title: input.title,
          variant: input.variant!,
          labels: input.labels,
          series: input.series,
          segments: input.segments,
        }
    }
  }

  export function normalize(input: Input): Document {
    switch (input.type) {
      case "graph": {
        const nodes = input.nodes.map(normalizeNode)
        const edges = (input.edges ?? []).map(normalizeEdge).filter((e): e is NormalizedEdge => !!e)
        return { type: "graph", title: input.title, direction: input.direction, nodes, edges }
      }
      case "compare": {
        const rows = input.rows.map((row) => row.map(normalizeCell))
        return { type: "compare", title: input.title, headers: input.headers, rows, caption: input.caption }
      }
      case "sequence": {
        const steps = input.steps.map(normalizeStep)
        const actors = input.actors ?? extractActors(steps)
        return { type: "sequence", title: input.title, actors, steps }
      }
      case "timeline": {
        const events = input.events.map(normalizeEvent)
        return { type: "timeline", title: input.title, events }
      }
      case "tree": {
        const root = normalizeTreeNode(input.root)
        return { type: "tree", title: input.title, root }
      }
      case "chart": {
        const labels = input.labels ?? []
        const series = input.series ?? []
        const segments = input.segments ?? []
        return { type: "chart", title: input.title, variant: input.variant, labels, series, segments }
      }
    }
  }

  function extractActors(steps: NormalizedStep[]): string[] {
    const seen = new Set<string>()
    const result: string[] = []
    for (const step of steps) {
      for (const actor of [step.from, step.to]) {
        if (actor && !seen.has(actor)) {
          seen.add(actor)
          result.push(actor)
        }
      }
    }
    return result
  }

  function countTreeNodes(node: NormalizedTreeNode): number {
    return 1 + node.children.reduce((sum, child) => sum + countTreeNodes(child), 0)
  }

  function treeDepth(node: NormalizedTreeNode): number {
    if (node.children.length === 0) return 1
    return 1 + Math.max(...node.children.map(treeDepth))
  }

  // ── Summarize ──

  export function summarize(doc: Document): string {
    switch (doc.type) {
      case "graph": {
        const lines = [`Graph diagram: "${doc.title}"`, `Nodes: ${doc.nodes.map((n) => n.label).join(", ")}`]
        if (doc.edges.length > 0) {
          const shown = doc.edges.slice(0, 5).map((e) => `${e.from} → ${e.to}`)
          lines.push(
            `Connections: ${shown.join(", ")}${doc.edges.length > 5 ? ` … and ${doc.edges.length - 5} more` : ""}`,
          )
        }
        return lines.join("\n")
      }
      case "compare": {
        const items = doc.headers.slice(1)
        return `Comparison: "${doc.title}"\nComparing: ${items.join(", ")}\nDimensions: ${doc.rows.length}`
      }
      case "sequence": {
        const lines = [`Sequence diagram: "${doc.title}"`]
        if (doc.actors.length > 0) lines.push(`Actors: ${doc.actors.join(", ")}`)
        lines.push(`Steps: ${doc.steps.length}`)
        return lines.join("\n")
      }
      case "timeline": {
        const dates = doc.events.map((e) => e.date || e.title)
        return `Timeline: "${doc.title}"\nEvents: ${dates.join(" → ")}`
      }
      case "tree": {
        const total = countTreeNodes(doc.root)
        const depth = treeDepth(doc.root)
        return `Tree: "${doc.title}"\nRoot: ${doc.root.label}\nNodes: ${total}, Depth: ${depth}`
      }
      case "chart": {
        if (doc.variant === "pie") {
          const labels = doc.segments.map((s) => s.label)
          return `Pie chart: "${doc.title}"\nSegments: ${labels.join(", ")}`
        }
        const names = doc.series.map((s) => s.name)
        return `${doc.variant === "bar" ? "Bar" : "Line"} chart: "${doc.title}"\nLabels: ${doc.labels.join(", ")}\nSeries: ${names.join(", ")}`
      }
    }
  }

  // ── Stats for metadata ──

  export function stats(doc: Document): Record<string, number> {
    switch (doc.type) {
      case "graph":
        return { nodes: doc.nodes.length, edges: doc.edges.length }
      case "compare":
        return { items: doc.headers.length - 1, dimensions: doc.rows.length }
      case "sequence":
        return { steps: doc.steps.length, actors: doc.actors.length }
      case "timeline":
        return { events: doc.events.length }
      case "tree":
        return { nodes: countTreeNodes(doc.root), depth: treeDepth(doc.root) }
      case "chart":
        if (doc.variant === "pie") return { segments: doc.segments.length }
        return { labels: doc.labels.length, series: doc.series.length }
    }
  }
}

const DESCRIPTION = `Render a visual diagram inline in the conversation. Use this when the information has spatial relationships, comparisons, or sequential steps that would be clearer as a visual than as text.

Six types:
- "graph": entities and their relationships (architecture, flow, dependencies, state machines)
- "compare": items evaluated across dimensions (tradeoffs, feature matrices, evaluations)
- "sequence": ordered events between multiple actors (protocols, request flows, lifecycles)
- "timeline": chronological events along a time axis (version history, roadmaps, milestones)
- "tree": hierarchical structures (taxonomies, org charts, file trees, concept breakdowns)
- "chart": data visualization with variant "bar", "line", or "pie" (benchmarks, trends, distributions)

Keep diagrams focused: 3-12 nodes for graphs, 2-5 items for comparisons, 3-10 steps for sequences, 3-12 events for timelines, depth ≤ 4 for trees, 2-8 data points for charts.

Nodes and edges can be simple strings for quick diagrams. Edges accept "A -> B" or "A -> B: label" string format.
No visual styling needed — the renderer handles layout and aesthetics.`

export const DiagramTool = Tool.define<typeof parameters, { render: string; document: Diagram.Document }>("diagram", {
  description: DESCRIPTION,
  parameters,
  async execute(input) {
    const doc = Diagram.normalize(Diagram.parse(input))
    const output = Diagram.summarize(doc)

    return {
      title: input.title,
      output,
      metadata: {
        render: "diagram",
        document: doc,
        stats: Diagram.stats(doc),
        truncated: true,
      },
    }
  },
})
