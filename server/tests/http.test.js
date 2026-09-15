const { HttpError, requestJson, requestEmpty, requestRaw, withQuery } = require('../http');

const originalFetch = global.fetch;

function jsonResponse(body, status = 200, statusText = 'OK') {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    json: jest.fn().mockResolvedValue(body),
    text: jest.fn().mockResolvedValue(JSON.stringify(body)),
  };
}

describe('withQuery', () => {
  test('preserves empty values required by Moonraker object queries', () => {
    expect(withQuery('http://printer.local/printer/objects/query', {
      print_stats: '',
      virtual_sdcard: '',
      webhooks: '',
    })).toBe('http://printer.local/printer/objects/query?print_stats=&virtual_sdcard=&webhooks=');
  });

  test('omits null and undefined values', () => {
    expect(withQuery('http://printer.local/status', { present: 'yes', no: null, missing: undefined }))
      .toBe('http://printer.local/status?present=yes');
  });
});

describe('requestJson', () => {
  beforeEach(() => {
    global.fetch = jest.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('sends headers, query values, and the configured timeout signal', async () => {
    global.fetch.mockResolvedValueOnce(jsonResponse({ state: 'IDLE' }));

    await expect(requestJson('http://printer.local/status', {
      headers: { 'X-Api-Key': 'test-key' },
      query: { detail: 'full' },
      timeoutMs: 1234,
    })).resolves.toEqual({ state: 'IDLE' });

    expect(global.fetch).toHaveBeenCalledWith(
      'http://printer.local/status?detail=full',
      expect.objectContaining({
        method: 'GET',
        headers: { 'X-Api-Key': 'test-key' },
        signal: expect.any(AbortSignal),
      })
    );
  });

  test('returns null for a successful empty response', async () => {
    global.fetch.mockResolvedValueOnce(jsonResponse(null, 204, 'No Content'));

    await expect(requestJson('http://printer.local/status')).resolves.toBeNull();
  });

  test('throws an HttpError with the response status and body for non-success responses', async () => {
    global.fetch.mockResolvedValueOnce(jsonResponse({ error: 'transfer busy' }, 409, 'Conflict'));

    await expect(requestJson('http://printer.local/upload')).rejects.toMatchObject({
      name: 'HttpError',
      status: 409,
      body: JSON.stringify({ error: 'transfer busy' }),
    });
  });

  test('does not wrap network failures', async () => {
    const networkError = new Error('connect ECONNREFUSED');
    global.fetch.mockRejectedValueOnce(networkError);

    await expect(requestJson('http://printer.local/status')).rejects.toBe(networkError);
  });
});

describe('requestEmpty and requestRaw', () => {
  beforeEach(() => { global.fetch = jest.fn(); });
  afterEach(() => { global.fetch = originalFetch; });

  test('accepts a successful non-JSON response without parsing it', async () => {
    const response = { ok: true, status: 200, statusText: 'OK', arrayBuffer: jest.fn().mockResolvedValue(new ArrayBuffer(0)) };
    global.fetch.mockResolvedValueOnce(response);
    await expect(requestEmpty('http://printer.local/upload', { method: 'PUT' })).resolves.toBeUndefined();
    expect(response.arrayBuffer).toHaveBeenCalledTimes(1);

    global.fetch.mockResolvedValueOnce(response);
    await expect(requestRaw('http://printer.local/download')).resolves.toBe(response);
  });

  test('enables duplex mode for a Node readable upload stream', async () => {
    const { Readable } = require('stream');
    global.fetch.mockResolvedValueOnce({ ok: true, status: 200, statusText: 'OK', arrayBuffer: jest.fn().mockResolvedValue(new ArrayBuffer(0)) });
    await requestEmpty('http://printer.local/upload', { method: 'PUT', body: Readable.from('gcode') });
    expect(global.fetch).toHaveBeenCalledWith('http://printer.local/upload', expect.objectContaining({ duplex: 'half' }));
  });
});

test('HttpError has a useful message', () => {
  const response = { status: 500, statusText: 'Internal Server Error' };
  expect(new HttpError(response, 'printer error').message).toBe('HTTP 500 Internal Server Error');
});
