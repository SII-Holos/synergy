export { startPluginPreview, type PluginPreviewOptions } from "./lib/preview.js"

import type { startPluginPreview } from "./lib/preview.js"

type Preview = Awaited<ReturnType<typeof startPluginPreview>>

/** Explicitly approve only artifacts supplied to this isolated test host. */
export async function approvePreviewPlugins(preview: Preview) {
  for (const plugin of preview.plugins) {
    const { data: review } = await preview.client.api.plugins.getApprovalReview(
      { pluginId: plugin.id },
      { throwOnError: true },
    )
    if (!review) throw new Error(`Approval review unavailable for ${plugin.id}`)
    await preview.client.api.plugins.approve(
      { target: review.target, reviewToken: review.reviewToken },
      { throwOnError: true },
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
