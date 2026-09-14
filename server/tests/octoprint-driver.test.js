// Unit tests for server/drivers/octoprint.js
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


const path = require('path');
const fs = require('fs');
const octoprint = require('../drivers/octoprint');

const GCODE_DIR = path.join(__dirname, '..', 'gcode');

const fakePrinter = { id: 1, name: 'OctoPi_01', ip: '192.168.1.240:5000', model: 'mk3s', type: 'octoprint', api_key: 'test-key' };

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

function printerResponse(flags) {
  return { data: { state: { flags: { operational: true, printing: false, paused: false, pausing: false, cancelling: false, error: false, closedOrError: false, ready: true, ...flags } } } };
}

function jobResponse({ completion = null, printTimeLeft = null, filename = null } = {}) {
  return {
    data: {
      progress: { completion, printTimeLeft },
      job: { file: { name: filename } },
    },
  };
}

function mockPair(printerFlags, jobOpts) {
  httpMock.get.mockImplementation((url) => {
    if (url.includes('/api/printer')) return Promise.resolve(printerResponse(printerFlags));
    if (url.includes('/api/job')) return Promise.resolve(jobResponse(jobOpts));
    return Promise.reject(new Error(`unexpected url ${url}`));
  });
}

// ─── getStatus ────────────────────────────────────────────────────────────────

describe('getStatus', () => {
  test('returns IDLE when operational with no job loaded', async () => {
    mockPair({}, {});
    const result = await octoprint.getStatus(fakePrinter);
    expect(result.status).toBe('IDLE');
    expect(result.progress).toBeNull();
    expect(result.timeRemaining).toBeNull();
  });

  test('returns PRINTING with progress, time remaining, and current file', async () => {
    mockPair({ printing: true }, { completion: 42, printTimeLeft: 600, filename: 'part.gcode' });
    const result = await octoprint.getStatus(fakePrinter);
    expect(result.status).toBe('PRINTING');
    expect(result.progress).toBe(42);
    expect(result.timeRemaining).toBe(600);
    expect(result.currentFile).toBe('part.gcode');
  });

  test('returns PRINTING while cancelling (transitional state)', async () => {
    mockPair({ cancelling: true }, { completion: 80, filename: 'part.gcode' });
    const result = await octoprint.getStatus(fakePrinter);
    expect(result.status).toBe('PRINTING');
  });

  test('returns PAUSED', async () => {
    mockPair({ paused: true }, { completion: 30, filename: 'part.gcode' });
    const result = await octoprint.getStatus(fakePrinter);
    expect(result.status).toBe('PAUSED');
  });

  test('returns FINISHED when not printing, job file present, completion is 100', async () => {
    mockPair({}, { completion: 100, filename: 'part.gcode' });
    const result = await octoprint.getStatus(fakePrinter);
    expect(result.status).toBe('FINISHED');
    expect(result.progress).toBeNull();
  });

  test('returns IDLE (not FINISHED) when completion is 100 but no job file loaded', async () => {
    mockPair({}, { completion: 100, filename: null });
    const result = await octoprint.getStatus(fakePrinter);
    expect(result.status).toBe('IDLE');
  });

  test('returns ERROR when error flag is set', async () => {
    mockPair({ error: true }, {});
    const result = await octoprint.getStatus(fakePrinter);
    expect(result.status).toBe('ERROR');
  });

  test('returns ERROR when closedOrError flag is set', async () => {
    mockPair({ operational: false, closedOrError: true }, {});
    const result = await octoprint.getStatus(fakePrinter);
    expect(result.status).toBe('ERROR');
  });

  test('returns UNKNOWN when not operational and no error flag', async () => {
    mockPair({ operational: false }, {});
    const result = await octoprint.getStatus(fakePrinter);
    expect(result.status).toBe('UNKNOWN');
  });

  test('returns OFFLINE on network error', async () => {
    httpMock.get.mockRejectedValue(new Error('ETIMEDOUT'));
    const result = await octoprint.getStatus(fakePrinter);
    expect(result.status).toBe('OFFLINE');
    expect(result.progress).toBeNull();
  });

  test('queries /api/printer and /api/job with X-Api-Key header', async () => {
    mockPair({}, {});
    await octoprint.getStatus(fakePrinter);
    expect(httpMock.get).toHaveBeenCalledWith(
      'http://192.168.1.240:5000/api/printer',
      expect.objectContaining({ headers: { 'X-Api-Key': 'test-key' } })
    );
    expect(httpMock.get).toHaveBeenCalledWith(
      'http://192.168.1.240:5000/api/job',
      expect.objectContaining({ headers: { 'X-Api-Key': 'test-key' } })
    );
  });
});

// ─── uploadAndPrint ───────────────────────────────────────────────────────────

describe('uploadAndPrint', () => {
  test('POSTs to /api/files/local with select and print form fields', async () => {
    const filename = `octoprint_upload_${Date.now()}.gcode`;
    const fullPath = createTestFile(filename);
    httpMock.post.mockResolvedValueOnce({});

    await octoprint.uploadAndPrint(fakePrinter, fullPath, filename);

    const [url, form, config] = httpMock.post.mock.calls[0];
    expect(url).toBe('http://192.168.1.240:5000/api/files/local');
    expect(config.headers['X-Api-Key']).toBe('test-key');
    expect(form).toBeInstanceOf(FormData);
    expect(form.get('select')).toBe('true');
    expect(form.get('print')).toBe('true');
    expect(form.get('file')).toBeInstanceOf(Blob);
  });

  test('throws UPLOAD_CONFLICT on 409 response', async () => {
    const filename = `octoprint_conflict_${Date.now()}.gcode`;
    const fullPath = createTestFile(filename);
    httpMock.post.mockRejectedValueOnce({ response: { status: 409 } });

    await expect(octoprint.uploadAndPrint(fakePrinter, fullPath, filename))
      .rejects.toMatchObject({ code: 'UPLOAD_CONFLICT' });
  });

  test('rethrows non-409 errors unchanged', async () => {
    const filename = `octoprint_fail_${Date.now()}.gcode`;
    const fullPath = createTestFile(filename);
    httpMock.post.mockRejectedValueOnce(new Error('Request failed with status code 500'));

    await expect(octoprint.uploadAndPrint(fakePrinter, fullPath, filename))
      .rejects.toThrow('500');
  });
});

// ─── cancelJob ─────────────────────────────────────────────────────────────────

describe('cancelJob', () => {
  test('POSTs cancel command to /api/job', async () => {
    httpMock.post.mockResolvedValueOnce({});
    await octoprint.cancelJob(fakePrinter);
    expect(httpMock.post).toHaveBeenCalledWith(
      'http://192.168.1.240:5000/api/job',
      JSON.stringify({ command: 'cancel' }),
      expect.objectContaining({
        headers: { 'X-Api-Key': 'test-key', 'Content-Type': 'application/json' },
        timeout: 10000,
      })
    );
  });

  test('swallows errors', async () => {
    httpMock.post.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(octoprint.cancelJob(fakePrinter)).resolves.toBeUndefined();
  });
});

// ─── checkIfPrinting ─────────────────────────────────────────────────────────

describe('checkIfPrinting', () => {
  test('returns true when printing', async () => {
    httpMock.get.mockResolvedValueOnce(printerResponse({ printing: true }));
    expect(await octoprint.checkIfPrinting(fakePrinter)).toBe(true);
  });

  test('returns true when paused', async () => {
    httpMock.get.mockResolvedValueOnce(printerResponse({ paused: true }));
    expect(await octoprint.checkIfPrinting(fakePrinter)).toBe(true);
  });

  test('returns false when idle', async () => {
    httpMock.get.mockResolvedValueOnce(printerResponse({}));
    expect(await octoprint.checkIfPrinting(fakePrinter)).toBe(false);
  });

  test('returns false when printer is unreachable', async () => {
    httpMock.get.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    expect(await octoprint.checkIfPrinting(fakePrinter)).toBe(false);
  });
});

// ─── Driver registry ──────────────────────────────────────────────────────────

describe('driver registry', () => {
  const { getDriver } = require('../drivers');

  test('getDriver("octoprint") returns the octoprint driver', () => {
    const driver = getDriver('octoprint');
    expect(typeof driver.getStatus).toBe('function');
    expect(typeof driver.uploadAndPrint).toBe('function');
    expect(typeof driver.cancelJob).toBe('function');
    expect(typeof driver.checkIfPrinting).toBe('function');
  });
});
