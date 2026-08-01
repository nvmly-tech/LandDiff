import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";

import { logger } from "./logger.js";
import type { HistoryRecord, Snapshot } from "./types.js";

export const DATA_DIR = resolve(process.env.DATA_DIR || "data");

/** Сколько каталогов с изменениями хранить на лендинг. */
const KEEP_CHANGES = 48;
/** Потолок строк в history.jsonl — дальше файл обрезается с головы. */
const KEEP_HISTORY_LINES = 10_000;

export interface Baseline {
  snapshot: Snapshot;
  screenshot: Buffer;
  hash: string;
  capturedAt: string;
}

interface BaselineMeta {
  hash: string;
  capturedAt: string;
  url: string;
}

/** Состояние между прогонами: только счётчик неудач подряд. */
export interface LandingState {
  failures: number;
  lastError?: string;
  lastFailureNotifiedAt?: string;
}

export const landingDir = (slug: string): string => join(DATA_DIR, slug);
const baselineDir = (slug: string): string => join(landingDir(slug), "baseline");
const changesDir = (slug: string): string => join(landingDir(slug), "changes");
const historyPath = (slug: string): string => join(landingDir(slug), "history.jsonl");
const statePath = (slug: string): string => join(landingDir(slug), "state.json");

/** Метка времени, пригодная для имени каталога на любой файловой системе. */
export function stampFor(date: Date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, "-").replace(/Z$/, "Z");
}

export async function readBaseline(slug: string): Promise<Baseline | null> {
  const dir = baselineDir(slug);
  if (!existsSync(join(dir, "meta.json"))) return null;
  try {
    const [meta, snapshot, screenshot] = await Promise.all([
      readFile(join(dir, "meta.json"), "utf8").then((raw) => JSON.parse(raw) as BaselineMeta),
      readFile(join(dir, "snapshot.json"), "utf8").then((raw) => JSON.parse(raw) as Snapshot),
      readFile(join(dir, "page.png")),
    ]);
    return { snapshot, screenshot, hash: meta.hash, capturedAt: meta.capturedAt };
  } catch (error) {
    // Битый baseline лечится сам: следующий прогон снимет его заново.
    logger.warn({ slug, err: String(error) }, "baseline не читается, будет снят заново");
    return null;
  }
}

/**
 * Записывает baseline целиком через временный каталог: три файла должны
 * меняться вместе, иначе после падения посреди записи остался бы снапшот от
 * одного прогона и скриншот от другого.
 */
export async function writeBaseline(
  slug: string,
  snapshot: Snapshot,
  screenshot: Buffer,
  hash: string,
): Promise<void> {
  const target = baselineDir(slug);
  const staging = `${target}.new`;
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });

  const meta: BaselineMeta = { hash, capturedAt: snapshot.capturedAt, url: snapshot.url };
  await Promise.all([
    writeFile(join(staging, "meta.json"), JSON.stringify(meta, null, 2)),
    writeFile(join(staging, "snapshot.json"), JSON.stringify(snapshot)),
    writeFile(join(staging, "page.png"), screenshot),
  ]);

  await rm(target, { recursive: true, force: true });
  await rename(staging, target);
}

export async function createChangeDir(slug: string, stamp: string): Promise<string> {
  const dir = join(changesDir(slug), stamp);
  await mkdir(dir, { recursive: true });
  return dir;
}

export async function appendHistory(slug: string, record: HistoryRecord): Promise<void> {
  await mkdir(landingDir(slug), { recursive: true });
  await appendFile(historyPath(slug), `${JSON.stringify(record)}\n`);
}

export async function readState(slug: string): Promise<LandingState> {
  try {
    return JSON.parse(await readFile(statePath(slug), "utf8")) as LandingState;
  } catch {
    return { failures: 0 };
  }
}

export async function writeState(slug: string, state: LandingState): Promise<void> {
  await mkdir(landingDir(slug), { recursive: true });
  await writeFile(statePath(slug), JSON.stringify(state, null, 2));
}

/** Удаляет старые отчёты и подрезает журнал. Вызывается в конце прогона. */
export async function prune(slug: string): Promise<void> {
  try {
    const dirs = (await readdir(changesDir(slug), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    for (const name of dirs.slice(0, Math.max(0, dirs.length - KEEP_CHANGES))) {
      await rm(join(changesDir(slug), name), { recursive: true, force: true });
    }
  } catch {
    // Каталога ещё нет — чистить нечего.
  }

  try {
    const lines = (await readFile(historyPath(slug), "utf8")).split("\n").filter(Boolean);
    if (lines.length > KEEP_HISTORY_LINES) {
      await writeFile(historyPath(slug), `${lines.slice(-KEEP_HISTORY_LINES).join("\n")}\n`);
    }
  } catch {
    // Журнала ещё нет.
  }
}

/** Каталоги в data/, которым больше не соответствует ни один лендинг. */
export async function orphanedDirs(activeSlugs: string[]): Promise<string[]> {
  if (!existsSync(DATA_DIR)) return [];
  const known = new Set(activeSlugs);
  const entries = await readdir(DATA_DIR, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && !known.has(entry.name) && !entry.name.endsWith(".new"))
    .map((entry) => entry.name);
}
