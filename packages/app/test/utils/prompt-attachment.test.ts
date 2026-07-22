import { afterEach, describe, expect, test } from "bun:test"
import { uploadPromptAttachment, warmPromptAttachmentImagePipeline } from "../../src/utils/prompt-attachment"

const originalDocument = globalThis.document
const originalImage = globalThis.Image
const originalCreateObjectURL = URL.createObjectURL
const originalRevokeObjectURL = URL.revokeObjectURL

afterEach(() => {
  ;(globalThis as typeof globalThis & { document?: Document }).document = originalDocument
  ;(globalThis as typeof globalThis & { Image?: typeof Image }).Image = originalImage
  URL.createObjectURL = originalCreateObjectURL
  URL.revokeObjectURL = originalRevokeObjectURL
})

function uploadClient() {
  const files: File[] = []
  return {
    files,
    client: {
      asset: {
        upload: async ({ file }: { file?: unknown } = {}) => {
          if (!(file instanceof File)) throw new Error("missing file")
          files.push(file)
          const index = files.length
          return {
            data: {
              id: index === 1 ? file.name : "thumb.webp",
              url: index === 1 ? `asset://${file.name}` : "asset://thumb.webp",
              mime: file.type,
              size: file.size,
            },
          }
        },
      },
    },
  }
}

function installImageMocks() {
  const calls = {
    createObjectURL: 0,
    revokeObjectURL: 0,
    drawImage: 0,
    toBlobMimes: [] as string[],
  }

  URL.createObjectURL = () => {
    calls.createObjectURL++
    return "blob:prompt-attachment"
  }
  URL.revokeObjectURL = () => {
    calls.revokeObjectURL++
  }

  class MockImage {
    naturalWidth = 640
    naturalHeight = 320
    onload: (() => void) | null = null
    onerror: (() => void) | null = null

    set src(_value: string) {
      queueMicrotask(() => this.onload?.())
    }
  }

  ;(globalThis as typeof globalThis & { Image: typeof Image }).Image = MockImage as unknown as typeof Image
  ;(globalThis as typeof globalThis & { document: Document }).document = {
    createElement: (tagName: string) => {
      if (tagName !== "canvas") throw new Error(`unexpected element: ${tagName}`)
      return {
        width: 0,
        height: 0,
        getContext: () => ({
          imageSmoothingEnabled: false,
          imageSmoothingQuality: "low",
          clearRect: () => {},
          drawImage: () => {
            calls.drawImage++
          },
        }),
        toBlob: (callback: BlobCallback, mime: string) => {
          calls.toBlobMimes.push(mime)
          callback(new Blob(["thumb"], { type: mime }))
        },
      }
    },
  } as unknown as Document

  return calls
}

describe("prompt attachment upload", () => {
  test("uploads non-image files as lightweight asset URLs", async () => {
    const { client, files } = uploadClient()
    const uploaded = await uploadPromptAttachment(client, new File(["hello"], "notes.txt", { type: "text/plain" }))

    expect(files).toHaveLength(1)
    expect(uploaded).toEqual({
      url: "asset://notes.txt",
      mime: "text/plain",
      size: 5,
    })
    expect(JSON.stringify(uploaded)).not.toContain("data:")
  })

  test("uploads image thumbnails as separate assets for AttachmentCard previews", async () => {
    installImageMocks()
    const { client, files } = uploadClient()
    const uploaded = await uploadPromptAttachment(client, new File(["image"], "photo.jpg", { type: "image/jpeg" }))

    expect(files.map((file) => [file.name, file.type])).toEqual([
      ["photo.jpg", "image/jpeg"],
      ["photo.jpg.thumb.webp", "image/webp"],
    ])
    expect(uploaded.url).toBe("asset://photo.jpg")
    expect(uploaded.metadata).toEqual({
      thumbnail: {
        url: "asset://thumb.webp",
        mime: "image/webp",
        size: 5,
      },
    })
    expect(uploaded.presentation).toEqual({ renderer: "thumbnail", size: "small", crop: true })
  })

  test("warms image thumbnail pipeline without uploading assets", async () => {
    const calls = installImageMocks()
    const { files } = uploadClient()

    await warmPromptAttachmentImagePipeline()

    expect(files).toHaveLength(0)
    expect(calls.createObjectURL).toBe(1)
    expect(calls.revokeObjectURL).toBe(1)
    expect(calls.drawImage).toBe(1)
    expect(calls.toBlobMimes).toEqual(["image/png", "image/webp"])
  })
})
