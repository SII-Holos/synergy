import { ToolExposure } from "@ericsanchezok/synergy-harness/tool/exposure"
export function registerToolGroup() {
  ToolExposure.registerGroups("connections", [
    {
      id: "email",
      title: "Email",
      description: "Compose, send, and read emails via SMTP/IMAP. Supports plain text and HTML mail.",
      whenToExpand:
        "Expand when the user asks to send an email, check inbox, read mail, or search for specific emails.",
      tools: ["email_send", "email_read"],
    },
  ])
}
