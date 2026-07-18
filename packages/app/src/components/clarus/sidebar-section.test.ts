import { describe, expect, test } from "bun:test"

describe("Clarus sidebar disclosure keyboard behavior", () => {
  test("Enter and Space toggle while unrelated keys are ignored", async () => {
    const { handleDisclosureKeyDown } = await import("./keyboard")
    const toggled: boolean[] = []
    const handler = (value: boolean) => toggled.push(value)

    let prevented = 0
    handleDisclosureKeyDown({ key: "Enter", preventDefault: () => prevented++ }, true, handler)
    handleDisclosureKeyDown({ key: " ", preventDefault: () => prevented++ }, false, handler)
    handleDisclosureKeyDown({ key: "ArrowDown", preventDefault: () => prevented++ }, true, handler)

    expect(toggled).toEqual([false, true])
    expect(prevented).toBe(2)
  })
})
