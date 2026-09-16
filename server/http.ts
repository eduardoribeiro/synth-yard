import fs from "fs";
import type { Readable } from "stream";

export interface HttpErrorResponse {
  status: number;
  statusText: string;
}

export type QueryValue = boolean | number | string | null | undefined;

export interface RequestOptions {
  body?: BodyInit | Readable;
  headers?: HeadersInit;
  method?: string;
  query?: Record<string, QueryValue>;
  timeoutMs?: number;
}

export class HttpError extends Error {
  status: number;
  body: string;

  constructor(response: HttpErrorResponse, body: string) {
    super(`HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`);
    this.name = "HttpError";
    this.status = response.status;
    this.body = body;
  }
}

export function withQuery(url: string, query?: Record<string, QueryValue>): string {
  if (!query) return url;

  const target = new URL(url);
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    target.searchParams.set(key, String(value));
  }
  return target.toString();
}

async function readErrorBody(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

function requestOptions({
  method = "GET",
  headers,
  body,
  timeoutMs = 8000,
}: RequestOptions): RequestInit {
  const options: RequestInit & { duplex?: "half" } = {
    method,
    headers,
    body: body as BodyInit | null | undefined,
    signal: AbortSignal.timeout(timeoutMs),
  };

  // Undici requires duplex when a Node readable stream is the request body.
  if (body && typeof (body as Readable).pipe === "function") options.duplex = "half";
  return options;
}

export async function requestRaw(url: string, options: RequestOptions = {}): Promise<Response> {
  const response = await fetch(withQuery(url, options.query), requestOptions(options));
  if (!response.ok) {
    throw new HttpError(response, await readErrorBody(response));
  }
  return response;
}

export async function requestJson<T = unknown>(
  url: string,
  options: RequestOptions = {},
): Promise<T | null> {
  const response = await requestRaw(url, options);
  if (response.status === 204) return null;
  return response.json() as Promise<T>;
}

export async function requestEmpty(url: string, options: RequestOptions = {}): Promise<void> {
  const response = await requestRaw(url, options);
  // Drain successful response bodies so Undici can release the connection for
  // later printer requests in this long-lived server process.
  await response.arrayBuffer();
}

export function fileBlob(filePath: string, type = "application/octet-stream"): Blob {
  return new Blob([fs.readFileSync(filePath)], { type });
}
