export function pluginPreviewChanged(
  previous: readonly { pluginId: string; generation: string }[],
  next: readonly { pluginId: string; generation: string }[],
) {
  return next.some((entry) =>
    previous.some((current) => current.pluginId === entry.pluginId && current.generation !== entry.generation),
  )
}

export function pluginPreviewEnabled() {
  const flag = new URLSearchParams(window.location.search).get("plugin-preview")
  if (flag !== null) sessionStorage.setItem("synergy.plugin-preview", flag === "1" ? "1" : "0")
  return sessionStorage.getItem("synergy.plugin-preview") === "1"
}
