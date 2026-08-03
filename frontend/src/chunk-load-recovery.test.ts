import { describe, expect, it, vi } from 'vitest'
import {
  clearStaleChunkReloadGuard,
  isStaleChunkError,
  lazyRoute,
  recoverFromStaleChunkError,
} from './chunk-load-recovery'

function memoryStorage(seed: Record<string, string> = {}) {
  const data = new Map(Object.entries(seed))
  return {
    getItem: (key: string) => (data.has(key) ? data.get(key)! : null),
    setItem: (key: string, value: string) => { data.set(key, value) },
    removeItem: (key: string) => { data.delete(key) },
    data,
  }
}

describe('isStaleChunkError', () => {
  it('detects the production console failure mode', () => {
    expect(isStaleChunkError(
      new TypeError('Failed to fetch dynamically imported module: https://agent-erik-app.web.app/assets/AssistantPage-B8RGSlD0.js'),
    )).toBe(true)
    expect(isStaleChunkError(
      new Error('Failed to load module script: Expected a JavaScript-or-Wasm module script but the server responded with a MIME type of "text/html"'),
    )).toBe(true)
    expect(isStaleChunkError(new Error('Loading chunk 5 failed'))).toBe(true)
  })

  it('ignores unrelated errors', () => {
    expect(isStaleChunkError(new Error('Network request failed'))).toBe(false)
    expect(isStaleChunkError(new Error('Permission denied'))).toBe(false)
    expect(isStaleChunkError(null)).toBe(false)
  })
})

describe('recoverFromStaleChunkError', () => {
  it('reloads once for a stale chunk and blocks a tight loop', () => {
    const storage = memoryStorage()
    const location = { reload: vi.fn() }
    const now = 1_700_000_000_000

    expect(recoverFromStaleChunkError(
      new TypeError('Failed to fetch dynamically imported module: https://example/assets/X.js'),
      { storage, location, now },
    )).toBe(true)
    expect(location.reload).toHaveBeenCalledTimes(1)

    expect(recoverFromStaleChunkError(
      new TypeError('Failed to fetch dynamically imported module: https://example/assets/X.js'),
      { storage, location, now: now + 1_000 },
    )).toBe(false)
    expect(location.reload).toHaveBeenCalledTimes(1)

    expect(recoverFromStaleChunkError(
      new TypeError('Failed to fetch dynamically imported module: https://example/assets/X.js'),
      { storage, location, now: now + 20_000 },
    )).toBe(true)
    expect(location.reload).toHaveBeenCalledTimes(2)
  })

  it('does not reload for non-chunk errors', () => {
    const storage = memoryStorage()
    const location = { reload: vi.fn() }
    expect(recoverFromStaleChunkError(new Error('boom'), { storage, location })).toBe(false)
    expect(location.reload).not.toHaveBeenCalled()
  })

  it('clears the guard after a successful boot', () => {
    const storage = memoryStorage({ 'erik:stale-chunk-reload': '1' })
    clearStaleChunkReloadGuard(storage)
    expect(storage.getItem('erik:stale-chunk-reload')).toBeNull()
  })
})

describe('lazyRoute', () => {
  it('reloads when the dynamic import fails as a stale chunk', async () => {
    const storage = memoryStorage()
    const location = { reload: vi.fn() }
    const load = lazyRoute(async () => {
      throw new TypeError('Failed to fetch dynamically imported module: /assets/Page.js')
    })

    // Inject test doubles by recovering through the shared helpers path:
    // recover is called inside lazyRoute with defaults; patch globalThis sessionStorage/location.
    const originalStorage = globalThis.sessionStorage
    const originalLocation = globalThis.location
    Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: storage })
    Object.defineProperty(globalThis, 'location', {
      configurable: true,
      value: location,
    })
    try {
      const pending = load()
      // Never resolves while reload is in flight.
      await Promise.race([
        pending.then(() => 'resolved'),
        new Promise((resolve) => setTimeout(() => resolve('pending'), 20)),
      ]).then((result) => {
        expect(result).toBe('pending')
      })
      expect(location.reload).toHaveBeenCalledTimes(1)
    } finally {
      Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: originalStorage })
      Object.defineProperty(globalThis, 'location', { configurable: true, value: originalLocation })
    }
  })

  it('rethrows non-chunk failures', async () => {
    const load = lazyRoute(async () => {
      throw new Error('Permission denied')
    })
    await expect(load()).rejects.toThrow('Permission denied')
  })
})
