export { startPluginPreview, type PluginPreviewOptions } from "./lib/preview.js"

import type { startPluginPreview } from "./lib/preview.js"

type Preview = Awaited<ReturnType<typeof startPluginPreview>>

/** Explicitly approve only artifacts supplied to this isolated test host. */
export async function approvePreviewPlugins(preview: Preview, options: { timeoutMs?: number } = {}) {
  async function request<T>(pluginId: string, action: string, call: (signal: AbortSignal) => Promise<T>) {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        call(controller.signal),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            const error = new Error(`Preview ${action} timed out for ${pluginId}`)
            controller.abort(error)
            reject(error)
          }, options.timeoutMs ?? 15000)
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
  }
  for (const plugin of preview.plugins) {
    const { data: review } = await request(plugin.id, "approval review", (signal) =>
      preview.client.api.plugins.getApprovalReview({ pluginId: plugin.id }, { throwOnError: true, signal }),
    )
    if (!review) throw new Error(`Approval review unavailable for ${plugin.id}`)
    await request(plugin.id, "approval", (signal) =>
      preview.client.api.plugins.approve(
        { target: review.target, reviewToken: review.reviewToken },
        { throwOnError: true, signal },
      ),
    )
  }
}

export interface PluginBrowserPage {
  goto(url: string): Promise<unknown>
  on(event: "pageerror", listener: (error: Error) => void): unknown
  off(event: "pageerror", listener: (error: Error) => void): unknown
}

/** Use a caller-owned Playwright page against the production host. */
export async function openPluginPreviewPage(preview: Preview, page: PluginBrowserPage) {
  const errors: Error[] = []
  const listener = (error: Error) => errors.push(error)
  page.on("pageerror", listener)
  try {
    await page.goto(preview.url)
  } catch (error) {
    page.off("pageerror", listener)
    throw error
  }
  return { errors, dispose: () => page.off("pageerror", listener) }
}
