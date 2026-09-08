import { ToolExposure } from "@ericsanchezok/synergy-harness/tool/exposure"
export function registerToolGroup() {
  ToolExposure.registerGroups("browser-runtime", [
    {
      id: "browser",
      title: "Browser",
      description:
        "Interactive browser automation, page inspection, screenshots, downloads, console and network diagnostics.",
      whenToExpand:
        "Expand when a task needs a real browser: JS-heavy sites, localhost UI verification, screenshots, clicking, typing, page state inspection, or browser debugging.",
      tools: [
        "browser_annotate",
        "browser_navigation",
        "browser_snapshot",
        "browser_screenshot",
        "browser_inspect",
        "browser_wait",
        "browser_action",
        "browser_console",
        "browser_network",
        "browser_downloads",
        "browser_read",
        "browser_clipboard",
        "browser_eval",
        "browser_view",
        "browser_assets",
        "browser_performance",
        "browser_audit",
        "browser_emulate",
        "browser_dialog",
        "browser_upload",
      ],
    },
  ])
}
