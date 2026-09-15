class HttpError extends Error {
  constructor(response, body) {
    super(`HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`);
    this.name = "HttpError";
    this.status = response.status;
    this.body = body;
  }
}

function withQuery(url, query) {
  if (!query) return url;

  const target = new URL(url);
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    target.searchParams.set(key, String(value));
  }
  return target.toString();
}

async function readErrorBody(response) {
  try {
    return await response.text();
  } catch (_) {
    return "";
  }
}

function requestOptions({ method = "GET", headers, body, timeoutMs = 8000 }) {
  const options = {
    method,
    headers,
    body,
    signal: AbortSignal.timeout(timeoutMs),
  };

  // Undici requires duplex when a Node readable stream is the request body.
  if (body && typeof body.pipe === "function") options.duplex = "half";
  return options;
}

async function requestRaw(url, options = {}) {
  const response = await fetch(withQuery(url, options.query), requestOptions(options));
  if (!response.ok) {
    throw new HttpError(response, await readErrorBody(response));
  }
  return response;
}

async function requestJson(url, options = {}) {
  const response = await requestRaw(url, options);
  if (response.status === 204) return null;
  return response.json();
}

async function requestEmpty(url, options = {}) {
  const response = await requestRaw(url, options);
  // Drain successful response bodies so Undici can release the connection for
  // later printer requests in this long-lived server process.
  await response.arrayBuffer();
}

function fileBlob(filePath, type = "application/octet-stream") {
  return new Blob([require("fs").readFileSync(filePath)], { type });
}

module.exports = { HttpError, requestJson, requestEmpty, requestRaw, fileBlob, withQuery };
