import { Injectable } from "@nestjs/common";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import { mkdirSync, writeFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

function resolveNotesDir(): string {
  const explicit = process.env.VEGA_NOTES_DIR;
  if (explicit && explicit !== "") return resolve(explicit);
  let cursor = __dirname;
  for (let depth = 0; depth < 8; depth++) {
    const candidate = resolve(cursor, "output", "notes");
    if (existsSync(resolve(cursor, ".git"))) {
      return candidate;
    }
    cursor = resolve(cursor, "..");
  }
  return resolve(process.cwd(), "output", "notes");
}

function timestampFilename(now: Date): string {
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const hh = String(now.getHours()).padStart(2, "0");
  const mi = String(now.getMinutes()).padStart(2, "0");
  const ss = String(now.getSeconds()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}_${hh}-${mi}-${ss}.md`;
}

@Injectable()
export class NotesStorageService {
  private readonly notesDir = resolveNotesDir();

  constructor(@InjectPinoLogger(NotesStorageService.name) private readonly logger: PinoLogger) {}

  saveNote(text: string, now: Date = new Date()): { path: string } {
    mkdirSync(this.notesDir, { recursive: true });
    const filename = timestampFilename(now);
    const path = join(this.notesDir, filename);
    const body = `_${now.toISOString()}_\n\n${text.trim()}\n`;
    writeFileSync(path, body, "utf8");
    this.logger.info({ path, bytes: body.length }, "Note saved");
    return { path };
  }
}
