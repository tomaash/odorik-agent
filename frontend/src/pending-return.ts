const storageKey = 'pendingAppReturnPath'

export function safeAppReturnPath(value: unknown): string | null {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) return null
  return value
}

export function rememberAppReturnPath(path: string, storage: Storage = sessionStorage) {
  const safe = safeAppReturnPath(path)
  if (safe && safe !== '/login') storage.setItem(storageKey, safe)
}

export function takeAppReturnPath(storage: Storage = sessionStorage): string | null {
  const path = safeAppReturnPath(storage.getItem(storageKey))
  storage.removeItem(storageKey)
  return path
}
