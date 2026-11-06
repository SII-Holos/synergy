import { capability, definePlugin, shell, skin } from "@ericsanchezok/synergy-plugin"

const access = [
  "ui.shell",
  "ui.hostActions",
  "session.read",
  "session.submit",
  "session.control",
  "composer.read",
  "composer.write",
]
export default definePlugin({
  id: "ui5-workbench",
  version: "0.1.0",
  description: "A custom Synergy workbench",
  assets: [{ source: "assets/Inter-LICENSE.txt", target: "assets/Inter-LICENSE.txt" }],
  capabilities: access.map((id) => capability(id)),
  contributions: [
    skin({ id: "paper", label: "Paper Studio", path: "skins/paper.json" }),
    skin({ id: "observatory", label: "Observatory", path: "skins/observatory.json" }),
    shell({
      id: "main",
      label: "Studio",
      requires: access,
      component: { source: "./src/ui.tsx" },
      pages: { session: { source: "./src/session.tsx" } },
    }),
  ],
})
