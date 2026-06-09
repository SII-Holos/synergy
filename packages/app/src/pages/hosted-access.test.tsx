import { describe, expect, test } from "bun:test"
import { hostedStyleScopeAttrs } from "./hosted-style"

describe("HostedStyleScope", () => {
  test("defines stable Holos hosted scope attributes", () => {
    expect(hostedStyleScopeAttrs).toEqual({
      class: "holos-hosted-app size-full min-h-0 flex flex-col",
      "data-holos-hosted": "true",
    })
  })
})
