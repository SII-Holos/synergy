/** Runtime Lingui descriptors for agenda host labels and wrappers.
 *  Translate at use time via `useLocale().i18n._(descriptor)`. */

export const A = {
  // panel.tsx — header, tabs, detail popover, action buttons
  panelTitle: { id: "app.agenda.panel.title", message: "Agenda" },
  newAgenda: { id: "app.agenda.panel.newAgenda", message: "New Agenda" },
  editAgenda: { id: "app.agenda.panel.editAgenda", message: "Edit Agenda" },
  scheduleTab: { id: "app.agenda.panel.tab.schedule", message: "Schedule" },
  activityTab: { id: "app.agenda.panel.tab.activity", message: "History" },
  todoLabel: { id: "app.agenda.panel.todoLabel", message: "Todo" },
  noTodoItems: { id: "app.agenda.panel.noTodoItems", message: "No todo items" },

  // trigger summaries
  triggerManual: { id: "app.agenda.trigger.manual", message: "Manual" },
  triggerCron: { id: "app.agenda.trigger.cron", message: "cron: {expr}" },
  triggerEvery: { id: "app.agenda.trigger.every", message: "every {interval}" },
  triggerAt: { id: "app.agenda.trigger.at", message: "at {time}" },
  triggerDelay: { id: "app.agenda.trigger.delay", message: "delay {delay}" },
  triggerPoll: { id: "app.agenda.trigger.poll", message: "poll: {command}" },
  triggerTool: { id: "app.agenda.trigger.tool", message: "tool: {tool}" },
  triggerWatch: { id: "app.agenda.trigger.watch", message: "watch: {glob}" },
  triggerUnknown: { id: "app.agenda.trigger.unknown", message: "unknown" },

  // detail popover
  detailEdit: { id: "app.agenda.detail.edit", message: "Edit" },
  detailDelete: { id: "app.agenda.detail.delete", message: "Delete" },
  detailClose: { id: "app.agenda.detail.close", message: "Close" },
  detailRuns: { id: "app.agenda.detail.runs", message: "{count, plural, one {# run} other {# runs}}" },
  detailErrors: { id: "app.agenda.detail.errors", message: "{count, plural, one {# error} other {# errors}}" },
  detailAgent: { id: "app.agenda.detail.agent", message: "agent" },
  detailNext: { id: "app.agenda.detail.next", message: "Next: {time}" },
  detailLastRun: { id: "app.agenda.detail.lastRun", message: "Last run: {date}" },
  detailTaskLabel: { id: "app.agenda.detail.taskLabel", message: "Task" },
  detailAgentLabel: { id: "app.agenda.detail.agentLabel", message: "Agent: {agent}" },
  detailRecentRuns: { id: "app.agenda.detail.recentRuns", message: "Recent runs" },
  detailCreated: { id: "app.agenda.detail.created", message: "Created {date}" },
  detailUpdated: { id: "app.agenda.detail.updated", message: "updated {date}" },

  // action buttons
  actionTrigger: { id: "app.agenda.action.trigger", message: "Trigger" },
  actionActivate: { id: "app.agenda.action.activate", message: "Activate" },
  actionPause: { id: "app.agenda.action.pause", message: "Pause" },
  actionComplete: { id: "app.agenda.action.complete", message: "Complete" },
  actionCancel: { id: "app.agenda.action.cancel", message: "Cancel" },
  actionFailed: { id: "app.agenda.action.failed", message: "Agenda action failed" },
  actionRequestFailed: { id: "app.agenda.action.requestFailed", message: "Request failed" },

  // activity-view.tsx
  activitySearchPlaceholder: {
    id: "app.agenda.activity.searchPlaceholder",
    message: "Search history, agenda title, errors...",
  },
  activityRuns: { id: "app.agenda.activity.runs", message: "{count, plural, one {# run} other {# runs}}" },
  activityNoHistory: { id: "app.agenda.activity.noHistory", message: "No history found" },
  activityLoadMore: { id: "app.agenda.activity.loadMore", message: "Load more" },
  activitySessionReady: { id: "app.agenda.activity.sessionReady", message: "session ready" },
  activityRunError: { id: "app.agenda.activity.runError", message: "Run error" },

  // activity-state.ts
  activityUnavailable: {
    id: "app.agenda.activity.unavailable",
    message: "Activity endpoint is unavailable on the running server instance",
  },
  activityUnavailableShort: {
    id: "app.agenda.activity.unavailableShort",
    message: "Activity is unavailable right now",
  },

  // form.tsx
  formBack: { id: "app.agenda.form.back", message: "Back" },
  formCancel: { id: "app.agenda.form.cancel", message: "Cancel" },
  formSave: { id: "app.agenda.form.save", message: "Save" },
  formCreate: { id: "app.agenda.form.create", message: "Create" },
  formTitle: { id: "app.agenda.form.title", message: "Title" },
  formTitlePlaceholder: { id: "app.agenda.form.titlePlaceholder", message: "Add title" },
  formTitleRequired: { id: "app.agenda.form.titleRequired", message: "Title is required" },
  formSchedule: { id: "app.agenda.form.schedule", message: "Schedule" },
  formAddTime: { id: "app.agenda.form.addTime", message: "Add time" },
  formRepeat: { id: "app.agenda.form.repeat", message: "Repeat" },
  formRepeatOff: { id: "app.agenda.form.repeatOff", message: "Does not repeat" },
  formRepeatCustom: { id: "app.agenda.form.repeatCustom", message: "Custom cron" },
  formRepeatEvery: { id: "app.agenda.form.repeatEvery", message: "Every" },
  formRepeatInterval: { id: "app.agenda.form.repeatInterval", message: "Interval" },
  formRepeatCron: { id: "app.agenda.form.repeatCron", message: "Cron" },
  formRepeatOffChip: { id: "app.agenda.form.repeatOffChip", message: "Off" },
  formDescription: { id: "app.agenda.form.description", message: "Description" },
  formTags: { id: "app.agenda.form.tags", message: "Tags" },
  formAdvanced: { id: "app.agenda.form.advanced", message: "Advanced" },
  formScope: { id: "app.agenda.form.scope", message: "Scope" },
  formScopeSelect: { id: "app.agenda.form.scopeSelect", message: "Select scope" },
  formScopeCurrent: { id: "app.agenda.form.scopeCurrent", message: "{name} (current)" },
  formScopeHome: { id: "app.agenda.form.scopeHome", message: "Home" },
  formCronLabel: { id: "app.agenda.form.cronLabel", message: "Cron expression" },
  formCronPlaceholder: { id: "app.agenda.form.cronPlaceholder", message: "Enter cron expression" },
  formTzLabel: { id: "app.agenda.form.tzLabel", message: "Timezone (optional)" },
  formSaveFailed: { id: "app.agenda.form.saveFailed", message: "Failed to save" },
  formAgentPlaceholder: { id: "app.agenda.form.agentPlaceholder", message: "Optional agent" },
  formPromptPlaceholder: { id: "app.agenda.form.promptPlaceholder", message: "Enter task prompt" },
  formPromptLabel: { id: "app.agenda.form.promptLabel", message: "Prompt" },
  formToday: { id: "app.agenda.form.today", message: "Today" },
  formCronDetailedPlaceholder: {
    id: "app.agenda.form.cronDetailedPlaceholder",
    message: "Cron expression, e.g. 0 9 * * 1-5",
  },
  formTzDetailedPlaceholder: {
    id: "app.agenda.form.tzDetailedPlaceholder",
    message: "Timezone (e.g. Asia/Shanghai)",
  },
  formPromptDetailedPlaceholder: {
    id: "app.agenda.form.promptDetailedPlaceholder",
    message: "What should the agent do?",
  },
  formAddDescription: { id: "app.agenda.form.addDescription", message: "Add description" },
  formDescriptionPlaceholder: { id: "app.agenda.form.descriptionPlaceholder", message: "Description..." },
  formAddTags: { id: "app.agenda.form.addTags", message: "Add tags" },
  formTagsPlaceholder: { id: "app.agenda.form.tagsPlaceholder", message: "tag1, tag2, ..." },
  formIntervalChip: { id: "app.agenda.form.intervalChip", message: "Interval" },
  formCronChip: { id: "app.agenda.form.cronChip", message: "Cron" },
  formAdvancedTitle: { id: "app.agenda.form.advancedTitle", message: "Advanced settings" },
  formAdvancedSubtitle: { id: "app.agenda.form.advancedSubtitle", message: "Scope and run options." },
  formScopeLabel: { id: "app.agenda.form.scopeLabel", message: "Scope" },
  formAgentLabel: { id: "app.agenda.form.agentLabel", message: "Agent" },

  // interval units
  intervalMinutes: { id: "app.agenda.interval.minutes", message: "minutes" },
  intervalHours: { id: "app.agenda.interval.hours", message: "hours" },
  intervalDays: { id: "app.agenda.interval.days", message: "days" },
  intervalWeeks: { id: "app.agenda.interval.weeks", message: "weeks" },

  // calendar.tsx
  calendarToday: { id: "app.agenda.calendar.today", message: "Today" },
  calendarDay: { id: "app.agenda.calendar.day", message: "Day" },
  calendarWeek: { id: "app.agenda.calendar.week", message: "Week" },
  calendarMonth: { id: "app.agenda.calendar.month", message: "Month" },
  calendarMore: { id: "app.agenda.calendar.more", message: "+{count} more" },

  // shared.ts — duration formatting
  durationMs: { id: "app.agenda.duration.ms", message: "{count}ms" },
  durationSeconds: { id: "app.agenda.duration.seconds", message: "{count}s" },
  durationMinSec: { id: "app.agenda.duration.minSec", message: "{m}m {s}s" },
  durationMinutes: { id: "app.agenda.duration.minutes", message: "{count}m" },
  durationHourMin: { id: "app.agenda.duration.hourMin", message: "{h}h {m}m" },
  durationHours: { id: "app.agenda.duration.hours", message: "{count}h" },
}
