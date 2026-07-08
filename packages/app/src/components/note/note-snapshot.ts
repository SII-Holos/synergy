import type { NoteInfo } from "@ericsanchezok/synergy-sdk/client"
import { isDeepEqual } from "remeda"

type NoteSnapshotComparable = Pick<NoteInfo, "content" | "tags" | "title">

export type NoteSnapshotDelta = {
  contentChanged: boolean
  tagsChanged: boolean
  titleChanged: boolean
}

export function getNoteSnapshotDelta(
  current: NoteSnapshotComparable | null | undefined,
  snapshot: NoteSnapshotComparable,
): NoteSnapshotDelta {
  if (!current) {
    return {
      contentChanged: true,
      tagsChanged: true,
      titleChanged: true,
    }
  }

  return {
    contentChanged: !isDeepEqual(current.content, snapshot.content),
    tagsChanged: !isDeepEqual(current.tags ?? [], snapshot.tags ?? []),
    titleChanged: current.title !== snapshot.title,
  }
}
