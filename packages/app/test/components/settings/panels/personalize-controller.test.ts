import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import {
  createPersonalizeController,
  type CustomInstructionsInfo,
} from "../../../../src/components/settings/panels/personalize-controller"

const primary: CustomInstructionsInfo = {
  content: "Base instructions.\n",
  source: "primary",
  sourceFilename: "AGENTS.md",
  editableFilename: "AGENTS.override.md",
  hasOverride: false,
  maxBytes: 32 * 1024,
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function withController<T>(
  api: Parameters<typeof createPersonalizeController>[0],
  run: (controller: ReturnType<typeof createPersonalizeController>) => T | Promise<T>,
) {
  return createRoot((dispose) => {
    const controller = createPersonalizeController(api)
    return Promise.resolve(run(controller)).finally(dispose)
  })
}

describe("Personalize custom instructions controller", () => {
  test("loads the effective AGENTS.md content without marking it dirty", async () => {
    const result = await withController(
      {
        get: async () => primary,
        update: async () => primary,
        reset: async () => primary,
      },
      async (controller) => {
        await controller.load()
        return {
          content: controller.content(),
          source: controller.info()?.source,
          status: controller.status(),
          dirty: controller.dirty(),
        }
      },
    )

    expect(result).toEqual({ content: "Base instructions.\n", source: "primary", status: "idle", dirty: false })
  })

  test("tracks UTF-8 bytes and blocks saves beyond the server limit", async () => {
    const result = await withController(
      {
        get: async () => ({ ...primary, maxBytes: 4 }),
        update: async () => primary,
        reset: async () => primary,
      },
      async (controller) => {
        await controller.load()
        controller.setContent("你好")
        return { bytes: controller.byteCount(), overLimit: controller.overLimit(), canSave: controller.canSave() }
      },
    )

    expect(result).toEqual({ bytes: 6, overLimit: true, canSave: false })
  })

  test("exposes saving state and adopts the returned override", async () => {
    const pending = deferred<CustomInstructionsInfo>()
    const updates: string[] = []

    const result = await withController(
      {
        get: async () => primary,
        update: async (content) => {
          updates.push(content)
          return pending.promise
        },
        reset: async () => primary,
      },
      async (controller) => {
        await controller.load()
        controller.setContent("Personal instructions.\n")
        const saving = controller.save()
        const during = { status: controller.status(), canSave: controller.canSave() }
        pending.resolve({
          ...primary,
          content: "Personal instructions.\n",
          source: "override",
          sourceFilename: "AGENTS.override.md",
          hasOverride: true,
        })
        await saving
        return {
          during,
          updates,
          status: controller.status(),
          dirty: controller.dirty(),
          hasOverride: controller.info()?.hasOverride,
        }
      },
    )

    expect(result).toEqual({
      during: { status: "saving", canSave: false },
      updates: ["Personal instructions.\n"],
      status: "idle",
      dirty: false,
      hasOverride: true,
    })
  })

  test("resets the managed override and surfaces request failures", async () => {
    let shouldFail = true
    const result = await withController(
      {
        get: async () => ({
          ...primary,
          content: "Override.\n",
          source: "override",
          sourceFilename: "AGENTS.override.md",
          hasOverride: true,
        }),
        update: async () => primary,
        reset: async () => {
          if (shouldFail) throw new Error("reset failed")
          return primary
        },
      },
      async (controller) => {
        await controller.load()
        await controller.reset()
        const failed = { status: controller.status(), error: controller.error(), content: controller.content() }
        shouldFail = false
        await controller.reset()
        return { failed, status: controller.status(), error: controller.error(), content: controller.content() }
      },
    )

    expect(result).toEqual({
      failed: { status: "error", error: "reset failed", content: "Override.\n" },
      status: "idle",
      error: undefined,
      content: "Base instructions.\n",
    })
  })
})
