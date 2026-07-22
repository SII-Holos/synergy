import { beforeEach, describe, expect, test } from "bun:test"
import { RetentionProbe } from "../../src/session/retention-probe"

describe("RetentionProbe", () => {
  beforeEach(() => RetentionProbe.resetForTest())

  test("marks tracked owners without retaining them strongly in its public state", () => {
    const target = { payload: "test" }
    const probe = RetentionProbe.begin({
      sessionID: "ses_probe",
      messageID: "msg_probe",
      env: { SYNERGY_RETENTION_PROBE_ENABLED: "1" },
    })

    probe.track("stream.input", target, 1_024)
    expect(String(RetentionProbe.markerForTest(target))).toContain("stream.input")
    expect(Object.keys(target)).toEqual(["payload"])
    expect(RetentionProbe.stats()).toEqual({ groups: 1, releasedGroups: 0, targets: 1 })

    probe.release()
    RetentionProbe.checkReleased({ phase: "test.gc", afterGC: true, now: Date.now() })
    expect(RetentionProbe.stats()).toEqual({ groups: 1, releasedGroups: 1, targets: 1 })
  })

  test("can be disabled without modifying tracked objects", () => {
    const target = { payload: "test" }
    const probe = RetentionProbe.begin({
      sessionID: "ses_disabled",
      messageID: "msg_disabled",
      env: { SYNERGY_RETENTION_PROBE_ENABLED: "0" },
    })
    probe.track("prompt.messages", target, 1_024)
    probe.release()
    expect(RetentionProbe.markerForTest(target)).toBeUndefined()
    expect(RetentionProbe.stats()).toEqual({ groups: 0, releasedGroups: 0, targets: 0 })
  })
})
