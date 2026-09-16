// OctoPrint REST API driver.
// Official API documentation: https://docs.octoprint.org/en/main/api/index.html

import { fileBlob, requestEmpty, requestJson } from "../http";

interface Printer {
  api_key: string;
  ip: string;
  name: string;
}

interface PrinterFlags {
  cancelling?: boolean;
  closedOrError?: boolean;
  error?: boolean;
  operational?: boolean;
  paused?: boolean;
  pausing?: boolean;
  printing?: boolean;
}

interface PrinterResponse {
  state?: { flags?: PrinterFlags };
}

interface JobResponse {
  job?: { file?: { name?: string | null } };
  progress?: { completion?: number | null; printTimeLeft?: number | null };
}

interface DriverStatus {
  currentFile: string | null;
  progress: number | null;
  status: string;
  timeRemaining: number | null;
}

function headers(printer: Printer): Record<string, string> {
  return { "X-Api-Key": printer.api_key };
}

function statusCode(error: unknown): number | undefined {
  return typeof error === "object" && error !== null
    ? (error as { status?: number }).status
    : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function getStatus(printer: Printer): Promise<DriverStatus> {
  try {
    const [printerData, job] = await Promise.all([
      requestJson<PrinterResponse>(`http://${printer.ip}/api/printer`, {
        headers: headers(printer),
        timeoutMs: 8000,
      }),
      requestJson<JobResponse>(`http://${printer.ip}/api/job`, {
        headers: headers(printer),
        timeoutMs: 8000,
      }),
    ]);

    const flags = printerData?.state?.flags || {};
    const completion = job?.progress?.completion ?? null;
    const hasJobFile = Boolean(job?.job?.file?.name);
    let status: string;

    if (flags.error || flags.closedOrError) status = "ERROR";
    else if (flags.printing || flags.pausing || flags.cancelling) status = "PRINTING";
    else if (flags.paused) status = "PAUSED";
    else if (flags.operational && hasJobFile && completion === 100) status = "FINISHED";
    else if (flags.operational) status = "IDLE";
    else status = "UNKNOWN";

    return {
      status,
      progress: status === "PRINTING" ? completion : null,
      timeRemaining: status === "PRINTING" ? (job?.progress?.printTimeLeft ?? null) : null,
      currentFile: status === "PRINTING" && hasJobFile ? (job?.job?.file?.name ?? null) : null,
    };
  } catch {
    return { status: "OFFLINE", progress: null, timeRemaining: null, currentFile: null };
  }
}

async function uploadAndPrint(
  printer: Printer,
  gcodeFullPath: string,
  filename: string,
): Promise<void> {
  const form = new FormData();
  form.append("file", fileBlob(gcodeFullPath), filename);
  form.append("select", "true");
  form.append("print", "true");

  try {
    await requestEmpty(`http://${printer.ip}/api/files/local`, {
      method: "POST",
      headers: headers(printer),
      body: form,
      timeoutMs: 300000,
    });
  } catch (error) {
    if (statusCode(error) === 409) {
      throw Object.assign(
        new Error(`409 Conflict on upload - file likely mid-print on ${printer.name}`),
        {
          code: "UPLOAD_CONFLICT",
        },
      );
    }
    throw error;
  }
}

async function cancelJob(printer: Printer): Promise<void> {
  try {
    await requestEmpty(`http://${printer.ip}/api/job`, {
      method: "POST",
      headers: { ...headers(printer), "Content-Type": "application/json" },
      body: JSON.stringify({ command: "cancel" }),
      timeoutMs: 10000,
    });
  } catch (error) {
    console.warn(`[octoprint] Cancel failed for ${printer.name}: ${errorMessage(error)}`);
  }
}

async function checkIfPrinting(printer: Printer): Promise<boolean> {
  try {
    const data = await requestJson<PrinterResponse>(`http://${printer.ip}/api/printer`, {
      headers: headers(printer),
      timeoutMs: 8000,
    });
    const flags = data?.state?.flags || {};
    return Boolean(flags.printing || flags.paused || flags.pausing || flags.cancelling);
  } catch {
    return false;
  }
}

export = { getStatus, uploadAndPrint, cancelJob, checkIfPrinting };
