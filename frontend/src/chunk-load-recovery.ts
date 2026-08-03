const RELOAD_KEY = 'erik:stale-chunk-reload'
const RELOAD_COOLDOWN_MS = 15_000

/** Detect Vite/webpack-style failures when a hashed asset is gone after deploy. */
export function isStaleChunkError(error: unknown): boolean {
  if (error == null) return false
  const message = error instanceof Error
    ? error.message
    : typeof error === 'string'
      ? error
      : String(error)
  const text = message.toLowerCase()
  return (
    text.includes('failed to fetch dynamically imported module')
    || text.includes('error loading dynamically imported module')
    || text.includes('importing a module script failed')
    || text.includes('failed to load module script')
    || text.includes('expected a javascript-or-wasm module script')
    || text.includes('loading css chunk')
    || text.includes('loading chunk')
    || text.includes('chunkloaderror')
  )
}

export type ChunkReloadStorage = {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export type ChunkReloadLocation = {
  reload(): void
}

/**
 * Reload once after a stale chunk error so the browser picks up a fresh index.html
 * with current asset hashes. Guarded to avoid reload loops if recovery fails.
 * Returns true when a reload was triggered.
 */
export function recoverFromStaleChunkError(
  error: unknown,
  options: {
    storage?: ChunkReloadStorage
    location?: ChunkReloadLocation
    now?: number
  } = {},
): boolean {
  if (!isStaleChunkError(error)) return false
  const storage = options.storage ?? (typeof sessionStorage === 'undefined' ? null : sessionStorage)
  const location = options.location ?? (typeof window === 'undefined' ? null : window.location)
  if (!storage || !location) return false

  const now = options.now ?? Date.now()
  const previous = Number(storage.getItem(RELOAD_KEY) || 0)
  if (Number.isFinite(previous) && previous > 0 && now - previous < RELOAD_COOLDOWN_MS) {
    return false
  }
  storage.setItem(RELOAD_KEY, String(now))
  location.reload()
  return true
}

/** Clear the guard after a successful boot so a later deploy can recover again. */
export function clearStaleChunkReloadGuard(
  storage: ChunkReloadStorage | null = typeof sessionStorage === 'undefined' ? null : sessionStorage,
): void {
  storage?.removeItem(RELOAD_KEY)
}

/**
 * Wrap a route-level dynamic import so a missing post-deploy chunk reloads the app
 * instead of leaving the menu navigation broken.
 */
export function lazyRoute<T>(loader: () => Promise<T>): () => Promise<T> {
  return () => loader().catch((error: unknown) => {
    if (recoverFromStaleChunkError(error)) {
      // Navigation waits until the reload replaces the document.
      return new Promise<T>(() => undefined)
    }
    throw error
  })
}
