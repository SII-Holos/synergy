import CONTENT from "./content.txt"

export const agentBrowser = {
  name: "agent-browser",
  description:
    "Browser automation for web testing, screenshots, and data extraction. Use when the user needs to navigate websites, interact with web pages, fill forms, take screenshots, or extract information from web pages. Triggers: 'open browser', 'browse', 'screenshot', 'fill form', 'click button', 'web scrape', 'test website'.",
  content: CONTENT,
  builtin: true as const,
}
