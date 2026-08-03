import { execSync } from 'node:child_process'

const frontendOnly = process.argv.includes('--frontend-only')
const PORTS = frontendOnly
  ? [5173]
  : [9099, 8085, 5001, 5005, 4041, 5173]

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
      const label = frontendOnly ? 'Frontend' : 'Dev server/emulators'
      console.log(`[dev] ${label} already running (PIDs: ${pids.join(', ')}).`)
      console.log(`[dev] Skipping duplicate startup. Run 'npm run stop' if you wish to stop them gracefully.`)
      process.exit(1)
    }
  }
} catch {
  // Ports are free, proceed with dev startup
}
