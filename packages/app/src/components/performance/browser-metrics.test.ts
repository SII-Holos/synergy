import { describe, expect, test } from "bun:test"
import { buildSessionSwitchMetrics, buildTokenTimingMetric, pageContextFromUrl } from "./browser-metrics"

describe("browser performance metrics", () => {
  test("builds safe route and session context", () => {
    expect(pageContextFromUrl("/session/1234567890abcdef", "?sessionID=ses_abc-123&scopeID=scope:def")).toEqual({
      routeName: "session.1234567890abcdef",
      pathTemplate: "/session/:id",
      sessionID: "ses_abc-123",
      scopeID: "scope:def",
    })
  })

  test("strips unsafe context characters and query data", () => {
    expect(
      pageContextFromUrl("/files/super-secret-token-value", "?sessionID=ses_abc%0Asecret&scopeID=<scope>"),
    ).toEqual({
      routeName: "files.super-secret-token-value",
      pathTemplate: "/files/super-secret-token-value",
      sessionID: "ses_abcsecret",
      scopeID: "scope",
    })
  })

  test("builds safe session switch timing metrics", () => {
    const metrics = buildSessionSwitchMetrics({
      sessionID: "ses_1",
      scopeID: "scope_1",
      correlationId: "corr_1",
      navigationId: "nav_1",
      sessionSwitchId: "switch_1",
      startTime: 100,
      endTime: 220,
      marks: { "session:data-ready": 140, "session:first-turn-mounted": 200 },
      reason: "complete",
      trigger: "route",
      longTaskOverlapMs: 16,
    })

    expect(metrics.map((metric) => metric.name)).toEqual([
      "frontend.session_switch.duration",
      "frontend.session_switch.phase.duration",
      "frontend.session_switch.phase.duration",
      "frontend.session_switch.long_task_overlap",
    ])
    expect(metrics[0]).toMatchObject({
      value: 120,
      labels: {
        sessionID: "ses_1",
        scopeID: "scope_1",
        correlationId: "corr_1",
        navigationId: "nav_1",
        sessionSwitchId: "switch_1",
        reason: "complete",
        trigger: "route",
      },
    })
  })

  test("drops invalid timing values", () => {
    expect(
      buildSessionSwitchMetrics({
        sessionID: "ses_1",
        correlationId: "corr_1",
        navigationId: "nav_1",
        sessionSwitchId: "switch_1",
        startTime: 100,
        endTime: 90,
        marks: { "session:data-ready": Number.POSITIVE_INFINITY },
        reason: "timeout",
      }),
    ).toEqual([])

    expect(
      buildTokenTimingMetric({
        phase: "apply",
        value: Number.NaN,
        unit: "ms",
        part: { id: "prt_1", sessionID: "ses_1", messageID: "msg_1", type: "text" },
        receipt: {
          time: 10,
          context: { sessionID: "ses_1", correlationId: "msg_1" },
          deltaChars: 4,
          partType: "text",
        },
      }),
    ).toBeUndefined()
  })

  test("builds token receive/apply/paint timing labels", () => {
    const metric = buildTokenTimingMetric({
      phase: "paint",
      value: 12,
      unit: "ms",
      part: { id: "prt_1", sessionID: "ses_1", messageID: "msg_1", type: "text" },
      receipt: {
        time: 10,
        context: { sessionID: "ses_1", correlationId: "msg_1", navigationId: "nav_1" },
        deltaChars: 4,
        partType: "text",
      },
    })

    expect(metric).toMatchObject({
      name: "frontend.token.paint.duration",
      value: 12,
      unit: "ms",
      labels: {
        sessionID: "ses_1",
        correlationId: "msg_1",
        navigationId: "nav_1",
        phase: "paint",
        tokenPhase: "paint",
        deltaChars: 4,
        messageID: "msg_1",
      },
    })
  })
})
