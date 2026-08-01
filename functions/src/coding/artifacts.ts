import { GoogleAuth, Impersonated } from "google-auth-library";
import { Storage } from "@google-cloud/storage";

export type SignedUpload = { url: string; object: string };

export interface CodingArtifactStore {
  putJson(object: string, value: unknown): Promise<void>;
  signedReadUrl(object: string, expiresMs?: number): Promise<string>;
  signedWriteUrl(object: string, contentType: string, expiresMs?: number): Promise<string>;
  readText(object: string, maxBytes: number): Promise<{ text: string; truncated: boolean }>;
  exists(object: string): Promise<boolean>;
}

const projectId = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT || "odorik-tx-260720-c58d";
const bucketName = process.env.CODING_ARTIFACT_BUCKET
  || `${projectId}-coding-artifacts-euw1`;
const signerEmail = process.env.CODING_SIGNER_SERVICE_ACCOUNT
  || `erik-coding-signer@${projectId}.iam.gserviceaccount.com`;

export class GoogleCodingArtifactStore implements CodingArtifactStore {
  private storagePromise?: Promise<Storage>;

  private async storage(): Promise<Storage> {
    this.storagePromise ||= (async () => {
      const source = await new GoogleAuth({
        scopes: ["https://www.googleapis.com/auth/cloud-platform"],
      }).getClient();
      const authClient = new Impersonated({
        sourceClient: source,
        targetPrincipal: signerEmail,
        targetScopes: ["https://www.googleapis.com/auth/devstorage.full_control"],
        lifetime: 3600,
      });
      // @google-cloud/storage currently carries google-auth-library v9 while
      // the Functions runtime uses v10. Both expose the same signing/request
      // contract, but their private AuthClient types are nominally different.
      return new Storage({ projectId, authClient: authClient as never });
    })();
    return this.storagePromise;
  }

  private async file(object: string) {
    if (!/^[A-Za-z0-9][A-Za-z0-9/_.-]{1,500}$/.test(object) || object.includes("..")) {
      throw new Error("Invalid coding artifact object name");
    }
    return (await this.storage()).bucket(bucketName).file(object);
  }

  async putJson(object: string, value: unknown): Promise<void> {
    await (await this.file(object)).save(`${JSON.stringify(value)}\n`, {
      resumable: false,
      contentType: "application/json",
      preconditionOpts: { ifGenerationMatch: 0 },
      metadata: { cacheControl: "private, no-store" },
    });
  }

  async signedReadUrl(object: string, expiresMs = 15 * 60 * 1000): Promise<string> {
    const [url] = await (await this.file(object)).getSignedUrl({
      version: "v4",
      action: "read",
      expires: Date.now() + expiresMs,
    });
    return url;
  }

  async signedWriteUrl(
    object: string,
    contentType: string,
    expiresMs = 2 * 60 * 60 * 1000,
  ): Promise<string> {
    const [url] = await (await this.file(object)).getSignedUrl({
      version: "v4",
      action: "write",
      contentType,
      expires: Date.now() + expiresMs,
    });
    return url;
  }

  async readText(object: string, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
    const [metadata] = await (await this.file(object)).getMetadata();
    const size = Number(metadata.size || 0);
    const end = Math.max(0, Math.min(size, maxBytes) - 1);
    const [bytes] = await (await this.file(object)).download({ start: 0, end });
    return { text: bytes.toString("utf8"), truncated: size > maxBytes };
  }

  async exists(object: string): Promise<boolean> {
    const [exists] = await (await this.file(object)).exists();
    return exists;
  }
}

export function codingObjectRoot(companyId: string, runId: string): string {
  if (!/^[a-z0-9][a-z0-9_-]{1,63}$/.test(companyId)) throw new Error("Invalid company ID");
  if (!/^coding_[a-f0-9]{32}$/.test(runId)) throw new Error("Invalid coding run ID");
  return `companies/${companyId}/coding-runs/${runId}`;
}
