import { describe, expect, test } from "bun:test"
import { LANGUAGE_SELF_NAMES } from "./language-self-names"

describe("language self names", () => {
  test("remain recognizable when the active catalog changes", () => {
    expect(LANGUAGE_SELF_NAMES).toEqual({
      en: "English",
      "zh-CN": "简体中文",
    })
  })
})
