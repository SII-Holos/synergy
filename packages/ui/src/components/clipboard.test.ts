import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { configureClipboard, copyTextToClipboard, createCopyController } from "./clipboard-core"

describe("clipboard", () => {
  test("uses configured writer before navigator or fallback", async () => {
    const calls: string[] = []
    const navigatorCalls: string[] = []
    const result = await copyTextToClipboard("desktop copy", {
      writer: async (text) => {
        calls.push(text)
        return true
      },
      environment: {
        isSecureContext: true,
        navigator: {
          clipboard: {
            writeText: async (text: string) => {
              navigatorCalls.push(text)
            },
          },
        } as unknown as Pick<Navigator, "clipboard">,
      },
    })

    expect(result).toEqual({ ok: true, method: "desktop" })
    expect(calls).toEqual(["desktop copy"])
    expect(navigatorCalls).toEqual([])
  })

  test("writes through navigator in secure contexts", async () => {
    const calls: string[] = []
    const result = await copyTextToClipboard("browser copy", {
      environment: {
        isSecureContext: true,
        navigator: {
          clipboard: {
            writeText: async (text: string) => {
              calls.push(text)
            },
          },
        } as unknown as Pick<Navigator, "clipboard">,
      },
    })

    expect(result).toEqual({ ok: true, method: "navigator" })
    expect(calls).toEqual(["browser copy"])
  })

  test("falls back to execCommand when navigator clipboard is unavailable", async () => {
    const appended: unknown[] = []
    const textarea = {
      value: "",
      style: {},
      setAttribute() {},
      focus() {},
      select() {},
    }
    const document = {
      body: {
        appendChild(node: unknown) {
          appended.push(node)
        },
        removeChild(node: unknown) {
          expect(node).toBe(textarea)
        },
      },
      createElement(tag: string) {
        expect(tag).toBe("textarea")
        return textarea
      },
      execCommand(command: string) {
        return command === "copy" && textarea.value === "fallback copy"
      },
    }

    const result = await copyTextToClipboard("fallback copy", {
      environment: {
        isSecureContext: false,
        document: document as unknown as Document,
      },
    })

    expect(result).toEqual({ ok: true, method: "execCommand" })
    expect(appended).toEqual([textarea])
  })

  test("returns failure without throwing when no writer is available", async () => {
    const failures: string[] = []
    const restore = configureClipboard({
      onFailure: (failure) => failures.push(failure.description ?? failure.result.reason),
    })

    const result = await copyTextToClipboard("missing clipboard", {
      failureDescription: "Copy is unavailable.",
      environment: { isSecureContext: false },
    })

    restore()
    expect(result).toMatchObject({ ok: false, reason: "unavailable" })
    expect(failures).toEqual(["Copy is unavailable."])
  })

  test("copy controller resets copied state", async () => {
    const restore = configureClipboard({ writer: () => true })

    await new Promise<void>((resolve, reject) => {
      createRoot((dispose) => {
        queueMicrotask(async () => {
          try {
            const copy = createCopyController({
              text: "controlled copy",
              resetDelayMs: 1,
            })

            expect(copy.state()).toBe("idle")
            await copy.copy()
            expect(copy.state()).toBe("copied")
            await Bun.sleep(5)
            expect(copy.state()).toBe("idle")
            resolve()
          } catch (error) {
            reject(error)
          } finally {
            dispose()
          }
        })
      })
    })

    restore()
  })

  test("copy controller resets feedback when its payload identity changes", async () => {
    const restore = configureClipboard({ writer: () => true })

    await new Promise<void>((resolve, reject) => {
      createRoot((dispose) => {
        queueMicrotask(async () => {
          try {
            const copy = createCopyController({ text: "first payload" })

            await copy.copy()
            expect(copy.state()).toBe("copied")
            copy.reset()
            expect(copy.state()).toBe("idle")
            resolve()
          } catch (error) {
            reject(error)
          } finally {
            dispose()
          }
        })
      })
    })

    restore()
  })

  test("copy controller ignores an in-flight result after reset", async () => {
    let release!: () => void
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    const restore = configureClipboard({ writer: () => pending })

    await new Promise<void>((resolve, reject) => {
      createRoot((dispose) => {
        queueMicrotask(async () => {
          try {
            const copy = createCopyController({ text: "first payload" })
            const operation = copy.copy()
            copy.reset()
            release()
            await operation

            expect(copy.state()).toBe("idle")
            resolve()
          } catch (error) {
            reject(error)
          } finally {
            dispose()
          }
        })
      })
    })

    restore()
  })

  test("copy controller lets the latest overlapping copy own feedback", async () => {
    const releases: Array<() => void> = []
    const restore = configureClipboard({
      writer: () =>
        new Promise<void>((resolve) => {
          releases.push(resolve)
        }),
    })

    await new Promise<void>((resolve, reject) => {
      createRoot((dispose) => {
        queueMicrotask(async () => {
          try {
            const copy = createCopyController({ text: "payload", resetDelayMs: 10_000 })
            const first = copy.copy()
            const second = copy.copy()
            releases[1]()
            await second
            expect(copy.state()).toBe("copied")

            releases[0]()
            await first
            expect(copy.state()).toBe("copied")
            resolve()
          } catch (error) {
            reject(error)
          } finally {
            dispose()
          }
        })
      })
    })

    restore()
  })
})
