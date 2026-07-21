import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Storage } from "@google-cloud/storage";
import { projectId } from "./config.js";

export type AudioObjectMetadata = {
  size: number;
  contentType?: string;
};

let storage: Storage | undefined;

function cloudStorage(): Storage {
  storage ??= new Storage({ projectId: projectId() });
  return storage;
}

function localObjectPath(objectName: string): string | null {
  const root = process.env.LOCAL_RECORDINGS_DIR?.trim();
  if (!root) return null;
  const fullPath = path.resolve(root, objectName);
  const safeRoot = `${path.resolve(root)}${path.sep}`;
  if (!fullPath.startsWith(safeRoot)) throw new Error("Unsafe local object path");
  return fullPath;
}

export async function saveAudioObject(input: {
  bucketName: string;
  objectName: string;
  audio: Buffer;
  contentType: string;
  metadata: Record<string, string>;
}): Promise<{ duplicate: boolean }> {
  const localPath = localObjectPath(input.objectName);
  if (localPath) {
    await mkdir(path.dirname(localPath), { recursive: true });
    try {
      await writeFile(localPath, input.audio, { flag: "wx" });
      await writeFile(
        `${localPath}.metadata.json`,
        JSON.stringify(
          {
            contentType: input.contentType,
            metadata: input.metadata,
          },
          null,
          2,
        ),
        { flag: "wx" },
      );
      return { duplicate: false };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        return { duplicate: true };
      }
      throw error;
    }
  }

  try {
    await cloudStorage()
      .bucket(input.bucketName)
      .file(input.objectName)
      .save(input.audio, {
        contentType: input.contentType,
        resumable: false,
        metadata: { metadata: input.metadata },
        preconditionOpts: { ifGenerationMatch: 0 },
      });
    return { duplicate: false };
  } catch (error) {
    const code = (error as { code?: number }).code;
    if (code === 409 || code === 412) return { duplicate: true };
    throw error;
  }
}

export async function loadAudioObject(input: {
  bucketName: string;
  objectName: string;
}): Promise<{ audio: Buffer; metadata: AudioObjectMetadata }> {
  const localPath = localObjectPath(input.objectName);
  if (localPath) {
    const [audio, fileStats, rawMetadata] = await Promise.all([
      readFile(localPath),
      stat(localPath),
      readFile(`${localPath}.metadata.json`, "utf8").catch(() => "{}"),
    ]);
    const parsed = JSON.parse(rawMetadata) as { contentType?: string };
    return {
      audio,
      metadata: {
        size: fileStats.size,
        ...(parsed.contentType ? { contentType: parsed.contentType } : {}),
      },
    };
  }

  const file = cloudStorage().bucket(input.bucketName).file(input.objectName);
  const [[metadata], [audio]] = await Promise.all([
    file.getMetadata(),
    file.download(),
  ]);
  return {
    audio,
    metadata: {
      size: Number.parseInt(String(metadata.size || "0"), 10),
      ...(metadata.contentType ? { contentType: metadata.contentType } : {}),
    },
  };
}

