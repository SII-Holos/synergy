const punctuation =
  /[\u3001\u3002\uff0c\uff1b\uff01\uff1f\uff1a\u201c\u201d\u2018\u2019\u300c\u300d\u300e\u300f\u300a\u300b\u3010\u3011\uff08\uff09]/

export function bareUrlEnd(value: string): number {
  const boundary = value.search(punctuation)
  return boundary < 0 ? value.length : boundary
}

export function isBareUrlBoundary(value: string): boolean {
  return punctuation.test(value)
}
