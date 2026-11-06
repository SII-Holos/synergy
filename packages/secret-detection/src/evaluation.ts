import { z } from "zod"
import { SecretDetection } from "./detector.js"

export namespace SecretEvaluation {
  const Span = SecretDetection.Finding.pick({ start: true, end: true })
  export const Case = z.object({
    id: z.string().min(1),
    group: z.string().min(1),
    text: z.string(),
    source: SecretDetection.Source,
    expected: z.array(Span),
  })
  export type Case = z.infer<typeof Case>
  export const Dataset = z.object({ version: z.string().min(1), cases: z.array(Case).min(1) })
  export type Dataset = z.infer<typeof Dataset>

  interface Counts {
    expected: number
    predicted: number
    exactMatches: number
    fullyCovered: number
    falsePositives: number
    cleanCases: number
    completedCleanCases: number
    falsePositiveCases: number
    failures: number
    incomplete: number
  }
  function counts(): Counts {
    return {
      expected: 0,
      predicted: 0,
      exactMatches: 0,
      fullyCovered: 0,
      falsePositives: 0,
      cleanCases: 0,
      completedCleanCases: 0,
      falsePositiveCases: 0,
      failures: 0,
      incomplete: 0,
    }
  }
  function metrics(count: Counts) {
    const ratio = (a: number, b: number) => (b ? a / b : null)
    return {
      ...count,
      exactPrecision: ratio(count.exactMatches, count.predicted),
      exactRecall: ratio(count.exactMatches, count.expected),
      fullCoverageRecall: ratio(count.fullyCovered, count.expected),
      cleanMessageFalsePositiveRate: ratio(count.falsePositiveCases, count.completedCleanCases),
    }
  }

  export async function evaluate(
    detector: SecretDetection.Detector,
    cases: Case[],
    options: { timeoutMs?: number } = {},
  ) {
    const total = counts()
    const groups = new Map<string, Counts>()
    const rows: Array<
      {
        id: string
        group: string
        status: "complete" | "incomplete" | "failed"
        error?: string
        durationMs: number
      } & Counts
    > = []
    const ids = new Set<string>()
    for (const sample of cases) {
      Case.parse(sample)
      if (ids.has(sample.id)) throw new Error("Duplicate evaluation case id")
      ids.add(sample.id)
      SecretDetection.validate(sample.text, {
        complete: true,
        findings: sample.expected.map((span) => ({ ...span, kind: "label" })),
      })
    }
    for (const sample of cases) {
      const count = counts()
      count.expected = sample.expected.length
      count.cleanCases = sample.expected.length === 0 ? 1 : 0
      const start = performance.now()
      let status: "complete" | "incomplete" | "failed" = "complete"
      let error: string | undefined
      try {
        const result = await SecretDetection.detect(detector, sample, options)
        if (!result.complete) {
          status = "incomplete"
          count.incomplete = 1
        }
        count.predicted = result.findings.length
        count.exactMatches = sample.expected.filter((label) =>
          result.findings.some((f) => f.start === label.start && f.end === label.end),
        ).length
        count.fullyCovered = sample.expected.filter((label) =>
          result.findings.some((f) => f.start <= label.start && f.end >= label.end),
        ).length
        count.falsePositives = result.findings.filter(
          (f) => !sample.expected.some((label) => f.start < label.end && f.end > label.start),
        ).length
        count.completedCleanCases = result.complete ? count.cleanCases : 0
        count.falsePositiveCases = count.completedCleanCases && count.predicted > 0 ? 1 : 0
      } catch (failure) {
        status = "failed"
        count.failures = 1
        error = failure instanceof SecretDetection.Error ? failure.code : "detector_failed"
      }
      const durationMs = performance.now() - start
      const group = groups.get(sample.group) ?? counts()
      groups.set(sample.group, group)
      for (const key of Object.keys(count) as Array<keyof Counts>) {
        total[key] += count[key]
        group[key] += count[key]
      }
      rows.push({ id: sample.id, group: sample.group, status, ...(error ? { error } : {}), durationMs, ...count })
    }
    return {
      detector: { id: detector.id, version: detector.version },
      metrics: metrics(total),
      groups: Object.fromEntries([...groups].map(([key, count]) => [key, metrics(count)])),
      cases: rows,
    }
  }

  export async function benchmark(
    detector: SecretDetection.Detector,
    input: SecretDetection.Input,
    options: { samples: number; warmup: number; timeoutMs?: number },
  ) {
    if (
      !Number.isInteger(options.samples) ||
      options.samples < 1 ||
      !Number.isInteger(options.warmup) ||
      options.warmup < 0
    )
      throw new RangeError("Invalid benchmark sample count")
    const start = performance.now()
    const first = await SecretDetection.detect(detector, input, options)
    const firstCallMs = performance.now() - start
    if (!first.complete) throw new SecretDetection.Error("incomplete")
    for (let i = 0; i < options.warmup; i++) {
      const result = await SecretDetection.detect(detector, input, options)
      if (!result.complete) throw new SecretDetection.Error("incomplete")
    }
    const elapsed: number[] = []
    for (let i = 0; i < options.samples; i++) {
      const begin = performance.now()
      const result = await SecretDetection.detect(detector, input, options)
      elapsed.push(performance.now() - begin)
      if (!result.complete) throw new SecretDetection.Error("incomplete")
    }
    elapsed.sort((a, b) => a - b)
    const durationMs = elapsed.reduce((a, b) => a + b, 0)
    return {
      samples: options.samples,
      warmup: options.warmup,
      firstCallMs,
      p50Ms: elapsed[Math.ceil(elapsed.length * 0.5) - 1],
      p95Ms: elapsed[Math.ceil(elapsed.length * 0.95) - 1],
      durationMs,
      callsPerSecond: durationMs > 0 ? (options.samples * 1000) / durationMs : null,
    }
  }
}
