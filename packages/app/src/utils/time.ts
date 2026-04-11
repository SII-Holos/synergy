export function absoluteDate(timestamp: number, includeYear = true): string {
  const d = new Date(timestamp)
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
  const month = months[d.getMonth()]
  const day = d.getDate()
  const hours = d.getHours().toString().padStart(2, "0")
  const mins = d.getMinutes().toString().padStart(2, "0")
  const now = new Date()
  if (includeYear && d.getFullYear() !== now.getFullYear()) {
    return `${month} ${day}, ${d.getFullYear()} at ${hours}:${mins}`
  }
  return `${month} ${day} at ${hours}:${mins}`
}

export function relativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp
  const seconds = Math.floor(Math.abs(diff) / 1000)
  const future = diff < 0

  if (seconds < 60) return future ? "in a moment" : "just now"
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return future ? `in ${minutes}m` : `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  if (hours < 24) {
    const hm = remainingMinutes === 0 ? `${hours}h` : `${hours}h ${remainingMinutes}m`
    return future ? `in ${hm}` : `${hm} ago`
  }
  const days = Math.floor(hours / 24)
  if (!future && days === 1) return "yesterday"
  if (future && days === 1) return "tomorrow"
  if (days < 7) return future ? `in ${days}d` : `${days}d ago`
  return absoluteDate(timestamp, false)
}
