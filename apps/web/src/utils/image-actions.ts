import { createSynergyClient } from "@ericsanchezok/synergy-sdk/client"
import { AssetReference } from "@ericsanchezok/synergy-util/asset-reference"
import { copyImageToClipboard, copyTextToClipboard } from "@ericsanchezok/synergy-ui/clipboard-core"
import type { ImagePreviewImage } from "@ericsanchezok/synergy-ui/image-preview"
import type { ImageViewerActions } from "@ericsanchezok/synergy-ui/image-viewer"
import type { BrowserNativeViewBridge } from "@/context/platform"
import type { MessageDescriptor } from "@lingui/core"

export function createImageActions(options: {
  serverUrl: () => string
  fetcher?: typeof fetch
  fileAction?: BrowserNativeViewBridge["fileAction"]
  openLink?: (url: string) => void
  translate: (descriptor: MessageDescriptor) => string
}): ImageViewerActions {
  const _ = options.translate
  const unavailable = () =>
    new Error(
      _({ id: "app.imageActions.unavailable", message: "Image data is unavailable. Retry or open the source." }),
    )
  async function read(image: Readonly<ImagePreviewImage>, signal: AbortSignal) {
    signal.throwIfAborted()
    const href = image.downloadUrl ?? image.src
    const server = new URL(options.serverUrl())
    const url = new URL(href, server)
    const assetPrefix = `${server.pathname.replace(/\/$/, "")}/asset/`
    const id =
      url.origin === server.origin && url.pathname.startsWith(assetPrefix)
        ? url.pathname.slice(assetPrefix.length)
        : undefined
    let blob: Blob
    if (id && AssetReference.isValidId(id)) {
      const client = createSynergyClient({ baseUrl: options.serverUrl(), fetch: options.fetcher, throwOnError: true })
      const response = await client.asset.get({ id }, { parseAs: "blob", signal })
      if (!(response.data instanceof Blob)) throw unavailable()
      blob = response.data
    } else {
      const response = await (options.fetcher ?? fetch)(
        new Request(url, { signal, credentials: url.origin === server.origin ? "same-origin" : "omit" }),
      )
      if (!response.ok)
        throw new Error(
          `${_({ id: "app.imageActions.readFailed", message: "Could not read the image. Retry or open the source." })} (${response.status})`,
        )
      blob = await response.blob()
    }
    signal.throwIfAborted()
    if (!blob.size) throw unavailable()
    return blob
  }
  async function native(
    operation: "save" | "copyImage",
    image: Readonly<ImagePreviewImage>,
    blob: Blob,
    signal: AbortSignal,
  ) {
    const data = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      const abort = () => reader.abort()
      signal.addEventListener("abort", abort, { once: true })
      reader.onloadend = () => signal.removeEventListener("abort", abort)
      reader.onerror = () => reject(reader.error ?? unavailable())
      reader.onabort = () => reject(signal.reason)
      reader.onload = () => resolve(String(reader.result).split(",")[1]!)
      reader.readAsDataURL(blob)
    })
    signal.throwIfAborted()
    const result = await options.fileAction!({
      operation,
      filename: image.filename,
      mime: operation === "copyImage" ? "image/png" : image.mime,
      data,
    })
    return result.cancelled ? ("cancelled" as const) : ("completed" as const)
  }
  async function png(image: Readonly<ImagePreviewImage>, signal: AbortSignal) {
    const blob = await read(image, signal)
    const url = URL.createObjectURL(blob)
    const source = new Image()
    const abort = () => {
      source.src = ""
    }
    signal.addEventListener("abort", abort, { once: true })
    try {
      source.src = url
      await source.decode()
      signal.throwIfAborted()
      const canvas = document.createElement("canvas")
      canvas.width = source.naturalWidth
      canvas.height = source.naturalHeight
      const context = canvas.getContext("2d")
      if (!context) throw unavailable()
      context.drawImage(source, 0, 0)
      const result = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"))
      signal.throwIfAborted()
      if (!result) throw unavailable()
      return result
    } finally {
      signal.removeEventListener("abort", abort)
      URL.revokeObjectURL(url)
    }
  }
  return {
    async save(image, signal) {
      const blob = await read(image, signal)
      if (options.fileAction) return native("save", image, blob, signal)
      signal.throwIfAborted()
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement("a")
      anchor.href = url
      anchor.download = image.filename.split(/[\\/]/).at(-1) || "image"
      document.body.appendChild(anchor)
      try {
        anchor.click()
      } finally {
        anchor.remove()
        setTimeout(() => URL.revokeObjectURL(url), 60000)
      }
      return "dispatched"
    },
    async copy(image, signal) {
      signal.throwIfAborted()
      if (options.fileAction) return native("copyImage", image, await png(image, signal), signal)
      const result = await copyImageToClipboard(() => png(image, signal))
      if (!result.ok)
        throw (
          result.error ??
          new Error(
            _({
              id: "app.imageActions.clipboardUnavailable",
              message: "Image copying is unavailable here. Save the image instead.",
            }),
          )
        )
      return "completed"
    },
    async copyLink(image, signal) {
      signal.throwIfAborted()
      const href = image.externalUrl ?? image.src
      if (!/^https?:/i.test(href)) throw unavailable()
      const result = await copyTextToClipboard(href, { notifyFailure: false })
      if (!result.ok)
        throw new Error(_({ id: "app.imageActions.linkCopyFailed", message: "Could not copy the link. Try again." }))
      return "completed"
    },
    openExternal: options.openLink
      ? async (image, signal) => {
          signal.throwIfAborted()
          const href = image.externalUrl ?? image.src
          if (!/^https?:/i.test(href)) throw unavailable()
          options.openLink!(href)
          return "dispatched"
        }
      : undefined,
  }
}
