import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const PORTS = [9099, 8085, 5001, 5005, 4041, 5173]
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const functionsDir = path.join(root, 'functions')

console.log('[stop] Exporting emulator data before shutdown...')
try {
  // Must match functions/package.json serve import/export path (cwd: functions/).
  execSync('npx firebase emulators:export ./.emulator-data', {
    cwd: functionsDir,
    stdio: 'inherit',
  })
} catch {
  // If export fails (e.g. emulators not active), proceed to cleanup
}

try {
  const portsArg = PORTS.join(',')
  const stdout = execSync(`lsof -tiTCP:${portsArg} -sTCP:LISTEN`, {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'ignore'],
  }).trim()

  if (stdout) {
    const pids = stdout
      .split('\n')
      .map((p) => p.trim())
      .filter(Boolean)

    if (pids.length > 0) {
      console.log(`[stop] Sending graceful shutdown signal (SIGINT) to PIDs: ${pids.join(', ')}...`)
      execSync(`kill -INT ${pids.join(' ')}`, { stdio: 'ignore' })
    }
  } else {
    console.log('[stop] No active dev/emulator processes found.')
  }
} catch {
  // No processes found
}
