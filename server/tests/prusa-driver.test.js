// Unit tests for server/drivers/prusa.js
// All network calls are mocked — no real printers needed.

jest.mock("../http", () => ({
  requestJson: jest.fn(),
  requestEmpty: jest.fn(),
  fileBlob: jest.fn(
    (filePath) =>
      new Blob([require("fs").readFileSync(filePath)], { type: "application/octet-stream" }),
  ),
}));
const http = require("../http");
const httpMock = { get: jest.fn(), post: jest.fn(), put: jest.fn(), delete: jest.fn() };

async function adapterRequest(
  url,
  { method = "GET", headers, body, query, timeoutMs = 8000 } = {},
) {
  const config = { headers, timeout: timeoutMs };
  if (query) config.params = query;
  try {
    if (method === "GET") return await httpMock.get(url, config);
    if (method === "DELETE") return await httpMock.delete(url, config);
    if (method === "PUT") return await httpMock.put(url, body, config);
    return await httpMock.post(url, body, config);
  } catch (err) {
    if (err.response && err.status === undefined) err.status = err.response.status;
    throw err;
  }
}

http.requestJson.mockImplementation(
  async (url, options) => (await adapterRequest(url, options)).data,
);
http.requestEmpty.mockImplementation(async (url, options) => {
  await adapterRequest(url, options);
});

const path = require("path");
const fs = require("fs");
const prusa = require("../drivers/prusa");

const GCODE_DIR = path.join(__dirname, "..", "gcode");

const fakePrinter = {
  id: 1,
  name: "MK4S_01",
  ip: "192.168.1.100",
  api_key: "testkey",
  model: "mk4s",
  type: "prusa",
};

// Files written during tests — cleaned up after all tests complete
const filesToClean = [];

beforeAll(() => {
  if (!fs.existsSync(GCODE_DIR)) fs.mkdirSync(GCODE_DIR, { recursive: true });
});

afterAll(() => {
  for (const p of filesToClean) {
    try {
      fs.unlinkSync(p);
    } catch (_) {}
  }
});

beforeEach(() => {
  // Default: DELETE and PUT succeed
  httpMock.delete.mockResolvedValue({});
  httpMock.put.mockImplementation((_url, data) => {
    if (data && typeof data.destroy === "function") {
      data.on("error", () => {});
      data.destroy();
    }
    return Promise.resolve({});
  });
});

afterEach(() => {
  jest.clearAllMocks();
});

function createTestFile(filename) {
  const filePath = path.join(GCODE_DIR, filename);
  fs.writeFileSync(filePath, "fake gcode content");
  filesToClean.push(filePath);
  return filePath;
}

// ─── getStatus ────────────────────────────────────────────────────────────────

describe("getStatus", () => {
  test("returns IDLE status when PrusaLink reports IDLE", async () => {
    httpMock.get.mockResolvedValueOnce({ data: { printer: { state: "IDLE" } } });
    const result = await prusa.getStatus(fakePrinter);
    expect(result.status).toBe("IDLE");
    expect(result.progress).toBeNull();
    expect(result.timeRemaining).toBeNull();
  });

  test("returns PRINTING with progress and timeRemaining when job data is present", async () => {
    httpMock.get.mockResolvedValueOnce({
      data: {
        printer: { state: "PRINTING" },
        job: { progress: 42.5, time_remaining: 1800 },
      },
    });
    const result = await prusa.getStatus(fakePrinter);
    expect(result.status).toBe("PRINTING");
    expect(result.progress).toBe(42.5);
    expect(result.timeRemaining).toBe(1800);
  });

  test("returns PRINTING with null progress when job field is absent", async () => {
    httpMock.get.mockResolvedValueOnce({ data: { printer: { state: "PRINTING" } } });
    const result = await prusa.getStatus(fakePrinter);
    expect(result.status).toBe("PRINTING");
    expect(result.progress).toBeNull();
    expect(result.timeRemaining).toBeNull();
  });

  test("returns FINISHED status", async () => {
    httpMock.get.mockResolvedValueOnce({ data: { printer: { state: "FINISHED" } } });
    const result = await prusa.getStatus(fakePrinter);
    expect(result.status).toBe("FINISHED");
  });

  test("normalises lowercase state to uppercase", async () => {
    httpMock.get.mockResolvedValueOnce({ data: { printer: { state: "printing" } } });
    const result = await prusa.getStatus(fakePrinter);
    expect(result.status).toBe("PRINTING");
  });

  test("returns OFFLINE on network error", async () => {
    httpMock.get.mockRejectedValueOnce(new Error("ETIMEDOUT"));
    const result = await prusa.getStatus(fakePrinter);
    expect(result.status).toBe("OFFLINE");
    expect(result.progress).toBeNull();
    expect(result.timeRemaining).toBeNull();
  });

  test("returns OFFLINE on HTTP error response", async () => {
    const err = new Error("Request failed with status code 503");
    err.response = { status: 503 };
    httpMock.get.mockRejectedValueOnce(err);
    const result = await prusa.getStatus(fakePrinter);
    expect(result.status).toBe("OFFLINE");
  });

  test("uses correct PrusaLink URL and API key header", async () => {
    httpMock.get.mockResolvedValueOnce({ data: { printer: { state: "IDLE" } } });
    await prusa.getStatus(fakePrinter);
    expect(httpMock.get).toHaveBeenCalledWith(
      `http://${fakePrinter.ip}/api/v1/status`,
      expect.objectContaining({ headers: { "X-Api-Key": fakePrinter.api_key } }),
    );
  });
});

// ─── uploadAndPrint ───────────────────────────────────────────────────────────

describe("uploadAndPrint", () => {
  test("deletes existing file then uploads with Print-After-Upload header", async () => {
    const filename = `upload_ok_${Date.now()}.bgcode`;
    const fullPath = createTestFile(filename);

    await prusa.uploadAndPrint(fakePrinter, fullPath, filename);

    expect(httpMock.delete).toHaveBeenCalledWith(
      `http://${fakePrinter.ip}/api/v1/files/usb/${encodeURIComponent(filename)}`,
      expect.objectContaining({ headers: { "X-Api-Key": fakePrinter.api_key } }),
    );
    expect(httpMock.put).toHaveBeenCalledWith(
      `http://${fakePrinter.ip}/api/v1/files/usb/${encodeURIComponent(filename)}`,
      expect.anything(),
      expect.objectContaining({
        headers: expect.objectContaining({ "Print-After-Upload": "1" }),
      }),
    );
  });

  test("throws UPLOAD_CONFLICT when DELETE returns 409", async () => {
    const filename = `conflict_del_${Date.now()}.bgcode`;
    const fullPath = createTestFile(filename);

    httpMock.delete.mockRejectedValueOnce(
      Object.assign(new Error("409"), { response: { status: 409 } }),
    );

    await expect(prusa.uploadAndPrint(fakePrinter, fullPath, filename)).rejects.toMatchObject({
      code: "UPLOAD_CONFLICT",
    });

    // Should not attempt PUT when DELETE conflicted
    expect(httpMock.put).not.toHaveBeenCalled();
  });

  test("throws UPLOAD_CONFLICT when PUT returns 409", async () => {
    const filename = `conflict_put_${Date.now()}.bgcode`;
    const fullPath = createTestFile(filename);

    httpMock.delete.mockResolvedValueOnce({});
    httpMock.put.mockImplementationOnce((_url, data) => {
      if (data && typeof data.destroy === "function") {
        data.on("error", () => {});
        data.destroy();
      }
      return Promise.reject(Object.assign(new Error("409"), { response: { status: 409 } }));
    });

    await expect(prusa.uploadAndPrint(fakePrinter, fullPath, filename)).rejects.toMatchObject({
      code: "UPLOAD_CONFLICT",
    });
  });

  test("does not throw UPLOAD_CONFLICT for non-409 PUT errors — passes through original error", async () => {
    const filename = `neterr_${Date.now()}.bgcode`;
    const fullPath = createTestFile(filename);

    httpMock.delete.mockResolvedValueOnce({});
    httpMock.put.mockImplementationOnce((_url, data) => {
      if (data && typeof data.destroy === "function") {
        data.on("error", () => {});
        data.destroy();
      }
      return Promise.reject(new Error("ECONNRESET"));
    });

    await expect(prusa.uploadAndPrint(fakePrinter, fullPath, filename)).rejects.toMatchObject({
      message: "ECONNRESET",
    });
  });

  test("proceeds with PUT when DELETE returns 404 (file was not there)", async () => {
    const filename = `no_prior_${Date.now()}.bgcode`;
    const fullPath = createTestFile(filename);

    httpMock.delete.mockRejectedValueOnce(
      Object.assign(new Error("404"), { response: { status: 404 } }),
    );

    await prusa.uploadAndPrint(fakePrinter, fullPath, filename);
    expect(httpMock.put).toHaveBeenCalledTimes(1);
  });
});

// ─── checkIfPrinting ─────────────────────────────────────────────────────────

describe("checkIfPrinting", () => {
  test("returns true when PrusaLink reports PRINTING", async () => {
    httpMock.get.mockResolvedValueOnce({ data: { printer: { state: "PRINTING" } } });
    expect(await prusa.checkIfPrinting(fakePrinter)).toBe(true);
  });

  test("returns true when PrusaLink reports PAUSED", async () => {
    httpMock.get.mockResolvedValueOnce({ data: { printer: { state: "PAUSED" } } });
    expect(await prusa.checkIfPrinting(fakePrinter)).toBe(true);
  });

  test("returns false when PrusaLink reports IDLE", async () => {
    httpMock.get.mockResolvedValueOnce({ data: { printer: { state: "IDLE" } } });
    expect(await prusa.checkIfPrinting(fakePrinter)).toBe(false);
  });

  test("returns false when printer is unreachable", async () => {
    httpMock.get.mockRejectedValueOnce(new Error("ETIMEDOUT"));
    expect(await prusa.checkIfPrinting(fakePrinter)).toBe(false);
  });

  test("is case-insensitive — lowercase state is matched", async () => {
    httpMock.get.mockResolvedValueOnce({ data: { printer: { state: "printing" } } });
    expect(await prusa.checkIfPrinting(fakePrinter)).toBe(true);
  });
});

// ─── Driver registry ─────────────────────────────────────────────────────────

describe("driver registry (drivers/index.js)", () => {
  const { getDriver } = require("../drivers");

  test('getDriver("prusa") returns the prusa driver', () => {
    const driver = getDriver("prusa");
    expect(typeof driver.getStatus).toBe("function");
    expect(typeof driver.uploadAndPrint).toBe("function");
    expect(typeof driver.checkIfPrinting).toBe("function");
    expect(typeof driver.cancelJob).toBe("function");
  });

  test("getDriver throws for unknown type", () => {
    expect(() => getDriver("unknown-brand")).toThrow(/No driver registered/);
  });
});
