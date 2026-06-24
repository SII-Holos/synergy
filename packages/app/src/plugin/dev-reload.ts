/**
 * Dev mode hot reload listener for plugin bundles.
 *
 * When the runtime reload target is "plugin", this module
 * listens for plugin reload events and shows a toast notification.
 *
 * This is a lightweight integration point — the actual reload trigger
 * needs Bus/SSE integration to detect when plugin bundles change on disk.
 */
export function initDevReload(serverUrl: string) {
  if (import.meta.env.DEV) {
    console.log("[plugin] dev reload listener active")
    // TODO: Subscribe to runtime events about plugin reloads
    // When a "plugin" reload target is received, show a toast:
    // showToast({
    //   type: "info",
    //   title: "Plugin reloaded",
    //   description: "A plugin bundle was updated and reloaded.",
    // })
  }
}
