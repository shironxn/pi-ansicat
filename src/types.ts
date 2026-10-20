export interface ClipboardImage {
  bytes: Uint8Array;
  mimeType: string;
}

export interface PendingImage {
  id: string;
  base64: string;
  mimeType: string;
}

export interface ImageMarker {
  id: string;
  text: string;
}
