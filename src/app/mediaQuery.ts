export function subscribeMediaQuery(query: MediaQueryList | undefined, listener: () => void) {
  if (query?.addEventListener && query.removeEventListener) {
    query.addEventListener('change', listener)
    return () => query.removeEventListener('change', listener)
  }
  if (query?.addListener && query.removeListener) {
    query.addListener(listener)
    return () => query.removeListener(listener)
  }
  return () => {}
}
