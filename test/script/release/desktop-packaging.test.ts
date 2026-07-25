import { describe, expect, test } from "bun:test"

interface WorkflowStep {
  name?: string
  run?: string
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
  test("uses macOS signing material only for macOS packaging", async () => {
    const source = await Bun.file(new URL("../../../.github/workflows/release.yml", import.meta.url)).text()
    const workflow = Bun.YAML.parse(source) as ReleaseWorkflow
    const steps = workflow.jobs?.stable_desktop_package?.steps ?? []
    const signingSteps = ["Package desktop artifact", "Package signed Browser Host artifacts"]

    for (const name of signingSteps) {
      const step = steps.find((candidate) => candidate.name === name)
      expect(step?.env?.CSC_LINK).toBe("${{ matrix.platform == 'darwin' && secrets.CSC_LINK || '' }}")
      expect(step?.env?.CSC_KEY_PASSWORD).toBe("${{ matrix.platform == 'darwin' && secrets.CSC_KEY_PASSWORD || '' }}")
      expect(step?.env?.CSC_IDENTITY_AUTO_DISCOVERY).toBe("${{ matrix.platform == 'darwin' && 'true' || 'false' }}")
    }
  })

  test("assembles complete runtimes before packaging Desktop artifacts", async () => {
    const source = await Bun.file(new URL("../../../.github/workflows/release.yml", import.meta.url)).text()
    const workflow = Bun.YAML.parse(source) as ReleaseWorkflow
    const steps = workflow.jobs?.stable_desktop_package?.steps ?? []
    const buildIndex = steps.findIndex((step) => step.name === "Build Synergy runtime for desktop package")
    const prepareIndex = steps.findIndex((step) => step.name === "Prepare Synergy runtime for desktop package")
    const packageIndex = steps.findIndex((step) => step.name === "Package desktop artifact")
    const prepareStep = steps[prepareIndex]

    expect(buildIndex).toBeGreaterThanOrEqual(0)
    expect(prepareIndex).toBeGreaterThan(buildIndex)
    expect(packageIndex).toBeGreaterThan(prepareIndex)
    expect(prepareStep?.run).toBe("bun run ./script/release/prepare-desktop-runtime.ts")
    expect(prepareStep?.env?.SYNERGY_BUILD_TARGETS).toBe("${{ matrix.runtime_targets }}")
  })
})
