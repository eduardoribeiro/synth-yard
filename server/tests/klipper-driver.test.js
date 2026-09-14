// Unit tests for server/drivers/klipper.js
// All network calls are mocked — no real printers needed.

jest.mock('../http', () => ({
  requestJson: jest.fn(),
  requestEmpty: jest.fn(),
  fileBlob: jest.fn(filePath => new Blob([require('fs').readFileSync(filePath)], { type: 'application/octet-stream' })),
}));
const http = require('../http');
const httpMock = { get: jest.fn(), post: jest.fn(), put: jest.fn(), delete: jest.fn() };

async function adapterRequest(url, { method = 'GET', headers, body, query, timeoutMs = 8000 } = {}) {
  const config = { headers, timeout: timeoutMs };
  if (query) config.params = query;
  if (body instanceof FormData) {
    config.headers = { ...headers, 'content-type': 'multipart/form-data; boundary=native' };
  }
  try {
    if (method === 'GET') return await httpMock.get(url, config);
    if (method === 'DELETE') return await httpMock.delete(url, config);
    if (method === 'PUT') return await httpMock.put(url, body, config);
    return await httpMock.post(url, body, config);
  } catch (err) {
    if (err.response && err.status === undefined) err.status = err.response.status;
    throw err;
  }
}

http.requestJson.mockImplementation(async (url, options) => (await adapterRequest(url, options)).data);
http.requestEmpty.mockImplementation(async (url, options) => { await adapterRequest(url, options); });


const path   = require('path');
const fs     = require('fs');
const klipper = require('../drivers/klipper');

const GCODE_DIR = path.join(__dirname, '..', 'gcode');

const fakePrinter = { id: 1, name: 'Voron_01', ip: '192.168.1.250', model: 'voron-24', type: 'klipper' };

const filesToClean = [];

beforeAll(() => {
  if (!fs.existsSync(GCODE_DIR)) fs.mkdirSync(GCODE_DIR, { recursive: true });
});

afterAll(() => {
  for (const p of filesToClean) {
    try { fs.unlinkSync(p); } catch (_) {}
  }
});

afterEach(() => {
  jest.clearAllMocks();
});

function createTestFile(filename) {
  const filePath = path.join(GCODE_DIR, filename);
  fs.writeFileSync(filePath, '; fake gcode');
  filesToClean.push(filePath);
  return filePath;
}

function moonrakerResponse(printState, vsdProgress = 0, elapsed = 0, webhookState = 'ready') {
  return {
    data: {
      result: {
        status: {
          print_stats: {
            state: printState,
            print_duration: elapsed,
            filename: printState !== 'standby' ? 'test.gcode' : '',
          },
          virtual_sdcard: { progress: vsdProgress },
          webhooks: { state: webhookState },
        },
      },
    },
  };
}

// ─── getStatus ────────────────────────────────────────────────────────────────

describe('getStatus', () => {
  test('returns IDLE when Moonraker state is standby', async () => {
    httpMock.get.mockResolvedValueOnce(moonrakerResponse('standby'));
    const result = await klipper.getStatus(fakePrinter);
    expect(result.status).toBe('IDLE');
    expect(result.progress).toBeNull();
    expect(result.timeRemaining).toBeNull();
  });

  test('returns PRINTING with progress when printing and past 2% threshold', async () => {
    httpMock.get.mockResolvedValueOnce(moonrakerResponse('printing', 0.5, 600));
    const result = await klipper.getStatus(fakePrinter);
    expect(result.status).toBe('PRINTING');
    expect(result.progress).toBe(50);
    expect(result.timeRemaining).toBe(600); // 600s elapsed at 50% → 600s remaining
    expect(result.currentFile).toBe('test.gcode');
  });

  test('returns PRINTING with null timeRemaining when progress is below 2% threshold', async () => {
    httpMock.get.mockResolvedValueOnce(moonrakerResponse('printing', 0.01, 30));
    const result = await klipper.getStatus(fakePrinter);
    expect(result.status).toBe('PRINTING');
    expect(result.progress).toBe(1);
    expect(result.timeRemaining).toBeNull();
  });

  test('returns PAUSED with progress', async () => {
    httpMock.get.mockResolvedValueOnce(moonrakerResponse('paused', 0.3, 300));
    const result = await klipper.getStatus(fakePrinter);
    expect(result.status).toBe('PAUSED');
    expect(result.progress).toBe(30);
  });

  test('returns FINISHED when Moonraker state is complete', async () => {
    httpMock.get.mockResolvedValueOnce(moonrakerResponse('complete'));
    const result = await klipper.getStatus(fakePrinter);
    expect(result.status).toBe('FINISHED');
    expect(result.progress).toBeNull();
    expect(result.timeRemaining).toBeNull();
  });

  test('returns ERROR when Moonraker state is error', async () => {
    httpMock.get.mockResolvedValueOnce(moonrakerResponse('error'));
    const result = await klipper.getStatus(fakePrinter);
    expect(result.status).toBe('ERROR');
  });

  test('returns STOPPED when Moonraker state is cancelled', async () => {
    httpMock.get.mockResolvedValueOnce(moonrakerResponse('cancelled'));
    const result = await klipper.getStatus(fakePrinter);
    expect(result.status).toBe('STOPPED');
  });

  test('returns OFFLINE when webhooks.state is not ready (e.g. startup)', async () => {
    httpMock.get.mockResolvedValueOnce(moonrakerResponse('standby', 0, 0, 'startup'));
    const result = await klipper.getStatus(fakePrinter);
    expect(result.status).toBe('OFFLINE');
  });

  test('returns OFFLINE on network error', async () => {
    httpMock.get.mockRejectedValueOnce(new Error('ETIMEDOUT'));
    const result = await klipper.getStatus(fakePrinter);
    expect(result.status).toBe('OFFLINE');
    expect(result.progress).toBeNull();
  });

  test('returns UNKNOWN for an unrecognised Moonraker state', async () => {
    httpMock.get.mockResolvedValueOnce(moonrakerResponse('some_future_state'));
    const result = await klipper.getStatus(fakePrinter);
    expect(result.status).toBe('UNKNOWN');
  });

  test('queries correct Moonraker URL on port 7125 with required object params', async () => {
    httpMock.get.mockResolvedValueOnce(moonrakerResponse('standby'));
    await klipper.getStatus(fakePrinter);
    expect(httpMock.get).toHaveBeenCalledWith(
      'http://192.168.1.250:7125/printer/objects/query',
      expect.objectContaining({
        params: { print_stats: '', virtual_sdcard: '', webhooks: '' },
      })
    );
  });

  test('strips http:// prefix from ip field when building URL', async () => {
    const messyPrinter = { ...fakePrinter, ip: 'http://192.168.1.250/' };
    httpMock.get.mockResolvedValueOnce(moonrakerResponse('standby'));
    await klipper.getStatus(messyPrinter);
    expect(httpMock.get).toHaveBeenCalledWith(
      'http://192.168.1.250:7125/printer/objects/query',
      expect.anything()
    );
  });
});

// ─── uploadAndPrint ───────────────────────────────────────────────────────────

describe('uploadAndPrint', () => {
  test('POSTs to /server/files/upload with print=true as a form field', async () => {
    const filename = `klipper_upload_${Date.now()}.gcode`;
    const fullPath = createTestFile(filename);
    httpMock.post.mockResolvedValueOnce({});

    await klipper.uploadAndPrint(fakePrinter, fullPath, filename);

    const [url, form, config] = httpMock.post.mock.calls[0];
    expect(url).toBe('http://192.168.1.250:7125/server/files/upload');
    expect(form).toBeInstanceOf(FormData);

    // print must be a form field, query params are silently ignored by Moonraker
    expect(form.get('print')).toBe('true');
    expect(form.get('file')).toBeInstanceOf(Blob);
    expect(config?.params?.print).toBeUndefined();
  });

  test('throws when upload fails', async () => {
    const filename = `klipper_fail_${Date.now()}.gcode`;
    const fullPath = createTestFile(filename);
    httpMock.post.mockRejectedValueOnce(new Error('Request failed with status code 405'));

    await expect(klipper.uploadAndPrint(fakePrinter, fullPath, filename))
      .rejects.toThrow('405');
  });
});

// ─── checkIfPrinting ─────────────────────────────────────────────────────────

describe('checkIfPrinting', () => {
  test('returns true when Moonraker state is printing', async () => {
    httpMock.get.mockResolvedValueOnce(moonrakerResponse('printing', 0.5, 300));
    expect(await klipper.checkIfPrinting(fakePrinter)).toBe(true);
  });

  test('returns true when Moonraker state is paused', async () => {
    httpMock.get.mockResolvedValueOnce(moonrakerResponse('paused', 0.5, 300));
    expect(await klipper.checkIfPrinting(fakePrinter)).toBe(true);
  });

  test('returns false when Moonraker state is standby', async () => {
    httpMock.get.mockResolvedValueOnce(moonrakerResponse('standby'));
    expect(await klipper.checkIfPrinting(fakePrinter)).toBe(false);
  });

  test('returns false when printer is unreachable', async () => {
    httpMock.get.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    expect(await klipper.checkIfPrinting(fakePrinter)).toBe(false);
  });
});

// ─── Driver registry ──────────────────────────────────────────────────────────

describe('driver registry', () => {
  const { getDriver } = require('../drivers');

  test('getDriver("klipper") returns the klipper driver', () => {
    const driver = getDriver('klipper');
    expect(typeof driver.getStatus).toBe('function');
    expect(typeof driver.uploadAndPrint).toBe('function');
    expect(typeof driver.cancelJob).toBe('function');
    expect(typeof driver.checkIfPrinting).toBe('function');
  });
});
