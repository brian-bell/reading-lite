// Captured content in R2, addressed by the relative keys PostgreSQL stores
// (ADR 0005). Reading state lives in rows; this store only moves bytes. The
// tenant root is applied here and nowhere else, so stored keys stay relative.
//
// Writers pass keys from the immutable revision family
// (`r2KeyLayout("").revisionRawKey(...)`); readers pass whatever the row holds,
// which for an imported reading is the legacy spelling under its key_prefix.

import type { TenantContext } from "../../control-plane/ids";
import { r2KeyLayout, type R2KeyLayout } from "./layout";
import {
  tenantDataPlaneEnabled,
  tenantKeyRoot,
  type RawObject,
  type ReadingObjectInfo,
} from "./reading-store";

export function contentStoreFor(
  bucket: R2Bucket,
  tenant: TenantContext,
  env: { TENANT_DATA_PLANE?: string },
): ContentStore {
  return new ContentStore(bucket, tenantKeyRoot(tenant, tenantDataPlaneEnabled(env)));
}

export class ContentStore {
  private readonly layout: R2KeyLayout;

  constructor(
    private readonly bucket: R2Bucket,
    keyRoot = "",
  ) {
    this.layout = r2KeyLayout(keyRoot);
  }

  async put(relativeKey: string, body: Uint8Array | string, contentType: string): Promise<void> {
    await this.bucket.put(this.abs(relativeKey), body, { httpMetadata: { contentType } });
  }

  async get(relativeKey: string): Promise<RawObject | null> {
    const obj = await this.bucket.get(this.abs(relativeKey));
    if (!obj) return null;
    return {
      arrayBuffer: () => obj.arrayBuffer(),
      text: () => obj.text(),
      body: obj.body,
      contentType: obj.httpMetadata?.contentType ?? "application/octet-stream",
      size: obj.size,
    };
  }

  // Deletes every object under a prefix, re-listing until a listing observes
  // zero objects, so one created between a snapshot and its batch delete is
  // caught by the next pass. Used for a purged reading's whole key_prefix and
  // for one attempt's revision prefix when that attempt lost the reading.
  async deletePrefix(relativePrefix: string): Promise<number> {
    const prefix = this.abs(relativePrefix.endsWith("/") ? relativePrefix : `${relativePrefix}/`);
    let deleted = 0;
    for (;;) {
      const list = await this.bucket.list({ prefix, limit: 1000 });
      if (list.objects.length === 0) return deleted;
      await this.bucket.delete(list.objects.map((obj) => obj.key));
      deleted += list.objects.length;
    }
  }

  // Diagnostics: what is actually in the bucket under one reading.
  async list(keyPrefix: string): Promise<ReadingObjectInfo[]> {
    const list = await this.bucket.list({ prefix: this.abs(`${keyPrefix}/`), limit: 1000 });
    return list.objects.map((obj) => ({
      key: obj.key,
      size: obj.size,
      uploaded: obj.uploaded?.toISOString(),
    }));
  }

  private abs(relativeKey: string): string {
    return `${this.layout.keyRoot}${relativeKey}`;
  }
}
