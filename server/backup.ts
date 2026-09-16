// Hourly SQLite backup using better-sqlite3's online backup API.
// Writes to server/data/backups/farm-YYYY-MM-DD-HH.db.
// Keeps the most recent KEEP_COUNT files, older ones are deleted automatically.

import fs from "fs";
import path from "path";

interface BackupDatabase {
  backup(destination: string): Promise<unknown>;
}

const BACKUP_DIR = path.join(__dirname, "data", "backups");
const KEEP_COUNT = 24; // 24 hourly snapshots = 1 day of point-in-time recovery
const INTERVAL_MS = 60 * 60 * 1000; // 1 hour

function timestamp(): string {
  const date = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${pad(date.getHours())}`;
}

export async function runBackup(db: BackupDatabase): Promise<void> {
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

  const destination = path.join(BACKUP_DIR, `farm-${timestamp()}.db`);
  try {
    await db.backup(destination);
    console.log(`[backup] Saved ${path.basename(destination)}`);
    pruneOldBackups();
  } catch (error) {
    console.error("[backup] Failed:", error instanceof Error ? error.message : error);
  }
}

function pruneOldBackups(): void {
  if (!fs.existsSync(BACKUP_DIR)) return;
  const files = fs
    .readdirSync(BACKUP_DIR)
    .filter((file) => file.startsWith("farm-") && file.endsWith(".db"))
    .sort() // lexicographic sort on YYYY-MM-DD-HH puts oldest first
    .reverse(); // newest first

  for (const file of files.slice(KEEP_COUNT)) {
    try {
      fs.unlinkSync(path.join(BACKUP_DIR, file));
      console.log(`[backup] Pruned ${file}`);
    } catch (error) {
      console.error(
        `[backup] Could not prune ${file}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }
}

export function start(db: BackupDatabase): void {
  // Run immediately on startup, then every hour.
  void runBackup(db);
  setInterval(() => void runBackup(db), INTERVAL_MS);
}
