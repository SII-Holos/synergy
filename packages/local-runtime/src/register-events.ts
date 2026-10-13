import { BusEvent } from "@ericsanchezok/synergy-harness/bus/bus-event"
import { Pty } from "./process/pty"
import { File } from "./file"
import { FileWatcherEvent } from "./file/watcher-event"
import { Question } from "./question"
import { Command } from "./command/command"
import { RuntimeReload } from "./reload"

export function registerLocalEvents() {
  BusEvent.register(
    ...Object.values(Pty.Event),
    ...Object.values(File.Event),
    ...Object.values(FileWatcherEvent),
    ...Object.values(Question.Event),
    ...Object.values(Command.Event),
    ...Object.values(RuntimeReload.Event),
  )
}
