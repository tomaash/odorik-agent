import { execSync } from 'node:child_process'

const PORTS = [9099, 8085, 5001, 5005, 4041, 5173]

console.log('[stop] Exporting emulator data before shutdown...')
try {
  execSync('npx --prefix functions firebase emulators:export ./.emulator-data', { stdio: 'inherit' })
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
