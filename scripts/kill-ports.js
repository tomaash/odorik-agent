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
      console.log(`[kill-ports] Freeing ports (${PORTS.join(', ')})... killing PIDs: ${pids.join(', ')}`)
      execSync(`kill -9 ${pids.join(' ')}`, { stdio: 'ignore' })
    }
  }
} catch {
  // If lsof exits with non-zero (no processes found), do nothing
}
