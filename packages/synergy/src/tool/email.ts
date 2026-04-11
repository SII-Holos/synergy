import z from "zod"
import { Tool } from "./tool"
import { Email } from "@/email/service"
import DESCRIPTION from "./email.txt"

const parameters = z.object({
  to: z
    .union([z.string(), z.array(z.string())])
    .describe("Recipient email address(es). A single address, comma-separated string, or array of addresses"),
  subject: z.string().describe("Email subject line"),
  body: z.string().describe("Email body in plain text"),
  html: z.string().optional().describe("Optional HTML version of the email body for rich formatting"),
})

export const EmailTool = Tool.define("email", {
  description: DESCRIPTION,
  parameters,
  async execute(params, ctx) {
    const recipients = Array.isArray(params.to) ? params.to.join(", ") : params.to

    await ctx.ask({
      permission: "email",
      patterns: [recipients],
      metadata: {
        to: recipients,
        subject: params.subject,
      },
    })

    const result = await Email.send({
      to: recipients,
      subject: params.subject,
      text: params.body,
      html: params.html,
    })

    return {
      title: `Email to ${recipients}`,
      output: `Email sent successfully.\nMessage ID: ${result.messageId}\nTo: ${recipients}\nSubject: ${params.subject}`,
      metadata: {
        truncated: false,
        messageId: result.messageId,
        to: recipients,
        subject: params.subject,
      },
    }
  },
})
