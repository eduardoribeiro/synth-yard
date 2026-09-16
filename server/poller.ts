import { EventEmitter } from "events";

const { getDriver } = require("./drivers");

interface Printer {
  id: number;
  name: string;
  status: string;
  type: string;
  [key: string]: unknown;
}

interface PrinterStatus {
  currentFile?: string | null;
  progress: number | null;
  status: string;
  timeRemaining: number | null;
}

interface Driver {
  getStatus(printer: Printer): Promise<PrinterStatus>;
}

interface Statement {
  all(...parameters: unknown[]): Printer[];
  get(...parameters: unknown[]): { filename?: string; id?: number } | undefined;
  run(...parameters: unknown[]): unknown;
}

interface Database {
  prepare(sql: string): Statement;
}

const POLL_INTERVAL_MS = 15000;

class PrinterPoller extends EventEmitter {
  db: Database;
  timer: NodeJS.Timeout | null;

  constructor(db: Database) {
    super();
    this.db = db;
    this.timer = null;
  }

  start(): void {
    console.log(`[poller] Starting poll loop (interval: ${POLL_INTERVAL_MS}ms)`);
    void this._tick();
    this.timer = setInterval(() => void this._tick(), POLL_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async _tick(): Promise<void> {
    if (process.env.DEMO_MODE === "true") {
      this.emit("pollComplete");
      return;
    }

    const printers = this.db.prepare("SELECT * FROM printers WHERE is_active = 1").all();

    if (printers.length === 0) return;

    const results = await Promise.allSettled(printers.map((printer) => this._pollPrinter(printer)));

    results.forEach((result, index) => {
      if (result.status === "rejected") {
        console.error(`[poller] Unexpected error polling ${printers[index].name}:`, result.reason);
      }
    });

    this.emit("pollComplete");
  }

  async _pollPrinter(printer: Printer): Promise<void> {
    const previousStatus = printer.status;
    let jobName: string | null = null;
    let jobProgress: number | null = null;
    let jobTimeRemaining: number | null = null;

    let driver: Driver;
    try {
      driver = getDriver(printer.type) as Driver;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `[poller] ${printer.name} has unknown type "${printer.type}" - skipping poll: ${message}`,
      );
      return;
    }

    const result = await driver.getStatus(printer);
    const newStatus = result.status;
    jobProgress = result.progress;
    jobTimeRemaining = result.timeRemaining;

    if (newStatus !== previousStatus) {
      const safeStates = new Set(["IDLE", "PRINTING", "FINISHED", "READY"]);
      const missedFinished = newStatus === "IDLE" && previousStatus === "PRINTING";
      const hasActiveJob = Boolean(
        this.db
          .prepare(
            "SELECT id FROM jobs WHERE printer_id = ? AND status IN ('uploading', 'printing') LIMIT 1",
          )
          .get(printer.id),
      );
      const shouldHold =
        hasActiveJob && (newStatus === "FINISHED" || missedFinished || !safeStates.has(newStatus));
      const holdUpdate = shouldHold ? ", is_held = 1" : "";
      const clearJob =
        previousStatus === "PRINTING" && newStatus !== "PRINTING"
          ? ", job_name = NULL, job_progress = NULL, job_time_remaining = NULL"
          : "";
      this.db
        .prepare(`UPDATE printers SET status = ?${holdUpdate}${clearJob} WHERE id = ?`)
        .run(newStatus, printer.id);

      console.log(`[poller] ${printer.name}: ${previousStatus} -> ${newStatus}`);
      this.emit("statusChange", { printer, previousStatus, newStatus });

      if (newStatus === "IDLE" && previousStatus !== "IDLE") {
        this.emit("printerIdle", { printer: { ...printer, status: newStatus } });
      }
    }

    if (newStatus === "PRINTING") {
      if (result.currentFile) {
        jobName = result.currentFile;
      } else {
        const activeJob = this.db
          .prepare(`
          SELECT gcodes.filename FROM jobs
          JOIN gcodes ON gcodes.id = jobs.gcode_id
          WHERE jobs.printer_id = ? AND jobs.status = 'printing'
          ORDER BY jobs.started_at DESC LIMIT 1
        `)
          .get(printer.id);
        jobName = activeJob?.filename ?? null;
      }
      this.db
        .prepare(
          "UPDATE printers SET job_name = ?, job_progress = ?, job_time_remaining = ? WHERE id = ?",
        )
        .run(jobName, jobProgress, jobTimeRemaining, printer.id);
    }
  }
}

export = PrinterPoller;
