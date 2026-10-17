import { ToolExposure } from "@ericsanchezok/synergy-harness/tool/exposure"
export function registerToolGroup() {
  ToolExposure.registerGroups("workflows", [
    {
      id: "agenda",
      title: "Agenda",
      description:
        "Schedule reminders, delayed follow-ups and recurring tasks; inspect, update, cancel or trigger runs and read logs. React to GitHub PR, issue, workflow or check changes with event-driven watches rather than timed shell polling.",
      tools: [
        "agenda_schedule",
        "agenda_watch",
        "agenda_list",
        "agenda_update",
        "agenda_cancel",
        "agenda_trigger",
        "agenda_logs",
      ],
    },
  ])
}
