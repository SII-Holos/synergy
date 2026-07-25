import { describe, expect, test } from "bun:test"
import { projectMenuPlacement } from "../../../src/components/sidebar/project-menu-placement"

describe("sidebar project menu placement", () => {
  test("opens downward when the menu fits above the sidebar footer", () => {
    expect(
      projectMenuPlacement({
        triggerBottom: 276,
        boundaryBottom: 480,
        menuHeight: 120,
      }),
    ).toBe("down")
  })

  test("opens upward when the sidebar footer leaves too little room below", () => {
    expect(
      projectMenuPlacement({
        triggerBottom: 436,
        boundaryBottom: 480,
        menuHeight: 120,
      }),
    ).toBe("up")
  })

  test("keeps opening downward when the menu exactly fits", () => {
    expect(
      projectMenuPlacement({
        triggerBottom: 360,
        boundaryBottom: 480,
        menuHeight: 120,
      }),
    ).toBe("down")
  })

  test("opens upward whenever the menu cannot fit below", () => {
    expect(
      projectMenuPlacement({
        triggerBottom: 396,
        boundaryBottom: 480,
        menuHeight: 120,
      }),
    ).toBe("up")
  })
})
