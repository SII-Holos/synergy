/**
 * Parse the starttime (field 22) from /proc/<pid>/stat output.
 *
 * Field 2 (comm) is parenthesized and may contain spaces, so we split
 * from the last ')' rather than naively splitting on spaces.
 *
 * Returns the starttime value in jiffies, or undefined if parsing fails.
 */
export function parseProcStatStarttime(stat: string): number | undefined {
  const lastParen = stat.lastIndexOf(")")
  if (lastParen === -1) return undefined
  const afterComm = stat.slice(lastParen + 2).trim()
  const fields = afterComm.split(" ")
  // After comm, fields are: state, ppid, pgrp, session, tty_nr, tpgid,
  // flags, minflt, cminflt, majflt, cmajflt, utime, stime, cutime,
  // cstime, priority, nice, num_threads, itrealvalue, starttime (field 22)
  // That's field index 19 in the afterComm split (0-indexed)
  const starttime = parseInt(fields[19], 10)
  return isNaN(starttime) ? undefined : starttime
}
