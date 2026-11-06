import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import {
  configureClipboard,
  copyImageToClipboard,
  copyTextToClipboard,
  createCopyController,
} from "../../src/components/clipboard-core"

class ImageClipboardItem {
  constructor(readonly data: Record<string, Promise<Blob>>) {}
}

function imageEnvironment(write: (items: ImageClipboardItem[]) => Promise<void>) {
  return {
    isSecureContext: true,
    navigator: { clipboard: { write } } as unknown as Pick<Navigator, "clipboard">,
    ClipboardItem: ImageClipboardItem as unknown as typeof ClipboardItem,
  }
}

describe("clipboard", () => {
  test("admits image writing before decoding finishes and preserves PNG bytes", async () => {
    const pending = Promise.withResolvers<Blob>()
    const writes: Promise<Blob>[] = []
    const blobs: Blob[] = []
    const operation = copyImageToClipboard(
      () => pending.promise,
      imageEnvironment(async (items) => {
        expect(items).toHaveLength(1)
        expect(Object.keys(items[0].data)).toEqual(["image/png"])
        writes.push(items[0].data["image/png"])
        blobs.push(await items[0].data["image/png"])
      }),
    )
    expect(writes).toHaveLength(1)
    expect(blobs).toHaveLength(0)
    const png = new Blob([new Uint8Array([0, 1, 2, 255])], { type: "image/png" })
    pending.resolve(png)
    expect(await operation).toEqual({ ok: true, method: "navigator" })
    expect(blobs[0]).toBe(png)
  })

  test("unavailable image copying does not decode or fall back to a text writer", async () => {
    let reads = 0
    let textWrites = 0
    const restore = configureClipboard({
      writer: () => {
        textWrites++
      },
    })
    try {
      const load = async () => {
        reads++
        return new Blob()
      }
      expect(await copyImageToClipboard(load, { isSecureContext: false })).toEqual({ ok: false, reason: "unavailable" })
      expect(await copyImageToClipboard(load, { isSecureContext: true })).toEqual({ ok: false, reason: "unavailable" })
      expect(reads).toBe(0)
      expect(textWrites).toBe(0)
    } finally {
      restore()
    }
  })

  test("image conversion failure remains an operation failure", async () => {
    const error = new Error("PNG conversion failed")
    const result = await copyImageToClipboard(
      async () => {
        throw error
      },
      imageEnvironment(async (items) => {
        await items[0].data["image/png"]
      }),
    )
    expect(result).toEqual({ ok: false, reason: "failed", error })
  })

  test("denied image admission observes a later conversion rejection", async () => {
    const pending = Promise.withResolvers<Blob>()
    const error = new Error("Clipboard denied")
    const operation = copyImageToClipboard(
      () => pending.promise,
      imageEnvironment(async () => {
        throw error
      }),
    )
    expect(await operation).toEqual({ ok: false, reason: "failed", error })
    pending.reject(new Error("Conversion cancelled after admission failed"))
    await Bun.sleep(0)
  })

  test("copy fetches original text on demand and retains failed feedback", async () => {
    const copied: string[] = []
    const restore = configureClipboard({
      writer: (value) => {
        copied.push(value)
      },
    })
    try {
      await new Promise<void>((resolve, reject) =>
        createRoot((dispose) => {
          queueMicrotask(async () => {
            try {
              let reads = 0
              const copy = createCopyController({
                text: "mounted excerpt",
                loadText: async () => {
                  reads++
                  return "entire original history"
                },
              })
              expect(reads).toBe(0)
              expect(copy.disabled()).toBe(false)
              await copy.copy()
              expect(copied).toEqual(["entire original history"])
              const failed = createCopyController({
                text: "",
                loadText: async () => {
                  throw new Error("read failed")
                },
              })
              await failed.copy()
              expect(failed.state()).toBe("failed")
              resolve()
            } catch (error) {
              reject(error)
            } finally {
              dispose()
            }
          })
        }),
      )
    } finally {
      restore()
    }
  })
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
