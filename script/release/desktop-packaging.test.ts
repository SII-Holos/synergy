import { describe, expect, test } from "bun:test"

interface WorkflowStep {
  name?: string
  env?: Record<string, unknown>
}

interface ReleaseWorkflow {
  jobs?: {
    stable_desktop_package?: {
      steps?: WorkflowStep[]
    }
  }
}

describe("desktop release packaging", () => {
  test("enables certificate discovery only for macOS packaging", async () => {
    const source = await Bun.file(new URL("../../.github/workflows/release.yml", import.meta.url)).text()
    const workflow = Bun.YAML.parse(source) as ReleaseWorkflow
    const steps = workflow.jobs?.stable_desktop_package?.steps ?? []
    const signingSteps = ["Package desktop artifact", "Package signed Browser Host artifacts"]

    for (const name of signingSteps) {
      const step = steps.find((candidate) => candidate.name === name)
      expect(step?.env?.CSC_IDENTITY_AUTO_DISCOVERY).toBe("${{ matrix.platform == 'darwin' && 'true' || 'false' }}")
    }
  })
})
