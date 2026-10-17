import { ToolExposure } from "@ericsanchezok/synergy-harness/tool/exposure"
export function registerToolGroup() {
  ToolExposure.registerGroups("browser-runtime", [
    {
      id: "browser",
      title: "Browser",
      description:
        "Inspect and interact with real browser pages, including JavaScript-heavy sites and localhost UI verification. Capture screenshots and downloads, click or type, and diagnose console, network and page state.",
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
