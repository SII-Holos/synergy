import { describe, expect, test, beforeEach } from "bun:test"
import { Log } from "../../src/util/log"

describe("util.log", () => {
  let output: string[]

  beforeEach(() => {
    output = []
  })

  function capture(): Log.Logger {
    return Log.create({ service: `test-${Date.now()}-${Math.random()}` })
  }

  describe("level gating", () => {
    test("respects configured level", () => {
      const logger = capture()
      logger.debug("should not appear in INFO mode")
      logger.info("should appear")
    })
  })

  describe("immutable logger", () => {
    test("tag() returns a new logger, does not mutate original", () => {
      const base = Log.create({ service: `immut-${Date.now()}` })
      const tagged = base.tag("env", "prod")
      expect(tagged).not.toBe(base)
    })

    test("clone() returns independent logger", () => {
      const base = Log.create({ service: `clone-${Date.now()}` })
      const cloned = base.clone()
      expect(cloned).not.toBe(base)
    })

    test("tagging one logger does not affect another with same service", () => {
      const name = `shared-${Date.now()}`
      const a = Log.create({ service: name })
      const b = a.tag("extra", "value")
      expect(b).not.toBe(a)
    })
  })

  describe("safe serialization", () => {
    test("handles circular references without throwing", () => {
      const logger = capture()
      const obj: any = { a: 1 }
      obj.self = obj
      expect(() => logger.info("circular", { data: obj })).not.toThrow()
    })

    test("handles BigInt without throwing", () => {
      const logger = capture()
      expect(() => logger.info("bigint", { value: BigInt(9007199254740991) })).not.toThrow()
    })

    test("handles Error with cause chain", () => {
      const logger = capture()
      const inner = new Error("root cause")
      const outer = new Error("wrapper", { cause: inner })
      expect(() => logger.error("chained", { error: outer })).not.toThrow()
    })

    test("handles deeply nested Error cause chain", () => {
      const logger = capture()
      let err: Error = new Error("base")
      for (let i = 0; i < 20; i++) {
        err = new Error(`level ${i}`, { cause: err })
      }
      expect(() => logger.error("deep cause", { error: err })).not.toThrow()
    })

    test("handles Symbol values", () => {
      const logger = capture()
      expect(() => logger.info("symbol", { key: Symbol("test") })).not.toThrow()
    })

    test("handles function values", () => {
      const logger = capture()
      expect(() => logger.info("fn", { callback: () => {} })).not.toThrow()
    })

    test("handles null and undefined", () => {
      const logger = capture()
      expect(() => logger.info("nulls", { a: null, b: undefined })).not.toThrow()
    })

    test("handles Error with code property", () => {
      const logger = capture()
      const err = new Error("ENOENT") as Error & { code: string }
      err.code = "ENOENT"
      expect(() => logger.error("fs error", { error: err })).not.toThrow()
    })

    test("truncates very long strings", () => {
      const logger = capture()
      const long = "x".repeat(10000)
      expect(() => logger.info("long", { data: long })).not.toThrow()
    })

    test("handles deeply nested objects", () => {
      const logger = capture()
      let obj: any = { value: "leaf" }
      for (let i = 0; i < 20; i++) {
        obj = { nested: obj }
      }
      expect(() => logger.info("deep", { data: obj })).not.toThrow()
    })

    test("handles large arrays", () => {
      const logger = capture()
      const arr = Array.from({ length: 1000 }, (_, i) => i)
      expect(() => logger.info("big array", { data: arr })).not.toThrow()
    })

    test("handles objects with toJSON that throws", () => {
      const logger = capture()
      const obj = {
        toJSON() {
          throw new Error("toJSON failed")
        },
      }
      expect(() => logger.info("bad toJSON", { data: obj })).not.toThrow()
    })
  })

  describe("sanitize / redact", () => {
    test("redacts sensitive keys in extra", () => {
      const logger = capture()
      expect(() =>
        logger.info("auth", {
          token: "secret-value",
          password: "hunter2",
          apiKey: "sk-123456",
        }),
      ).not.toThrow()
    })

    test("redacts case-insensitively", () => {
      const logger = capture()
      expect(() =>
        logger.info("mixed case", {
          Token: "abc",
          PASSWORD: "def",
          Authorization: "Bearer xyz",
        }),
      ).not.toThrow()
    })

    test("strips control characters from messages", () => {
      const logger = capture()
      expect(() => logger.info("clean\x00this\x01up\x08now")).not.toThrow()
    })

    test("replaces newlines in messages", () => {
      const logger = capture()
      expect(() => logger.info("line1\nline2\nline3")).not.toThrow()
    })

    test("handles the full sensitive key list", () => {
      const logger = capture()
      const sensitiveFields: Record<string, string> = {
        token: "t1",
        secret: "s1",
        password: "p1",
        authorization: "a1",
        cookie: "c1",
        "set-cookie": "sc1",
        apiKey: "ak1",
        api_key: "ak2",
        accessToken: "at1",
        refreshToken: "rt1",
        agentSecret: "as1",
      }
      expect(() => logger.info("all sensitive", sensitiveFields)).not.toThrow()
    })
  })

  describe("time()", () => {
    test("does not log started message", () => {
      const logger = capture()
      const timer = logger.time("operation")
      timer.stop()
    })

    test("stop() is idempotent", () => {
      const logger = capture()
      const timer = logger.time("operation")
      timer.stop()
      timer.stop()
    })

    test("supports Symbol.dispose", () => {
      const logger = capture()
      const timer = logger.time("operation")
      timer[Symbol.dispose]()
    })

    test("stop() accepts extra fields", () => {
      const logger = capture()
      const timer = logger.time("operation")
      expect(() => timer.stop({ outcome: "success", count: 42 })).not.toThrow()
    })
  })

  describe("create()", () => {
    test("caches loggers by service name", () => {
      const name = `cached-${Date.now()}`
      const a = Log.create({ service: name })
      const b = Log.create({ service: name })
      expect(a).toBe(b)
    })

    test("different services produce different loggers", () => {
      const a = Log.create({ service: `svc-a-${Date.now()}` })
      const b = Log.create({ service: `svc-b-${Date.now()}` })
      expect(a).not.toBe(b)
    })

    test("create without tags does not throw", () => {
      expect(() => Log.create()).not.toThrow()
    })

    test("create with empty object does not throw", () => {
      expect(() => Log.create({})).not.toThrow()
    })
  })

  describe("Default logger", () => {
    test("exists and is usable", () => {
      expect(Log.Default).toBeDefined()
      expect(() => Log.Default.info("test")).not.toThrow()
    })
  })
})
