import { randomInt } from "node:crypto";

export interface SessionImage {
  id: number;
  data: string;
  mimeType: string;
}

const MAX_IMAGES = 32;
const MAX_BYTES = 64 * 1024 * 1024;

// Keeps recent images addressable for vision_ask without holding the whole
// session's clipboard history in memory.
export class ImageStore {
  // A random base keeps ids distinct from labels left in an earlier session's
  // transcript. `clear()` must not reset it within the same process.
  private next = randomInt(1_000_000, 9_000_000);
  private total = 0;
  private images = new Map<number, SessionImage & { bytes: number }>();

  add(data: string, mimeType: string): number {
    const id = this.next++;
    const bytes = Buffer.byteLength(data, "base64");
    this.images.set(id, { id, data, mimeType, bytes });
    this.total += bytes;
    while (this.images.size > MAX_IMAGES || this.total > MAX_BYTES) {
      const oldest = this.images.keys().next().value;
      if (oldest === undefined) break;
      this.remove(oldest);
    }
    return id;
  }

  get(id: number): SessionImage | undefined {
    const hit = this.images.get(id);
    return hit ? { id: hit.id, data: hit.data, mimeType: hit.mimeType } : undefined;
  }

  latest(): SessionImage | undefined {
    let last: SessionImage | undefined;
    for (const image of this.images.values()) {
      last = { id: image.id, data: image.data, mimeType: image.mimeType };
    }
    return last;
  }

  clear(): void {
    this.images.clear();
    this.total = 0;
  }

  private remove(id: number): void {
    const hit = this.images.get(id);
    if (!hit) return;
    this.total -= hit.bytes;
    this.images.delete(id);
  }
}
