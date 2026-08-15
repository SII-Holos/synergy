import { describe, expect, test } from "bun:test"
import { Diagram } from "../../src/tool/diagram"

function graphDoc(extra: Record<string, unknown>) {
  return Diagram.normalize(Diagram.parse({ type: "graph", title: "G", ...extra } as never)) as Diagram.GraphDocument
}

function compareDoc(extra: Record<string, unknown>) {
  return Diagram.normalize(Diagram.parse({ type: "compare", title: "C", ...extra } as never)) as Diagram.CompareDocument
}

function sequenceDoc(extra: Record<string, unknown>) {
  return Diagram.normalize(
    Diagram.parse({ type: "sequence", title: "S", ...extra } as never),
  ) as Diagram.SequenceDocument
}

function timelineDoc(extra: Record<string, unknown>) {
  return Diagram.normalize(
    Diagram.parse({ type: "timeline", title: "T", ...extra } as never),
  ) as Diagram.TimelineDocument
}

function treeDoc(extra: Record<string, unknown>) {
  return Diagram.normalize(Diagram.parse({ type: "tree", title: "R", ...extra } as never)) as Diagram.TreeDocument
}

function chartDoc(extra: Record<string, unknown>) {
  return Diagram.normalize(Diagram.parse({ type: "chart", title: "H", ...extra } as never)) as Diagram.ChartDocument
}

describe("diagram normalization", () => {
  test("parses and normalizes graph documents with string and object nodes", () => {
    const doc = Diagram.normalize(
      Diagram.parse({
        type: "graph",
        title: "Architecture",
        nodes: ["web", { label: "db", style: "primary" }],
        edges: ["web -> db", "web -> cache: reads", { from: "db", to: "cache" }],
        direction: "LR",
      }),
    )
    expect(doc).toEqual({
      type: "graph",
      title: "Architecture",
      direction: "LR",
      nodes: [{ label: "web" }, { label: "db", style: "primary" }],
      edges: [
        { from: "web", to: "db" },
        { from: "web", to: "cache", label: "reads" },
        { from: "db", to: "cache" },
      ],
    })
  })

  test("drops malformed string edges", () => {
    const doc = graphDoc({ nodes: ["a"], edges: ["no arrow here"] })
    expect(doc.edges).toEqual([])
  })

  test("normalizes compare documents with string and object cells", () => {
    const doc = compareDoc({
      headers: ["Option", "Speed", "Cost"],
      rows: [
        ["A", "fast", { value: "low", sentiment: "positive" }],
        [{ value: "B", sentiment: "neutral" }, "slow", "high"],
      ],
    })
    expect(doc.rows).toEqual([
      [{ value: "A" }, { value: "fast" }, { value: "low", sentiment: "positive" }],
      [{ value: "B", sentiment: "neutral" }, { value: "slow" }, { value: "high" }],
    ])
  })

  test("derives sequence actors from steps when omitted", () => {
    const doc = sequenceDoc({
      steps: ["greet", { from: "client", to: "server", action: "request", note: "tls" }],
    })
    expect(doc.actors).toEqual(["client", "server"])
    expect(doc.steps).toEqual([{ action: "greet" }, { from: "client", to: "server", action: "request", note: "tls" }])
  })

  test("keeps explicit sequence actors", () => {
    const doc = sequenceDoc({ actors: ["alpha"], steps: [{ action: "go", from: "x", to: "y" }] })
    expect(doc.actors).toEqual(["alpha"])
  })

  test("normalizes timeline string events to empty dates", () => {
    const doc = timelineDoc({
      events: ["release", { date: "2026-01", title: "beta", description: "first" }],
    })
    expect(doc.events).toEqual([
      { date: "", title: "release" },
      { date: "2026-01", title: "beta", description: "first" },
    ])
  })

  test("normalizes nested tree nodes", () => {
    const doc = treeDoc({ root: { label: "root", children: ["leaf", { label: "mid", children: ["deep"] }] } })
    expect(doc.root).toEqual({
      label: "root",
      children: [
        { label: "leaf", children: [] },
        { label: "mid", children: [{ label: "deep", children: [] }] },
      ],
    })
  })

  test("normalizes chart documents with empty optional collections", () => {
    const doc = chartDoc({
      variant: "bar",
      labels: ["a", "b"],
      series: [{ name: "s1", values: [1, 2] }],
    })
    expect(doc).toEqual({
      type: "chart",
      title: "H",
      variant: "bar",
      labels: ["a", "b"],
      series: [{ name: "s1", values: [1, 2] }],
      segments: [],
    })
  })

  test("accepts string tree roots", () => {
    const doc = treeDoc({ root: "leaf" })
    expect(doc.root).toEqual({ label: "leaf", children: [] })
  })
})

describe("diagram summaries and stats", () => {
  test("graph summary lists nodes and truncates connections beyond five", () => {
    const graph = graphDoc({ nodes: ["a", "b"], edges: ["a -> b"] })
    expect(Diagram.summarize(graph)).toContain("Nodes: a, b")
    expect(Diagram.summarize(graph)).toContain("Connections: a → b")

    const large = graphDoc({
      nodes: ["a", "b", "c", "d", "e", "f", "g"],
      edges: ["a -> b", "a -> c", "a -> d", "a -> e", "a -> f", "a -> g"],
    })
    expect(Diagram.summarize(large)).toContain("… and 1 more")
  })

  test("compare summary counts items and dimensions", () => {
    const compare = compareDoc({ headers: ["H", "A", "B"], rows: [["1", "2", "3"]] })
    expect(Diagram.summarize(compare)).toContain("Comparing: A, B")
    expect(Diagram.summarize(compare)).toContain("Dimensions: 1")
  })

  test("sequence summary lists actors and step count", () => {
    const sequence = sequenceDoc({ steps: ["one", "two"], actors: ["x"] })
    expect(Diagram.summarize(sequence)).toContain("Actors: x")
    expect(Diagram.summarize(sequence)).toContain("Steps: 2")
  })

  test("timeline summary joins events with arrows", () => {
    const timeline = timelineDoc({ events: ["first", { date: "2026", title: "second" }] })
    expect(Diagram.summarize(timeline)).toContain("Events: first → 2026")
  })

  test("tree summary counts nodes and depth", () => {
    const tree = treeDoc({ root: { label: "r", children: ["a", { label: "b", children: ["c"] }] } })
    expect(Diagram.summarize(tree)).toContain("Root: r")
    expect(Diagram.summarize(tree)).toContain("Nodes: 4, Depth: 3")
  })

  test("pie chart summary uses segments while bar and line use series", () => {
    const pie = chartDoc({ variant: "pie", segments: [{ label: "a", value: 1 }] })
    expect(Diagram.summarize(pie)).toContain("Pie chart")
    expect(Diagram.summarize(pie)).toContain("Segments: a")

    const bar = chartDoc({ variant: "bar", labels: ["l"], series: [{ name: "s", values: [1] }] })
    expect(Diagram.summarize(bar)).toContain("Bar chart")
    expect(Diagram.summarize(bar)).toContain("Series: s")

    const line = chartDoc({ variant: "line", labels: [], series: [] })
    expect(Diagram.summarize(line)).toContain("Line chart")
  })

  test("stats mirrors the document shape", () => {
    expect(Diagram.stats(graphDoc({ nodes: ["a", "b"], edges: ["a -> b"] }))).toEqual({ nodes: 2, edges: 1 })
    expect(Diagram.stats(compareDoc({ headers: ["A", "B", "C"], rows: [["x", "y", "z"]] }))).toEqual({
      items: 2,
      dimensions: 1,
    })
    expect(Diagram.stats(sequenceDoc({ steps: ["a"], actors: ["x", "y"] }))).toEqual({ steps: 1, actors: 2 })
    expect(Diagram.stats(timelineDoc({ events: ["a", "b"] }))).toEqual({ events: 2 })
    expect(Diagram.stats(chartDoc({ variant: "pie", segments: [{ label: "a", value: 1 }] }))).toEqual({
      segments: 1,
    })
    expect(Diagram.stats(chartDoc({ variant: "bar", labels: ["a"], series: [] }))).toEqual({ labels: 1, series: 0 })
  })

  test("normalizeEdge rejects strings without an arrow", () => {
    expect(Diagram.normalizeEdge("just text")).toBeUndefined()
    expect(Diagram.normalizeEdge({ from: "a", to: "b" })).toEqual({ from: "a", to: "b" })
  })

  test("normalize helpers handle object forms", () => {
    expect(Diagram.normalizeNode({ label: "n", group: "g", description: "d", style: "muted" })).toEqual({
      label: "n",
      group: "g",
      description: "d",
      style: "muted",
    })
    expect(Diagram.normalizeCell({ value: "v", sentiment: "negative" })).toEqual({
      value: "v",
      sentiment: "negative",
    })
    expect(Diagram.normalizeStep({ from: "a", to: "b", action: "go", note: "n", style: "dashed" })).toEqual({
      from: "a",
      to: "b",
      action: "go",
      note: "n",
      style: "dashed",
    })
    expect(Diagram.normalizeEvent({ date: "d", title: "t", description: "x", style: "primary" })).toEqual({
      date: "d",
      title: "t",
      description: "x",
      style: "primary",
    })
    expect(Diagram.normalizeTreeNode({ label: "p", description: "d", style: "muted", children: ["c"] })).toEqual({
      label: "p",
      description: "d",
      style: "muted",
      children: [{ label: "c", children: [] }],
    })
  })
})
