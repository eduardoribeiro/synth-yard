jest.mock('axios');
const axios = require('axios');
const fs = require('fs');
const os = require('os');
const path = require('path');
const driver = require('../drivers/creality');
const printer = { id: 1, name: 'K1', ip: '192.168.1.50', type: 'creality' };
const originalWebSocket = global.WebSocket;
let scenarios, sockets, directory, file;

class FakeSocket {
  constructor(url) {
    this.url = url;
    this.listeners = {};
    this.sent = [];
    this.closed = false;
    this.scenario = scenarios.shift() || {};
    sockets.push(this);
    setTimeout(() => this.emit(this.scenario.fail || 'open'), 0);
  }
  addEventListener(event, listener) { (this.listeners[event] ||= []).push(listener); }
  emit(event, data) { for (const listener of this.listeners[event] || []) listener(data); }
  send(payload) {
    const message = JSON.parse(payload);
    this.sent.push(message);
    if (message.method === 'get') {
      (this.scenario.frames || []).forEach((frame, index) => {
        setTimeout(() => {
          if (!this.closed) this.emit('message', { data: typeof frame === 'string' ? frame : JSON.stringify(frame) });
        }, 20 * (index + 1));
      });
    }
  }
  close() { this.closed = true; this.emit('close'); }
}

beforeAll(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'creality-test-'));
  file = path.join(directory, 'part.gcode');
  fs.writeFileSync(file, '; test gcode');
});
afterAll(() => { fs.rmSync(directory, { recursive: true }); });
beforeEach(() => {
  jest.useFakeTimers();
  scenarios = [];
  sockets = [];
  global.WebSocket = FakeSocket;
  axios.post.mockResolvedValue({ data: { code: 0 } });
});
afterEach(() => {
  global.WebSocket = originalWebSocket;
  jest.useRealTimers();
  jest.clearAllMocks();
});
async function settle(promise) {
  // Attach rejection handling before advancing timers.
  const result = promise.then(value => ({ value }), error => ({ error }));
  await jest.runAllTimersAsync();
  const outcome = await result;
  if (outcome.error) throw outcome.error;
  return outcome.value;
}

describe('Creality status', () => {
  test.each([
    [0, 'IDLE'], [1, 'PRINTING'], [2, 'FINISHED'], [3, 'ERROR'],
    [4, 'STOPPED'], [5, 'PAUSED'], ['1', 'PRINTING'], ['print', 'PRINTING'],
    ['free', 'IDLE'], ['paused', 'PAUSED'], ['aborted', 'STOPPED'], ['future-state', 'UNKNOWN'],
  ])('maps %s to %s', async (state, expected) => {
    scenarios.push({ frames: [{ deviceState: state }] });
    expect((await settle(driver.getStatus(printer))).status).toBe(expected);
    expect(sockets[0].closed).toBe(true);
  });

  test('combines fragmented telemetry, honors pause, and estimates remaining seconds', async () => {
    scenarios.push({ frames: [
      'ok', '{broken', { deviceState: 1 }, { state: 5 },
      { printFileName: '/usr/data/printer_data/gcodes/part.gcode' },
      { dProgress: 25, printJobTime: 120 },
    ] });
    expect(await settle(driver.getStatus(printer))).toEqual({
      status: 'PAUSED', currentFile: 'part.gcode', progress: 25, timeRemaining: 360,
    });
  });

  test('keeps a preparing printer busy despite zero targets and stale stopped print state', async () => {
    scenarios.push({ frames: [{ deviceState: 1, state: 0, targetNozzleTemp: 0, targetBedTemp: 0 }] });
    expect((await settle(driver.getStatus(printer))).status).toBe('PRINTING');
  });

  test('falls back to layers when reported percentage is zero', async () => {
    scenarios.push({ frames: [{ deviceState: 1, printProgress: 0, layer: 20, TotalLayer: 80 }] });
    expect((await settle(driver.getStatus(printer))).progress).toBe(25);
  });

  test.each([{ fail: 'error' }, { fail: 'close' }, { frames: ['ok', {}, { printProgress: 10 }] }])(
    'reports OFFLINE for failed or incomplete telemetry: %j', async scenario => {
      scenarios.push(scenario);
      expect((await settle(driver.getStatus(printer))).status).toBe('OFFLINE');
      expect(sockets[0].closed).toBe(true);
    }
  );

  test('serializes concurrent polls to the same hostname', async () => {
    scenarios.push({ frames: [{ deviceState: 0 }] }, { frames: [{ deviceState: 1 }] });
    const first = driver.getStatus(printer);
    const second = driver.getStatus({ ...printer, ip: 'http://192.168.1.50:80/' });
    await jest.advanceTimersByTimeAsync(100);
    expect(sockets).toHaveLength(1);
    const results = await settle(Promise.all([first, second]));
    expect(results.map(r => r.status)).toEqual(['IDLE', 'PRINTING']);
    expect(sockets.every(s => s.closed)).toBe(true);
  });
});

describe('Creality upload and control', () => {
  test('uploads multipart G-code and confirms the exact start filename', async () => {
    scenarios.push(
      { frames: [{ deviceState: 0 }] },
      { frames: ['ok', { deviceState: 1 }, { printFileName: '/usr/data/printer_data/gcodes/my part.gcode' }] },
    );
    await settle(driver.uploadAndPrint({ ...printer, ip: 'http://192.168.1.50:8080/' }, file, 'my part.gcode'));
    expect(axios.post).toHaveBeenCalledTimes(1);
    const [url, form, config] = axios.post.mock.calls[0];
    expect(url).toBe('http://192.168.1.50:8080/upload/my%20part.gcode');
    expect(config.headers['content-type']).toMatch(/multipart\/form-data/);
    expect(form.getHeaders).toBeInstanceOf(Function);
    expect(sockets[1].url).toBe('ws://192.168.1.50:9999/');
    expect(sockets[1].sent[0]).toEqual({ method: 'set', params: {
      opGcodeFile: 'printprt:/usr/data/printer_data/gcodes/my part.gcode',
    } });
    expect(sockets.every(s => s.closed)).toBe(true);
  });

  test.each(['part.bgcode', 'part.3mf', '../part.gcode', 'dir\\part.gcode', 'bad\n.gcode'])(
    'rejects invalid filename %s before contacting the printer', async filename => {
      await expect(driver.uploadAndPrint(printer, file, filename)).rejects.toMatchObject({ retryable: false, recoverable: false });
      expect(sockets).toHaveLength(0);
      expect(axios.post).not.toHaveBeenCalled();
    }
  );

  test.each([1, 5, 3, 'unrecognized'])('does not upload to a printer with state %s', async deviceState => {
    scenarios.push({ frames: [{ deviceState }] });
    await expect(settle(driver.uploadAndPrint(printer, file, 'part.gcode'))).rejects.toMatchObject({ retryable: false, recoverable: false });
    expect(axios.post).not.toHaveBeenCalled();
  });

  test.each(['http', 'application'])('does not start after %s upload failure', async failure => {
    scenarios.push({ frames: [{ deviceState: 0 }] });
    if (failure === 'http') axios.post.mockRejectedValueOnce(new Error('HTTP 500'));
    else axios.post.mockResolvedValueOnce({ data: { code: 1, msg: 'disk full' } });
    await expect(settle(driver.uploadAndPrint(printer, file, 'part.gcode'))).rejects.toThrow();
    expect(sockets).toHaveLength(1);
  });

  test.each([
    ['ok'], [{ deviceState: 1, printFileName: 'other.gcode' }],
    [{ deviceState: 0, printFileName: 'part.gcode' }],
  ].map(frames => [frames]))('an unconfirmed start cannot be retried (%j)', async frames => {
    scenarios.push({ frames: [{ deviceState: 0 }] }, { frames });
    await expect(settle(driver.uploadAndPrint(printer, file, 'part.gcode'))).rejects.toMatchObject({ retryable: false });
    expect(sockets.every(s => s.closed)).toBe(true);
  });

  test('cancel waits for terminal telemetry after stop command', async () => {
    scenarios.push({ frames: ['ok', { deviceState: 0, state: 4 }] });
    await settle(driver.cancelJob(printer));
    expect(sockets[0].sent[0]).toEqual({ method: 'set', params: { stop: 1 } });
  });

  test('cancel fails if printer still reports printing', async () => {
    scenarios.push({ frames: [{ deviceState: 1, state: 4 }] });
    await expect(settle(driver.cancelJob(printer))).rejects.toThrow(/timed out/);
  });

  test('recovery requires the expected file, including when paused', async () => {
    scenarios.push({ frames: [{ deviceState: 5, printFileName: '/gcodes/part.gcode' }] });
    expect(await settle(driver.checkIfPrinting(printer, 'part.gcode'))).toBe(true);
    scenarios.push({ frames: [{ deviceState: 1, printFileName: 'other.gcode' }] });
    expect(await settle(driver.checkIfPrinting(printer, 'part.gcode'))).toBe(false);
  });

  test('registry loads the connector', () => {
    expect(require('../drivers').getDriver('creality')).toBe(driver);
  });
});
