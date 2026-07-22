import { createCliRenderer, Text } from "@opentui/core"

const renderer = await createCliRenderer({
  exitOnCtrlC: false,
  screenMode: "main-screen",
  useMouse: false,
})
renderer.root.add(Text({ content: "Synergy TUI compile smoke" }))
renderer.destroy()
