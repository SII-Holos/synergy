import { z } from "zod"
import type { Run } from "./cross-os-transport"

const HTTPFacts = z.strictObject({
  code: z.enum([
    "OK",
    "HTTP_STATUS",
    "INVALID_BODY",
    "BODY_LIMIT",
    "WRONG_RUN",
    "WRONG_NATIVE",
    "ENOTFOUND",
    "EAI_AGAIN",
    "ECONNREFUSED",
    "ECONNRESET",
    "ETIMEDOUT",
    "ABORT_ERR",
    "OTHER",
  ]),
  headersReceived: z.boolean(),
  status: z.number().int().min(100).max(599).optional(),
  bodyBytes: z.number().int().min(0).max(8193),
  runMatches: z.boolean(),
  nativeMatches: z.boolean(),
  elapsedMs: z.number().finite().nonnegative(),
})
type HTTPFacts = z.infer<typeof HTTPFacts>
const BunFacts = z.strictObject({
  http: HTTPFacts,
  context: z.strictObject({ libinfoFlag: z.enum(["unset", "falsy", "truthy"]), pinnedBun: z.boolean() }),
})
type Input = { url: string; run: Run; deadline: number }

// Provenance: https://github.com/oven-sh/bun/blob/c6da4a4d3010e5553438c60f6bd76d981976867c/src/bun_core/env_var.rs#L424-L430
export function crossOSLibinfoFlag(value: string | undefined): "unset" | "falsy" | "truthy" {
  if (value === undefined) return "unset"
  const lower = value.replace(/[A-Z]/g, (letter) => String.fromCharCode(letter.charCodeAt(0) + 32))
  return ["", "0", "false", "no", "off"].includes(lower) ? "falsy" : "truthy"
}
function pinnedCrossOSBun() {
  return Bun.version === "1.4.3" && Bun.revision === "c6da4a4d3010e5553438c60f6bd76d981976867c"
}

// This self-contained function also runs under the fresh minimal Bun CLI context.
export async function observeCrossOSFailureHTTP(input: Input, request: typeof fetch = fetch): Promise<HTTPFacts> {
  const started = performance.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Math.max(0, input.deadline - Date.now()))
  const facts: HTTPFacts = {
    code: "OTHER",
    headersReceived: false,
    bodyBytes: 0,
    runMatches: false,
    nativeMatches: false,
    elapsedMs: 0,
  }
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  let eof = false
  try {
    if (Date.now() >= input.deadline) return { ...facts, code: "ABORT_ERR", elapsedMs: performance.now() - started }
    const response = await request(input.url, { signal: controller.signal })
    facts.headersReceived = true
    facts.status = response.status
    reader = response.body?.getReader()
    const chunks: Uint8Array[] = []
    while (reader) {
      const next = await reader.read()
      if (next.done) {
        eof = true
        break
      }
      facts.bodyBytes = Math.min(8193, facts.bodyBytes + next.value.byteLength)
      if (facts.bodyBytes > 8192) {
        facts.code = "BODY_LIMIT"
        return facts
      }
      chunks.push(next.value)
    }
    if (!response.ok) {
      facts.code = "HTTP_STATUS"
      return facts
    }
    const bytes = new Uint8Array(facts.bodyBytes)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    let body: { run?: Record<string, unknown>; native?: unknown } | null
    try {
      body = JSON.parse(new TextDecoder().decode(bytes))
    } catch {
      facts.code = "INVALID_BODY"
      return facts
    }
    const foundRun = typeof body?.run === "object" && body.run !== null ? body.run : undefined
    facts.nativeMatches = body?.native === "darwin"
    facts.runMatches =
      foundRun !== undefined &&
      Object.keys(foundRun).sort().join(",") === "attempt,id,repository,sha" &&
      ["repository", "id", "attempt", "sha"].every((key) => foundRun[key] === input.run[key as keyof Run])
    facts.code = !facts.runMatches ? "WRONG_RUN" : !facts.nativeMatches ? "WRONG_NATIVE" : "OK"
  } catch (error) {
    facts.code = controller.signal.aborted ? "ABORT_ERR" : "OTHER"
    if (!controller.signal.aborted) {
      let current: unknown = error
      for (let depth = 0; depth < 3; depth++) {
        try {
          if (typeof current !== "object" || current === null) break
          const code = Object.getOwnPropertyDescriptor(current, "code")
          if (
            code &&
            "value" in code &&
            ["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ABORT_ERR"].includes(code.value)
          ) {
            facts.code = code.value
            break
          }
          const cause = Object.getOwnPropertyDescriptor(current, "cause")
          current = cause && "value" in cause ? cause.value : undefined
        } catch {
          break
        }
      }
    }
  } finally {
    clearTimeout(timer)
    try {
      if (!eof) await reader?.cancel()
    } catch {}
    reader?.releaseLock()
    facts.elapsedMs = performance.now() - started
  }
  return facts
}

type Child = Pick<Bun.Subprocess<"ignore", "pipe", "pipe">, "stdout" | "stderr" | "exitCode" | "kill" | "exited">
export function observeCrossOSFailureChild(child: Child, kind: "fresh-bun" | "curl", expected: Run) {
  const started = performance.now()
  const facts = {
    exitCode: null as number | null,
    exited: false,
    stdoutBytes: 0,
    stderrBytes: 0,
    stdoutEOF: false,
    stderrEOF: false,
    outputLimit: false,
    pipeError: false,
    killCalled: false,
    killFailed: false,
  }
  let output = new Uint8Array(0)
  function cancel() {
    if (child.exitCode !== null) return
    facts.killCalled = true
    try {
      child.kill("SIGKILL")
    } catch {
      facts.killFailed = true
    }
  }
  async function drain(stream: ReadableStream<Uint8Array>, name: "stdout" | "stderr") {
    const reader = stream.getReader()
    const chunks: Uint8Array[] = []
    let retained = 0
    try {
      while (true) {
        const next = await reader.read()
        if (next.done) {
          if (name === "stdout") facts.stdoutEOF = true
          else facts.stderrEOF = true
          break
        }
        const key = name === "stdout" ? "stdoutBytes" : "stderrBytes"
        facts[key] = Math.min(Number.MAX_SAFE_INTEGER, facts[key] + next.value.byteLength)
        if (facts[key] > 16384) {
          facts.outputLimit = true
          cancel()
        }
        if (name === "stdout" && retained < 16384) {
          const chunk = next.value.slice(0, 16384 - retained)
          chunks.push(chunk)
          retained += chunk.byteLength
        }
      }
    } catch {
      facts.pipeError = true
      cancel()
    } finally {
      reader.releaseLock()
    }
    if (name === "stdout") {
      output = new Uint8Array(retained)
      let offset = 0
      for (const chunk of chunks) {
        output.set(chunk, offset)
        offset += chunk.byteLength
      }
    }
  }
  const done = Promise.allSettled([
    child.exited.then(
      (code) => {
        facts.exited = true
        facts.exitCode = code
      },
      () => {
        facts.pipeError = true
      },
    ),
    drain(child.stdout, "stdout"),
    drain(child.stderr, "stderr"),
  ]).then((outcomes) => {
    if (outcomes.some((entry) => entry.status === "rejected")) facts.pipeError = true
    let http: HTTPFacts | undefined
    let context: z.infer<typeof BunFacts>["context"] | undefined
    let code = facts.outputLimit
      ? "OUTPUT_LIMIT"
      : facts.pipeError
        ? "PIPE_ERROR"
        : facts.exitCode !== 0
          ? "CHILD_EXIT"
          : "INVALID_OUTPUT"
    if (!facts.outputLimit && !facts.pipeError) {
      try {
        const text = new TextDecoder().decode(output)
        if (kind === "fresh-bun" && facts.exitCode === 0) {
          const parsed = BunFacts.parse(JSON.parse(text))
          http = parsed.http
          context = parsed.context
        } else if (kind === "curl") {
          const match = text.match(/\n(\d{3})\n$/)
          if (match && Number(match[1]) >= 100 && Number(match[1]) <= 599) {
            const status = Number(match[1]),
              body = text.slice(0, match.index)
            const bytes = Math.min(8193, new TextEncoder().encode(body).byteLength)
            let value: { run?: Record<string, unknown>; native?: unknown } | undefined
            try {
              if (bytes <= 8192) value = JSON.parse(body)
            } catch {}
            const runMatches =
              typeof value?.run === "object" &&
              value.run !== null &&
              Object.keys(value.run).sort().join(",") === "attempt,id,repository,sha" &&
              ["repository", "id", "attempt", "sha"].every((key) => value.run![key] === expected[key as keyof Run])
            const nativeMatches = value?.native === "darwin"
            http = HTTPFacts.parse({
              code:
                bytes > 8192
                  ? "BODY_LIMIT"
                  : status < 200 || status >= 300
                    ? "HTTP_STATUS"
                    : !value
                      ? "INVALID_BODY"
                      : !runMatches
                        ? "WRONG_RUN"
                        : !nativeMatches
                          ? "WRONG_NATIVE"
                          : "OK",
              status,
              headersReceived: true,
              bodyBytes: bytes,
              runMatches,
              nativeMatches,
              elapsedMs: performance.now() - started,
            })
          }
        }
        if (http && facts.exitCode === 0) code = http.code
      } catch {}
    }
    if (kind === "curl" && facts.exitCode !== 0 && !facts.outputLimit && !facts.pipeError)
      code =
        (
          {
            5: "PROXY_RESOLVE",
            6: "ENOTFOUND",
            7: "CONNECT_FAILED",
            28: "TIMEOUT",
            35: "TLS_FAILED",
            60: "TLS_CERT_FAILED",
          } as Record<number, string>
        )[facts.exitCode!] ?? "CHILD_EXIT"
    return {
      ...facts,
      code,
      ...(http ? { http } : {}),
      ...(context ? { context } : {}),
      elapsedMs: performance.now() - started,
    }
  })
  return { done, cancel, snapshot: () => ({ ...facts }) }
}

export function crossOSFailureBunScript() {
  return `const observe = ${observeCrossOSFailureHTTP.toString()}; const classify = ${crossOSLibinfoFlag.toString()}; const pinned = ${pinnedCrossOSBun.toString()}; const input = JSON.parse(process.env.SYNERGY_CROSS_OS_FAILURE_INPUT); const context = { libinfoFlag: classify(process.env.BUN_FEATURE_FLAG_DISABLE_DNS_CACHE_LIBINFO), pinnedBun: pinned() }; process.stdout.write(JSON.stringify({ http: await observe(input), context }));`
}

// Provenance: https://github.com/oven-sh/bun/blob/c6da4a4d3010e5553438c60f6bd76d981976867c/src/runtime/cli/Arguments.rs#L216
// https://curl.se/docs/manpage.html (--disable, --max-time and --write-out).
// The clients are late failure observations; none can make the original health check pass.
export function startCrossOSPostFailureHTTP(origin: string, expected: Run) {
  const parsed = new URL(origin)
  if (
    parsed.protocol !== "https:" ||
    parsed.origin !== origin ||
    !/^[a-z0-9-]+\.trycloudflare\.com$/.test(parsed.hostname)
  )
    throw new Error("Post-failure comparison requires the original captured HTTPS origin")
  const started = performance.now(),
    deadline = Date.now() + 1500
  const input = { url: origin + "/__cross-os-health", run: expected, deadline }
  const children: ReturnType<typeof observeCrossOSFailureChild>[] = []
  const rawChildren: Child[] = []
  const clocks: Partial<
    Record<
      | "sameBunStartedAtMs"
      | "sameBunSettledAtMs"
      | "freshBunStartedAtMs"
      | "freshBunSettledAtMs"
      | "freshBunLibcStartedAtMs"
      | "freshBunLibcSettledAtMs"
      | "curlStartedAtMs"
      | "curlSettledAtMs",
      number
    >
  > = { sameBunStartedAtMs: performance.now() - started }
  let same: HTTPFacts | { code: "OBSERVATION_ERROR" } | undefined
  let fresh:
    | Awaited<ReturnType<typeof observeCrossOSFailureChild>["done"]>
    | { code: "SPAWN_FAILED" | "WORK_DEADLINE" }
    | undefined
  let curl: typeof fresh
  let freshLibc: typeof fresh | { code: "UNSUPPORTED_PIN" | "UNSUPPORTED_PLATFORM" | "BASELINE_ALREADY_TRUTHY" }
  const inheritedLibinfoFlag = crossOSLibinfoFlag(process.env.BUN_FEATURE_FLAG_DISABLE_DNS_CACHE_LIBINFO)
  const pinnedBun = pinnedCrossOSBun()
  const tasks: Promise<unknown>[] = [
    observeCrossOSFailureHTTP(input).then(
      (value) => {
        same = value
        clocks.sameBunSettledAtMs = performance.now() - started
      },
      () => {
        same = { code: "OBSERVATION_ERROR" }
        clocks.sameBunSettledAtMs = performance.now() - started
      },
    ),
  ]
  function spawn(kind: "fresh-bun" | "fresh-bun-libc" | "curl") {
    try {
      if (Date.now() >= deadline) {
        if (kind === "fresh-bun") fresh = { code: "WORK_DEADLINE" }
        else if (kind === "fresh-bun-libc") freshLibc = { code: "WORK_DEADLINE" }
        else curl = { code: "WORK_DEADLINE" }
        return
      }
      if (kind === "fresh-bun") clocks.freshBunStartedAtMs = performance.now() - started
      else if (kind === "fresh-bun-libc") clocks.freshBunLibcStartedAtMs = performance.now() - started
      else clocks.curlStartedAtMs = performance.now() - started
      const child = Bun.spawn(
        kind !== "curl"
          ? [process.execPath, "--eval", crossOSFailureBunScript()]
          : [
              "/usr/bin/curl",
              "--disable",
              "--silent",
              "--max-time",
              String(Math.max(0.001, (deadline - Date.now()) / 1000)),
              "--write-out",
              "\\n%{http_code}\\n",
              input.url,
            ],
        {
          cwd: process.cwd(),
          env:
            kind === "curl"
              ? { ...process.env }
              : {
                  ...process.env,
                  SYNERGY_CROSS_OS_FAILURE_INPUT: JSON.stringify(input),
                  ...(kind === "fresh-bun-libc" ? { BUN_FEATURE_FLAG_DISABLE_DNS_CACHE_LIBINFO: "1" } : {}),
                },
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        },
      )
      rawChildren.push(child)
      const owned = observeCrossOSFailureChild(child, kind === "curl" ? "curl" : "fresh-bun", expected)
      children.push(owned)
      tasks.push(
        owned.done.then((value) => {
          if (kind === "fresh-bun") {
            fresh = value
            clocks.freshBunSettledAtMs = performance.now() - started
          } else if (kind === "fresh-bun-libc") {
            freshLibc = value
            clocks.freshBunLibcSettledAtMs = performance.now() - started
          } else {
            curl = value
            clocks.curlSettledAtMs = performance.now() - started
          }
        }),
      )
    } catch {
      if (kind === "fresh-bun") fresh = { code: "SPAWN_FAILED" }
      else if (kind === "fresh-bun-libc") freshLibc = { code: "SPAWN_FAILED" }
      else curl = { code: "SPAWN_FAILED" }
    }
  }
  spawn("fresh-bun")
  spawn("curl")
  // Provenance: https://github.com/oven-sh/bun/blob/c6da4a4d3010e5553438c60f6bd76d981976867c/src/runtime/dns_jsc/dns.rs#L3072-L3117
  // This child-only flag requests the libc miss path; it does not disable the separate DNS cache.
  if (!pinnedBun) freshLibc = { code: "UNSUPPORTED_PIN" }
  else if (process.platform !== "darwin") freshLibc = { code: "UNSUPPORTED_PLATFORM" }
  else if (inheritedLibinfoFlag === "truthy") freshLibc = { code: "BASELINE_ALREADY_TRUTHY" }
  else spawn("fresh-bun-libc")
  const settled = Promise.allSettled(tasks)
  const window = Promise.withResolvers<void>()
  const cancelTimer = setTimeout(
    () => {
      for (const child of children) child.cancel()
    },
    Math.max(0, 1750 - (performance.now() - started)),
  )
  const windowTimer = setTimeout(() => window.resolve(), Math.max(0, 2500 - (performance.now() - started)))
  const tls = process.env.NODE_TLS_REJECT_UNAUTHORIZED
  const result = Promise.race([settled, window.promise]).then(() => {
    clearTimeout(cancelTimer)
    clearTimeout(windowTimer)
    const baselineObservedFlag = fresh && "context" in fresh ? fresh.context?.libinfoFlag : undefined
    return {
      timing: "after-irrevocable-original-failure" as const,
      sampling: "same-late-window" as const,
      workBudgetMs: 1500,
      observationWindowMs: 2500,
      freshContext: "minimal-Bun-CLI-inherited-env-and-cwd-not-test-preloads" as const,
      tlsMode: tls === undefined ? "unset" : tls === "1" ? "strict1" : tls === "0" ? "disabled0" : "other",
      backendDiagnostic: {
        requestedContext: "extra-child-only-disable-dns-sd-on-connect-cache-miss" as const,
        backendAttested: false,
        pinnedBun,
        inheritedLibinfoFlag,
        baselineObservedFlag,
        flagContrast: !pinnedBun
          ? "unsupported-pin"
          : process.platform !== "darwin"
            ? "unsupported-platform"
            : inheritedLibinfoFlag === "truthy" || baselineObservedFlag === "truthy"
              ? "baseline-already-truthy"
              : baselineObservedFlag === undefined
                ? "baseline-unobserved"
                : "requested-child-flag-difference",
      },
      sameBun: same ?? { code: "UNSETTLED" },
      freshBun: fresh ?? { code: "UNSETTLED" },
      freshBunLibc: freshLibc ?? { code: "UNSETTLED" },
      curl: curl ?? { code: "UNSETTLED" },
      clocks: { ...clocks },
      childCleanup: children.map((child) => child.snapshot()),
      elapsedMs: performance.now() - started,
    }
  })
  return {
    result,
    async close() {
      for (const child of children) child.cancel()
      for (const child of rawChildren)
        if (child.exitCode === null) {
          try {
            child.kill("SIGKILL")
          } catch {}
        }
      await settled
      const exits = await Promise.allSettled(rawChildren.map((child) => child.exited))
      return {
        ownedChildCount: rawChildren.length,
        observedChildCount: children.length,
        children: children.map((child) => child.snapshot()),
        sameBunSettled: same !== undefined,
        allOwnedChildrenExited: exits.every((entry) => entry.status === "fulfilled"),
      }
    },
  }
}
