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

describe("Chromium release manifests", () => {
  test("generates and uploads signed manifests with the Browser trust key", async () => {
    const source = await Bun.file(new URL("../../../.github/workflows/release.yml", import.meta.url)).text()
    const workflow = Bun.YAML.parse(source) as ReleaseWorkflow
    const steps = workflow.jobs?.stable_desktop_package?.steps ?? []
    const generate = steps.find((step) => step.name === "Generate signed Chromium manifests")
    const upload = steps.find((step) => step.name === "Upload desktop artifact bundle")

    expect(generate?.run).toContain("chromium-manifest")
    expect(generate?.env?.SYNERGY_BROWSER_MANIFEST_SIGNING_KEY).toBe("${{ secrets.BROWSER_HOST_MANIFEST_SIGNING_KEY }}")
    expect(upload?.run ?? JSON.stringify(upload)).toContain("release/chromium/*.manifest.json")
    expect(upload?.run ?? JSON.stringify(upload)).toContain("release/chromium/*.manifest.json.sig")
  })
})
