// Prusa driver, PrusaLink REST API (HTTP polling).
// Official API specification: https://github.com/prusa3d/Prusa-Link-Web/blob/master/spec/openapi.yaml

import fs from "fs";

import { requestEmpty, requestJson } from "../http";

interface Printer {
  api_key: string;
  ip: string;
  name: string;
}

interface PrusaStatusResponse {
  job?: {
    progress?: number;
    time_remaining?: number;
  };
  printer?: {
    state?: string;
  };
}

interface DriverStatus {
  currentFile?: null;
  progress: number | null;
  status: string;
  timeRemaining: number | null;
}

interface HttpStatusError {
  message?: string;
  status?: number;
}

function statusCode(error: unknown): number | undefined {
  return typeof error === "object" && error !== null
    ? (error as HttpStatusError).status
    : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function getStatus(printer: Printer): Promise<DriverStatus> {
  try {
    const data = await requestJson<PrusaStatusResponse>(`http://${printer.ip}/api/v1/status`, {
      headers: { "X-Api-Key": printer.api_key },
      timeoutMs: 8000,
    });
    const status = (data?.printer?.state || "UNKNOWN").toUpperCase();
    const progress = status === "PRINTING" && data?.job ? (data.job.progress ?? null) : null;
    const timeRemaining =
      status === "PRINTING" && data?.job ? (data.job.time_remaining ?? null) : null;

    return { status, progress, timeRemaining, currentFile: null };
  } catch {
    return { status: "OFFLINE", progress: null, timeRemaining: null };
  }
}

async function uploadAndPrint(
  printer: Printer,
  gcodeFullPath: string,
  filename: string,
): Promise<void> {
  try {
    await requestEmpty(`http://${printer.ip}/api/v1/files/usb/${encodeURIComponent(filename)}`, {
      method: "DELETE",
      headers: { "X-Api-Key": printer.api_key },
      timeoutMs: 10000,
    });
    console.log(`[prusa] Deleted existing ${filename} from ${printer.name}`);
  } catch (error) {
    if (statusCode(error) === 409) {
      throw Object.assign(
        new Error(
          `409 Conflict on pre-delete, file transfer likely still in progress on ${printer.name}`,
        ),
        { code: "UPLOAD_CONFLICT" },
      );
    }
    if (statusCode(error) !== 404) {
      console.warn(`[prusa] Pre-delete warning for ${printer.name}: ${errorMessage(error)}`);
    }
  }

  const fileStream = fs.createReadStream(gcodeFullPath);
  const stat = fs.statSync(gcodeFullPath);

  try {
    await requestEmpty(`http://${printer.ip}/api/v1/files/usb/${encodeURIComponent(filename)}`, {
      method: "PUT",
      body: fileStream,
      headers: {
        "X-Api-Key": printer.api_key,
        "Content-Type": "application/octet-stream",
        "Content-Length": String(stat.size),
        "Print-After-Upload": "1",
      },
      timeoutMs: 300000,
    });
  } catch (error) {
    if (statusCode(error) === 409) {
      throw Object.assign(
        new Error(
          `409 Conflict on upload, file transfer likely still in progress on ${printer.name}`,
        ),
        { code: "UPLOAD_CONFLICT" },
      );
    }
    throw error;
  }
}

async function cancelJob(_printer: Printer): Promise<void> {
  // PrusaLink v1 does not expose a reliable cancel endpoint.
}

async function checkIfPrinting(printer: Printer): Promise<boolean> {
  try {
    const data = await requestJson<PrusaStatusResponse>(`http://${printer.ip}/api/v1/status`, {
      headers: { "X-Api-Key": printer.api_key },
      timeoutMs: 8000,
    });
    const state = (data?.printer?.state || "").toUpperCase();
    return state === "PRINTING" || state === "PAUSED";
  } catch {
    return false;
  }
}

export = { getStatus, uploadAndPrint, cancelJob, checkIfPrinting };
