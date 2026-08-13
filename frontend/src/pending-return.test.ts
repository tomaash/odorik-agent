import { describe, expect, it } from 'vitest'
import { rememberAppReturnPath, safeAppReturnPath, takeAppReturnPath } from './pending-return'

function memoryStorage() {
  const data = new Map<string, string>()
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value) },
    removeItem: (key: string) => { data.delete(key) },
  } as Storage
}

describe('approval return paths', () => {
  it('preserves an exact internal approval route across authentication once', () => {
    const storage = memoryStorage()
    rememberAppReturnPath('/approvals/approval_123?from=slack', storage)
    expect(takeAppReturnPath(storage)).toBe('/approvals/approval_123?from=slack')
    expect(takeAppReturnPath(storage)).toBeNull()
  })

  it('rejects external, protocol-relative, and login-loop destinations', () => {
    expect(safeAppReturnPath('https://evil.example/approvals/1')).toBeNull()
    expect(safeAppReturnPath('//evil.example/approvals/1')).toBeNull()
    const storage = memoryStorage()
    rememberAppReturnPath('/login', storage)
    expect(takeAppReturnPath(storage)).toBeNull()
  })
})
