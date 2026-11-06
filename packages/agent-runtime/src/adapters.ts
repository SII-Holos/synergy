import type { RuntimeComponent } from "@ericsanchezok/synergy-harness/lifecycle"

export interface HttpAdapter {
  registerHttp(): void
}

export async function loadHttpAdapters(components: readonly RuntimeComponent[]): Promise<HttpAdapter[]> {
  return Promise.all(
    components
      .flatMap((component) => (component.adapters?.http ? [component.adapters.http] : []))
      .map(async (entry) => {
        const adapter: Partial<HttpAdapter> = await import(entry.href)
        if (typeof adapter.registerHttp !== "function") throw new Error(`HTTP adapter has no registrar: ${entry.href}`)
        return adapter as HttpAdapter
      }),
  )
}
