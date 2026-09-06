import { AUTHENTICATION_REQUIRED, readToken } from "./api";

export type ManagedAttachment = {
  id: string;
  name: string;
  type: string;
  size: number;
  path: string;
};

export type AttachmentUpload = {
  promise: Promise<ManagedAttachment>;
  cancel: () => void;
};

function errorMessage(xhr: XMLHttpRequest): string {
  try {
    const payload = JSON.parse(xhr.responseText) as { error?: { message?: string } };
    if (payload.error?.message) return payload.error.message;
  } catch {}
  return xhr.status ? `Upload failed: HTTP ${xhr.status}` : "Upload failed.";
}

/** Uploads the browser File directly through XHR so bytes are never copied into JS memory. */
export function uploadAttachment(
  file: File,
  options: { signal?: AbortSignal; onProgress?: (loaded: number, total: number) => void } = {},
): AttachmentUpload {
  const xhr = new XMLHttpRequest();
  const { token, remoteMode } = readToken();
  if (remoteMode && !token) {
    return {
      promise: Promise.reject(AUTHENTICATION_REQUIRED),
      cancel: () => {},
    };
  }
  let started = false;
  const promise = new Promise<ManagedAttachment>((resolve, reject) => {
    const abort = () => xhr.abort();
    if (options.signal?.aborted) {
      reject(options.signal.reason ?? new DOMException("Upload cancelled", "AbortError"));
      return;
    }
    options.signal?.addEventListener("abort", abort, { once: true });
    xhr.onloadend = () => options.signal?.removeEventListener("abort", abort);
    xhr.open("POST", "/api/attachments");
    xhr.setRequestHeader("X-Operator-Token", token);
    xhr.setRequestHeader("X-Attachment-Name", encodeURIComponent(file.name));
    xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
    xhr.upload.onprogress = (event) =>
      options.onProgress?.(event.loaded, event.lengthComputable ? event.total : file.size);
    xhr.onerror = () => reject(new Error("Upload failed. Check the daemon connection."));
    xhr.onabort = () => reject(new DOMException("Upload cancelled", "AbortError"));
    xhr.onload = () => {
      if (remoteMode && xhr.status === 401) return reject(AUTHENTICATION_REQUIRED);
      if (xhr.status < 200 || xhr.status >= 300) return reject(new Error(errorMessage(xhr)));
      try {
        resolve(JSON.parse(xhr.responseText) as ManagedAttachment);
      } catch {
        reject(new Error("Upload returned an invalid response."));
      }
    };
    started = true;
    xhr.send(file);
  });
  return { promise, cancel: () => { if (started) xhr.abort(); } };
}

export async function deleteManagedAttachment(id: string): Promise<void> {
  const { token, remoteMode } = readToken();
  const response = await fetch(`/api/attachments/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: { "X-Operator-Token": token },
  });

  if (remoteMode && response.status === 401) throw AUTHENTICATION_REQUIRED;
  if (response.ok) return;
  const payload = await response.json().catch(() => null) as { error?: { message?: string } } | null;
  throw new Error(payload?.error?.message ?? `Could not remove upload: HTTP ${response.status}`);
}

