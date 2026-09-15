// Stock Creality LAN: HTTP upload + WebSocket telemetry/control on port 9999.
// Protocol reference: https://github.com/ashimaryal25/printfarm
// See docs/creality.md and docs/licenses/printfarm-MIT.txt.
const { requestJson, fileBlob } = require("../http");

const GCODE_DIR = "/usr/data/printer_data/gcodes";
const REQUEST = { method: "get", params: { reqPrintObjects: {} } };
const EMPTY = { status: "OFFLINE", progress: null, timeRemaining: null, currentFile: null };
const queues = new Map();

function address(printer) {
  const url = new URL(`http://${printer.ip.trim().replace(/^https?:\/\//, "")}`);
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Creality IP must be a hostname or IP address, optionally with an HTTP port");
  }
  return { http: url.origin, ws: `ws://${url.hostname}:9999/` };
}

// Firmware accepts very few sockets. Serialize polls and controls for each host,
// including aliases entered with an HTTP prefix or port.
function exclusive(printer, operation) {
  const key = address(printer).ws;
  const previous = queues.get(key) || Promise.resolve();
  const result = previous.catch(() => {}).then(operation);
  queues.set(key, result);
  const cleanup = () => {
    if (queues.get(key) === result) queues.delete(key);
  };
  result.then(cleanup, cleanup);
  return result;
}

const STATES = {
  0: "IDLE",
  free: "IDLE",
  idle: "IDLE",
  stopped: "STOPPED",
  1: "PRINTING",
  print: "PRINTING",
  printing: "PRINTING",
  2: "FINISHED",
  complete: "FINISHED",
  completed: "FINISHED",
  3: "ERROR",
  failed: "ERROR",
  error: "ERROR",
  4: "STOPPED",
  abort: "STOPPED",
  aborted: "STOPPED",
  cancelled: "STOPPED",
  5: "PAUSED",
  pause: "PAUSED",
  paused: "PAUSED",
};
const stateOf = (value) => STATES[String(value ?? "").toLowerCase()] || "UNKNOWN";
function statusOf(raw) {
  const device = stateOf(raw.deviceState);
  const print = stateOf(raw.state);
  if (device === "PAUSED" || print === "PAUSED" || raw.pause === 1 || raw.paused === 1)
    return "PAUSED";
  // A live device must not appear idle because a terminal print state is stale.
  if (device === "PRINTING" || print === "PRINTING") return "PRINTING";
  return print !== "UNKNOWN" ? print : device;
}
const basename = (value) =>
  String(value || "")
    .split(/[\\/]/)
    .pop();
function number(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}
function normalize(raw) {
  const status = statusOf(raw);
  if (!["PRINTING", "PAUSED"].includes(status)) return { ...EMPTY, status };
  let progress = number(raw.dProgress ?? raw.printProgress);
  const layer = number(raw.layer),
    total = number(raw.TotalLayer);
  if (!(progress > 0) && layer > 0 && total > 0) progress = (layer / total) * 100;
  if (progress != null) progress = Math.round(Math.min(100, progress));
  const elapsed = number(raw.printJobTime);
  const timeRemaining =
    progress > 2 && elapsed > 0 ? Math.round((elapsed * (100 - progress)) / progress) : null;
  return { status, progress, timeRemaining, currentFile: basename(raw.printFileName) || null };
}

// Telemetry comes as several independent JSON frames. Collect a short snapshot
// for polls; for commands, wait for actual state/filename confirmation, not "ok".
function exchange(printer, { command, confirm, timeout = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    let ws,
      collectTimer,
      pollTimer,
      settled = false;
    const raw = {};
    const done = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(collectTimer);
      clearInterval(pollTimer);
      try {
        ws?.close();
      } catch (_) {}
      err ? reject(err) : resolve(raw);
    };
    const timer = setTimeout(
      () => done(new Error("Creality telemetry/command confirmation timed out")),
      timeout,
    );
    try {
      ws = new WebSocket(address(printer).ws);
    } catch (err) {
      done(err);
      return;
    }
    const send = (payload) => {
      try {
        ws.send(JSON.stringify(payload));
      } catch (err) {
        done(err);
      }
    };
    ws.addEventListener("open", () => {
      if (settled) return;
      if (command) send(command);
      if (settled) return;
      send(REQUEST);
      if (command && !settled) pollTimer = setInterval(() => send(REQUEST), 1000);
    });
    ws.addEventListener("message", ({ data }) => {
      if (settled || typeof data !== "string") return;
      let msg;
      try {
        msg = JSON.parse(data);
      } catch (_) {
        return;
      }
      if (!msg || typeof msg !== "object" || Array.isArray(msg)) return;
      for (const key of [
        "deviceState",
        "state",
        "pause",
        "paused",
        "printFileName",
        "printProgress",
        "dProgress",
        "printJobTime",
        "layer",
        "TotalLayer",
      ]) {
        if (msg[key] !== undefined) raw[key] = msg[key];
      }
      if (command) {
        if (!collectTimer && confirm(raw)) {
          collectTimer = setTimeout(() => {
            collectTimer = null;
            if (confirm(raw)) done();
          }, 400);
        }
      } else if (!collectTimer && (raw.deviceState != null || raw.state != null)) {
        collectTimer = setTimeout(() => done(), 400);
      }
    });
    ws.addEventListener("error", () => done(new Error("Creality WebSocket connection failed")));
    ws.addEventListener("close", () => {
      if (!settled) done(new Error("Creality WebSocket closed before confirmation"));
    });
  });
}

async function getStatus(printer) {
  try {
    return await exclusive(printer, async () => normalize(await exchange(printer)));
  } catch (_) {
    return { ...EMPTY };
  }
}

async function getRawStatus(printer) {
  return exclusive(printer, () => exchange(printer));
}

async function uploadAndPrint(printer, gcodeFullPath, filename) {
  // This protocol uses plain G-code, not Bambu 3MF or Prusa binary G-code.
  if (
    !filename ||
    basename(filename) !== filename ||
    /[\r\n\x00]/.test(filename) ||
    !/\.gcode$/i.test(filename)
  ) {
    const err = new Error("Creality requires a plain .gcode filename without path components");
    err.retryable = false;
    err.recoverable = false;
    throw err;
  }
  return exclusive(printer, async () => {
    const before = normalize(await exchange(printer));
    if (!["IDLE", "FINISHED", "STOPPED"].includes(before.status)) {
      const err = new Error(`Creality printer is not ready (${before.status})`);
      err.retryable = false;
      err.recoverable = false;
      throw err;
    }
    const form = new FormData();
    form.append("file", fileBlob(gcodeFullPath), filename);
    const data = await requestJson(
      `${address(printer).http}/upload/${encodeURIComponent(filename)}`,
      {
        method: "POST",
        body: form,
        timeoutMs: 300000,
      },
    );
    if (data?.code != null && Number(data.code) !== 0) {
      throw new Error(`Creality upload rejected: ${data.msg || data.code}`);
    }
    try {
      await exchange(printer, {
        command: { method: "set", params: { opGcodeFile: `printprt:${GCODE_DIR}/${filename}` } },
        confirm: (raw) =>
          ["PRINTING", "PAUSED"].includes(statusOf(raw)) &&
          basename(raw.printFileName) === filename,
        timeout: 15000,
      });
    } catch (err) {
      // The start command may have reached the printer. Never repeat it blindly.
      err.retryable = false;
      throw err;
    }
  });
}

async function cancelJob(printer) {
  await exclusive(printer, () =>
    exchange(printer, {
      command: { method: "set", params: { stop: 1 } },
      confirm: (raw) => ["IDLE", "STOPPED", "FINISHED", "ERROR"].includes(statusOf(raw)),
      timeout: 15000,
    }),
  );
}

async function checkIfPrinting(printer, filename) {
  const result = await getStatus(printer);
  return (
    ["PRINTING", "PAUSED"].includes(result.status) && (!filename || result.currentFile === filename)
  );
}

module.exports = { getStatus, getRawStatus, uploadAndPrint, cancelJob, checkIfPrinting };
