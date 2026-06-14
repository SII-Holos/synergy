import { describe, expect, test } from "bun:test"
import { appAccessFromHostedAgentPath, hostedAgentPrefix, isHostedAgentAccess, isHostedMode } from "./runtime"

type HappyDOMWindow = Window &
  typeof globalThis & {
    happyDOM: {
      setURL(url: string): void
    }
  }

function navigateTo(pathname: string) {
  ;(window as HappyDOMWindow).happyDOM.setURL(`http://localhost:8081${pathname}`)
  delete window.__SYNERGY_ROUTE__
}

describe("hosted agent runtime access", () => {
  test("detects direct Gateway agent paths as hosted access", () => {
    navigateTo("/agents/agent-1/")

    expect(hostedAgentPrefix()).toBe("/agents/agent-1")
    expect(isHostedAgentAccess()).toBe(true)
    expect(isHostedMode()).toBe(true)
  })

  test("builds App access from the current Gateway agent path", () => {
    navigateTo("/agents/agent-1/global/health")

    expect(appAccessFromHostedAgentPath()).toEqual({
      attachUrl: "http://localhost:8081/agents/agent-1",
      callbackUrl: "http://localhost:8081/agents/agent-1/holos/callback",
    })
  })
})
