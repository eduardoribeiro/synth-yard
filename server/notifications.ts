// In-memory notification store survives as long as the server process is running.
// Notifications are lost on restart, which is fine: actionable errors will recur
// naturally on the next dispatch attempt if the underlying issue has not been fixed.

export interface Notification {
  id: number;
  message: string;
  timestamp: number;
}

let nextId = 1;
const store: Notification[] = [];

export function add(message: string): Notification {
  const note: Notification = { id: nextId++, message, timestamp: Date.now() };
  store.push(note);
  console.warn(`[notifications] ${message}`);
  return note;
}

export function list(): Notification[] {
  return [...store].reverse();
}

export function dismiss(id: number): boolean {
  const index = store.findIndex((note) => note.id === id);
  if (index === -1) return false;
  store.splice(index, 1);
  return true;
}
