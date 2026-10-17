import { ToolExposure } from "@ericsanchezok/synergy-harness/tool/exposure"
export function registerToolGroup() {
  ToolExposure.registerGroups("connections", [
    {
      id: "email",
      title: "Email",
      description:
        "Compose and send plain-text or HTML email, check inboxes, read messages and search mail via SMTP/IMAP.",
      tools: ["email_send", "email_read"],
    },
  ])
}
