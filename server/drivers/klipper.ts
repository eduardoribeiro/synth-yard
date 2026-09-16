// Klipper driver, Moonraker REST API (HTTP polling, port 7125)
// Implements the shared driver interface: getStatus, uploadAndPrint, cancelJob, checkIfPrinting
//
// Moonraker is the standard API layer for Klipper firmware (Voron, etc.).
// All communication is plain HTTP, no persistent connection or auth required on LAN.
// Upload: POST multipart to /server/files/upload with print=true, starts immediately.

import { fileBlob, requestEmpty, requestJson } from "../http";

const PORT = 7125;

type CanonicalStatus =
  | "IDLE"
  | "PRINTING"
  | "PAUSED"
  | "FINISHED"
  | "ERROR"
  | "STOPPED"
  | "OFFLINE"
  | "UNKNOWN";

interface Printer {
  ip: string;
  name: string;
}

interface MoonrakerStatusResponse {
  result?: {
    status?: {
      print_stats?: {
        filename?: string;
        print_duration?: number;
        state?: string;
      };
      virtual_sdcard?: {
        progress?: number | null;
      };
      webhooks?: {
        state?: string;
      };
    };
  };
}

interface DriverStatus {
  currentFile: string | null;
  progress: number | null;
  status: CanonicalStatus;
  timeRemaining: number | null;
}

function base(printer: Printer): string {
  // Strip any accidental protocol prefix or trailing slashes, field expects bare IP.
  const ip = printer.ip.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  return `http://${ip}:${PORT}`;
}

// Moonraker print_stats.state to canonical status.
const STATE_MAP: Record<string, CanonicalStatus> = {
  standby: "IDLE",
  printing: "PRINTING",
  paused: "PAUSED",
  complete: "FINISHED",
  error: "ERROR",
  cancelled: "STOPPED",
};

async function getStatus(printer: Printer): Promise<DriverStatus> {
  try {
    const data = await requestJson<MoonrakerStatusResponse>(
      `${base(printer)}/printer/objects/query`,
      {
        query: { print_stats: "", virtual_sdcard: "", webhooks: "" },
        timeoutMs: 8000,
      },
    );

    const stats = data?.result?.status?.print_stats ?? {};
    const vsd = data?.result?.status?.virtual_sdcard ?? {};
    const hooks = data?.result?.status?.webhooks ?? {};

    // If Klipper itself is not ready (startup, shutdown, error), report offline.
    if (hooks.state && hooks.state !== "ready") {
      return { status: "OFFLINE", progress: null, timeRemaining: null, currentFile: null };
    }

    const status = STATE_MAP[stats.state ?? ""] ?? "UNKNOWN";

    let progress: number | null = null;
    let timeRemaining: number | null = null;
    let currentFile: string | null = null;

    if (status === "PRINTING" || status === "PAUSED") {
      const pct = vsd.progress ?? null;
      if (pct != null) progress = Math.round(pct * 100);

      // Estimate time remaining from elapsed print time and file progress.
      // Only meaningful once a few percent in, avoid div-by-zero and wildly
      // inaccurate early estimates.
      const elapsed = stats.print_duration ?? 0;
      if (pct != null && pct > 0.02 && elapsed > 0) {
        timeRemaining = Math.round((elapsed * (1 - pct)) / pct);
      }

      if (stats.filename) currentFile = stats.filename;
    }

    return { status, progress, timeRemaining, currentFile };
  } catch {
    return { status: "OFFLINE", progress: null, timeRemaining: null, currentFile: null };
  }
}

// Uploads the G-code file to Moonraker's gcodes directory, then triggers a print.
// Moonraker deduplicates by filename, uploading a file that already exists
// overwrites it silently, so no pre-delete step is needed.
async function uploadAndPrint(
  printer: Printer,
  gcodeFullPath: string,
  filename: string,
): Promise<void> {
  const form = new FormData();
  form.append("file", fileBlob(gcodeFullPath), filename);
  form.append("print", "true"); // Must be a form field, not a query parameter.

  await requestEmpty(`${base(printer)}/server/files/upload`, {
    method: "POST",
    body: form,
    timeoutMs: 300000, // Five minutes for large files.
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function cancelJob(printer: Printer): Promise<void> {
  try {
    await requestEmpty(`${base(printer)}/printer/print/cancel`, {
      method: "POST",
      timeoutMs: 10000,
    });
  } catch (error) {
    console.warn(`[klipper] Cancel failed for ${printer.name}: ${errorMessage(error)}`);
  }
}

async function checkIfPrinting(printer: Printer): Promise<boolean> {
  try {
    const { status } = await getStatus(printer);
    return status === "PRINTING" || status === "PAUSED";
  } catch {
    return false;
  }
}

export = { getStatus, uploadAndPrint, cancelJob, checkIfPrinting };
