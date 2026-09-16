jest.mock("../drivers", () => ({ getDriver: jest.fn() }));

const { getDriver } = require("../drivers");
const PrinterPoller = require("../poller");

type Printer = {
  id: number;
  name: string;
  status: string;
  type: string;
};

function makeDb(printer: Printer, hasActiveJob = true) {
  const runs: unknown[][] = [];

  return {
    prepare(sql: string) {
      return {
        all: () => (sql.includes("FROM printers WHERE is_active") ? [printer] : []),
        get: () => {
          if (sql.includes("FROM jobs WHERE printer_id"))
            return hasActiveJob ? { id: 1 } : undefined;
          return undefined;
        },
        run: (...values: unknown[]) => {
          runs.push(values);
        },
      };
    },
    runs,
  };
}

function createPoller(
  status: string,
  options: { currentFile?: string; previousStatus?: string } = {},
) {
  const printer: Printer = {
    id: 1,
    name: "Printer A",
    status: options.previousStatus ?? "PRINTING",
    type: "test",
  };
  const db = makeDb(printer);
  getDriver.mockReturnValue({
    getStatus: jest.fn().mockResolvedValue({
      status,
      progress: 42,
      timeRemaining: 600,
      currentFile: options.currentFile ?? null,
    }),
  });
  return { db, poller: new PrinterPoller(db), printer };
}

describe("PrinterPoller", () => {
  beforeEach(() => {
    getDriver.mockReset();
  });

  test("holds a printer with an active job when it transitions to FINISHED", async () => {
    const { db, poller, printer } = createPoller("FINISHED");
    const statusChange = jest.fn();
    poller.on("statusChange", statusChange);

    await poller._pollPrinter(printer);

    expect(db.runs[0]).toEqual(["FINISHED", printer.id]);
    expect(statusChange).toHaveBeenCalledWith({
      printer,
      previousStatus: "PRINTING",
      newStatus: "FINISHED",
    });
  });

  test("emits printerIdle and holds an active job for a missed PRINTING to IDLE finish", async () => {
    const { db, poller, printer } = createPoller("IDLE");
    const printerIdle = jest.fn();
    poller.on("printerIdle", printerIdle);

    await poller._pollPrinter(printer);

    expect(db.runs[0]).toEqual(["IDLE", printer.id]);
    expect(printerIdle).toHaveBeenCalledWith({ printer: { ...printer, status: "IDLE" } });
  });

  test("persists the printer-reported filename and progress while PRINTING", async () => {
    const { db, poller, printer } = createPoller("PRINTING", {
      currentFile: "plate.gcode",
      previousStatus: "PRINTING",
    });

    await poller._pollPrinter(printer);

    expect(db.runs).toEqual([["plate.gcode", 42, 600, printer.id]]);
  });
});
