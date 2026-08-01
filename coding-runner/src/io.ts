import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, open, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { Readable } from "node:stream";

const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;
const UPLOAD_TIMEOUT_MS = 10 * 60 * 1000;

export type DownloadResult = {
  bytes: number;
  sha256: string;
};

function isLocalFilesEnabled(): boolean {
  return process.env.ALLOW_LOCAL_FILES === "true";
}

function localPath(url: string): string | undefined {
  if (!url.startsWith("file://")) return undefined;
  if (!isLocalFilesEnabled()) throw new Error("Local file URLs are disabled");
  const parsed = new URL(url);
  return resolve(decodeURIComponent(parsed.pathname));
}

export async function downloadToFile(
  url: string,
  destination: string,
  maxBytes: number,
): Promise<DownloadResult> {
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  const sourcePath = localPath(url);
  if (sourcePath) {
    const info = await stat(sourcePath);
    if (!info.isFile()) throw new Error("Local download source is not a regular file");
    if (info.size > maxBytes) throw new Error(`Download exceeds ${maxBytes} bytes`);
    await copyFile(sourcePath, destination);
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(destination)) hash.update(chunk as Buffer);
    return { bytes: info.size, sha256: hash.digest("hex") };
  }

  const response = await fetch(url, {
    method: "GET",
    redirect: "error",
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    headers: { "user-agent": "agent-erik-coding-runner/0.1" },
  });
  if (!response.ok || !response.body) {
    throw new Error(`Download failed with HTTP ${response.status}`);
  }

  const contentLength = response.headers.get("content-length");
  if (contentLength && Number(contentLength) > maxBytes) {
    throw new Error(`Download exceeds ${maxBytes} bytes`);
  }

  const output = await open(destination, "w", 0o600);
  const hash = createHash("sha256");
  let bytes = 0;
  try {
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel("size limit exceeded");
        throw new Error(`Download exceeds ${maxBytes} bytes`);
      }
      hash.update(value);
      await output.write(value);
    }
  } finally {
    await output.close();
  }
  return { bytes, sha256: hash.digest("hex") };
}

export async function readJsonFromLocation(
  url: string | undefined,
  path: string | undefined,
  maxBytes: number,
): Promise<unknown> {
  if ((url ? 1 : 0) + (path ? 1 : 0) !== 1) {
    throw new Error("Set exactly one of RUN_SPEC_URL or RUN_SPEC_PATH");
  }
  if (path) {
    if (!isLocalFilesEnabled()) throw new Error("RUN_SPEC_PATH is disabled");
    const info = await stat(path);
    if (!info.isFile() || info.size > maxBytes) throw new Error("Run spec is missing or too large");
    return JSON.parse(await readFile(path, "utf8"));
  }

  const response = await fetch(url!, {
    method: "GET",
    redirect: "error",
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    headers: { "user-agent": "agent-erik-coding-runner/0.1" },
  });
  if (!response.ok) throw new Error(`Run spec download failed with HTTP ${response.status}`);
  const contentLength = response.headers.get("content-length");
  if (contentLength && Number(contentLength) > maxBytes) throw new Error("Run spec is too large");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > maxBytes) throw new Error("Run spec is too large");
  return JSON.parse(new TextDecoder().decode(bytes));
}

export async function uploadArtifact(
  url: string,
  artifactPath: string,
  maxBytes: number,
  contentType = "application/gzip",
): Promise<number> {
  const info = await stat(artifactPath);
  if (!info.isFile()) throw new Error("Artifact is not a regular file");
  if (info.size > maxBytes) throw new Error(`Artifact exceeds ${maxBytes} bytes`);

  const localDestination = process.env.ARTIFACT_OUTPUT_PATH;
  if (localDestination) {
    if (!isLocalFilesEnabled()) throw new Error("ARTIFACT_OUTPUT_PATH is disabled");
    await mkdir(dirname(localDestination), { recursive: true });
    await copyFile(artifactPath, localDestination);
    return info.size;
  }

  const body = Readable.toWeb(createReadStream(artifactPath)) as ReadableStream<Uint8Array>;
  const response = await fetch(url, {
    method: "PUT",
    redirect: "error",
    signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    headers: {
      "content-type": contentType,
      "content-length": String(info.size),
    },
    body,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
  if (!response.ok) throw new Error(`Artifact upload failed with HTTP ${response.status}`);
  return info.size;
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

export function safeFileLabel(path: string): string {
  return basename(path).replaceAll(/[^A-Za-z0-9._-]/g, "_");
}
