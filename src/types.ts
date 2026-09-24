export interface ClipboardImage {
  bytes: Uint8Array;
  mimeType: string; // "image/png", "image/jpeg", ...
}

export interface PendingImage {
  id: string; // UUID — unique per paste operation
  base64: string;
  mimeType: string;
}

export interface ImageMarker {
  id: string; // matches PendingImage.id
  text: string; // "[Image #N]" — the exact text inserted
  index: number; // 1-based insertion order
}
