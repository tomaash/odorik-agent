import { execSync } from 'node:child_process'

const PORTS = [9099, 8085, 5001, 5005, 4041, 5173]

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
      console.log(`[dev] Dev server/emulators are already running (PIDs: ${pids.join(', ')}).`)
      console.log(`[dev] Skipping duplicate startup. Run 'npm run stop' if you wish to stop them gracefully.`)
      process.exit(1)
    }
  }
} catch {
  // Ports are free, proceed with dev startup
}
