import { describe, expect, test } from "bun:test"
import { proxyPrefix } from "./proxy"

type HappyDOMWindow = Window & typeof globalThis & {
  happyDOM: {
    setURL(url: string): void
  }
}

function navigateTo(pathname: string) {
  ;(window as HappyDOMWindow).happyDOM.setURL(`http://localhost:8081${pathname}`)
  delete window.__SYNERGY_ROUTE__
}

describe("proxyPrefix", () => {
  test("infers the hosted agent prefix from the current path when no runtime route tag exists", () => {
    navigateTo("/agents/agent-1/Z2xvYmFs/session")

    expect(proxyPrefix()).toBe("/agents/agent-1")
  })

  test("keeps runtime route tag precedence for prefixed deep routes", () => {
    ;(window as HappyDOMWindow).happyDOM.setURL("http://localhost:8081/agents/agent-1/Z2xvYmFs/session")
    window.__SYNERGY_ROUTE__ = "/Z2xvYmFs/session"

    expect(proxyPrefix()).toBe("/agents/agent-1")
  })
})
