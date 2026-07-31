import { spawn } from "node:child_process";
import { redactSecrets } from "./redact.js";

export type CommandResult = {
  code: number;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  durationMs: number;
};

export type CommandOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  uid?: number;
  gid?: number;
};

function appendBounded(
  current: Buffer<ArrayBufferLike>,
  incoming: Buffer<ArrayBufferLike>,
  limit: number,
): { value: Buffer<ArrayBufferLike>; truncated: boolean } {
  if (current.byteLength >= limit) return { value: current, truncated: incoming.byteLength > 0 };
  const remaining = limit - current.byteLength;
  if (incoming.byteLength <= remaining) {
    return { value: Buffer.concat([current, incoming]), truncated: false };
  }
  return { value: Buffer.concat([current, incoming.subarray(0, remaining)]), truncated: true };
}

export async function runCommand(
  command: string,
  args: string[],
  options: CommandOptions = {},
): Promise<CommandResult> {
  const startedAt = Date.now();
  const stdoutLimit = options.maxStdoutBytes ?? 2 * 1024 * 1024;
  const stderrLimit = options.maxStderrBytes ?? 1024 * 1024;

  return await new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      ...(options.uid === undefined ? {} : { uid: options.uid }),
      ...(options.gid === undefined ? {} : { gid: options.gid }),
    });
    let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let killTimer: NodeJS.Timeout | undefined;
    const timeout = options.timeoutMs
      ? setTimeout(() => {
          child.kill("SIGTERM");
          killTimer = setTimeout(() => child.kill("SIGKILL"), 10_000);
        }, options.timeoutMs)
      : undefined;

    child.stdout.on("data", (chunk: Buffer) => {
      const appended = appendBounded(stdout, chunk, stdoutLimit);
      stdout = appended.value;
      stdoutTruncated ||= appended.truncated;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const appended = appendBounded(stderr, chunk, stderrLimit);
      stderr = appended.value;
      stderrTruncated ||= appended.truncated;
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (timeout) clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      resolve({
        code: code ?? 1,
        signal,
        stdout: redactSecrets(stdout.toString("utf8")),
        stderr: redactSecrets(stderr.toString("utf8")),
        stdoutTruncated,
        stderrTruncated,
        durationMs: Date.now() - startedAt,
      });
    });
  });
}

export async function requireSuccessfulCommand(
  command: string,
  args: string[],
  options: CommandOptions = {},
): Promise<CommandResult> {
  const result = await runCommand(command, args, options);
  if (result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`;
    throw new Error(`${command} failed: ${detail.slice(0, 2000)}`);
  }
  return result;
}
