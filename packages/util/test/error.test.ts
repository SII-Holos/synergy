import { describe, expect, test } from "bun:test"
import { z } from "zod"
import { NamedError } from "../src/error"

const ConfigError = NamedError.create(
  "ConfigError",
  z.object({
    message: z.string(),
    code: z.number(),
  }),
)

describe("NamedError.create", () => {
  test("produces an Error subclass carrying structured data", () => {
    const error = new ConfigError({ message: "missing token", code: 7 })
    expect(error).toBeInstanceOf(Error)
    expect(error).toBeInstanceOf(ConfigError)
    expect(error.name).toBe("ConfigError")
    expect(error.message).toBe("missing token")
    expect(error.data).toEqual({ message: "missing token", code: 7 })
  })

  test("falls back to the error name when data has no message field", () => {
    expect(new ConfigError({ message: "", code: 1 }).message).toBe("")
    const NoMessage = NamedError.create("NoMessageError", z.object({ code: z.number() }))
    expect(new NoMessage({ code: 1 }).message).toBe("NoMessageError")
  })

  test("round-trips through schema and toObject", () => {
    const error = new ConfigError({ message: "bad", code: 3 })
    expect(error.toObject()).toEqual({ name: "ConfigError", data: { message: "bad", code: 3 } })
    expect(ConfigError.Schema.parse(error.toObject())).toEqual(error.toObject())
    expect(error.schema()).toBe(ConfigError.Schema)
  })

  test("accepts ErrorOptions causes", () => {
    const cause = new Error("root")
    const error = new ConfigError({ message: "wrapped", code: 4 }, { cause })
    expect(error.cause).toBe(cause)
  })

  test("isInstance matches by error name and rejects impostors", () => {
    const error = new ConfigError({ message: "x", code: 1 })
    expect(ConfigError.isInstance(error)).toBe(true)
    expect(ConfigError.isInstance(new Error("x"))).toBe(false)
    expect(ConfigError.isInstance({ name: "OtherError", data: {} })).toBe(false)
    expect(ConfigError.isInstance({ name: "ConfigError", data: {} })).toBe(true)
    expect(() => ConfigError.isInstance(null)).toThrow()
  })

  test("applies the schema only through serialization, not construction", () => {
    const error = new ConfigError({ message: "x", code: "not-a-number" as never })
    expect(error.data as unknown).toEqual({ message: "x", code: "not-a-number" })
    expect(() => ConfigError.Schema.parse(error.toObject())).toThrow(z.ZodError)
  })
})

describe("NamedError.Unknown", () => {
  test("is a usable NamedError with a message payload", () => {
    const error = new NamedError.Unknown({ message: "something broke" })
    expect(error.name).toBe("UnknownError")
    expect(error.message).toBe("something broke")
    expect(NamedError.Unknown.isInstance(error)).toBe(true)
  })
})
