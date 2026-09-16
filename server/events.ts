// Persistent printer event log records decommission, recommission, job outcomes,
// and freeform operator notes. Events are never deleted.
// No FK constraint on printer_id, history survives printer deletion.

const db = require("./db");

const insertStatement = db.prepare(
  "INSERT INTO printer_events (printer_id, event_type, note, created_at) VALUES (?, ?, ?, ?)",
);

export function insert(printerId: number, eventType: string, note: string | null = null): void {
  insertStatement.run(printerId, eventType, note, Date.now());
}
