import { describe, expect, test } from "bun:test"
import { createBubbleMenu } from "../../../src/components/note/bubble-menu"

describe("Note bubble menu", () => {
  test("stays hidden and out of document flow until Floating UI positions it", () => {
    const element = document.createElement("div")
    document.body.append(element)

    const extension = createBubbleMenu(element)

    expect(element.style.position).toBe("absolute")
    expect(element.style.visibility).toBe("hidden")
    expect(element.style.opacity).toBe("0")
    expect(extension.options.options).toMatchObject({ placement: "top", offset: 8 })

    element.remove()
  })
})
