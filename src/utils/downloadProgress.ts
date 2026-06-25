export interface DownloadProgress {
  loaded: number;
  total: number;
  percent: number;
}

export async function fetchWithProgress(
  url: string,
  onProgress?: (progress: DownloadProgress) => void,
): Promise<Blob> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
  }

  const contentLength = response.headers.get("content-length");
  const total = contentLength ? parseInt(contentLength, 10) : 0;
  let loaded = 0;

  if (!response.body) {
    const blob = await response.blob();
    if (onProgress) {
      onProgress({ loaded: blob.size, total: blob.size, percent: 100 });
    }
    return blob;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    chunks.push(value as Uint8Array<ArrayBuffer>);
    loaded += value.length;

    if (onProgress && total > 0) {
      onProgress({
        loaded,
        total,
        percent: Math.round((loaded / total) * 100),
      });
    }
  }

  const blob = new Blob(chunks);
  if (onProgress) {
    onProgress({ loaded: blob.size, total: blob.size, percent: 100 });
  }
  return blob;
}

export interface MultiDownloadProgress extends DownloadProgress {
  fileIndex: number;
  fileCount: number;
  fileName: string;
}

export async function fetchMultipleWithProgress(
  urls: string[],
  onProgress?: (progress: MultiDownloadProgress) => void,
): Promise<Blob[]> {
  const results: Blob[] = [];
  const fileCount = urls.length;

  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    const fileName = url.split("/").pop() || url;

    const blob = await fetchWithProgress(url, (singleProgress) => {
      if (onProgress) {
        onProgress({
          ...singleProgress,
          fileIndex: i,
          fileCount,
          fileName,
        });
      }
    });

    results.push(blob);
  }

  return results;
}

export function createBlobUrl(blob: Blob): string {
  return URL.createObjectURL(blob);
}

export function revokeBlobUrl(url: string): void {
  URL.revokeObjectURL(url);
}
