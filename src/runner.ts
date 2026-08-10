import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import pLimit from "p-limit";
import type { Browser } from "playwright";

import { capturePage, withBrowser } from "./capture.js";
import { countChanges, diffSnapshots, hashSnapshot } from "./diff.js";
import { logger } from "./logger.js";
import { dispatchChange, dispatchFailure } from "./notify/index.js";
import { envInt } from "./secrets.js";
import {
  DATA_DIR,
  DIR_MODE,
  appendHistory,
  createChangeDir,
  prune,
  readBaseline,
  readState,
  stampFor,
  writeBaseline,
  writeState,
} from "./store.js";
import type { LandingState } from "./store.js";
import type { Change, ChangeReport, HistoryRecord, LandingConfig, Snapshot } from "./types.js";
import { focusCrops, markScreenshot, marksForAfter, marksForBefore, pixelDiff } from "./visual.js";

export interface RunOptions {
  /** Только снять baseline: ничего не сравнивать и никому не писать. */
  baselineOnly?: boolean;
  /** Выключает отправку — для отладки на живых лендингах. */
  notify?: boolean;
}

export interface RunSummary {
  checked: number;
  changed: number;
  unchanged: number;
  unstable: number;
  baselines: number;
  errors: number;
}

/**
 * Доля изменившихся пикселей, выше которой пиксельный дифф считается
 * бесполезным: столько бывает только при сдвиге вёрстки, а не при правке.
 */
const NOISY_PIXEL_DIFF_RATIO = 0.25;

const LOCK_PATH = join(DATA_DIR, ".lock");
/** Прогон дольше двух часов считается брошенным: процесс убили, лок остался. */
const LOCK_STALE_MS = 2 * 60 * 60 * 1000;

export async function acquireLock(): Promise<boolean> {
  await mkdir(DATA_DIR, { recursive: true, mode: DIR_MODE });
  if (existsSync(LOCK_PATH)) {
    try {
      const held = JSON.parse(await readFile(LOCK_PATH, "utf8")) as { pid: number; startedAt: string };
      const age = Date.now() - new Date(held.startedAt).getTime();
      if (age < LOCK_STALE_MS) {
        logger.warn({ pid: held.pid, startedAt: held.startedAt }, "прогон уже идёт, пропускаем");
        return false;
      }
      logger.warn({ pid: held.pid }, "найден просроченный лок, забираем");
    } catch {
      // Битый лок — считаем, что его нет.
    }
  }
  await writeFile(LOCK_PATH, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  return true;
}

export async function releaseLock(): Promise<void> {
  await rm(LOCK_PATH, { force: true });
}

async function writeArtifacts(
  changeDir: string,
  before: Buffer,
  after: Buffer,
  changes: Change[],
): Promise<ChangeReport["images"]> {
  const beforePath = join(changeDir, "before.png");
  const afterPath = join(changeDir, "after.png");
  await Promise.all([writeFile(beforePath, before), writeFile(afterPath, after)]);

  const [beforeMarked, afterMarked] = await Promise.all([
    markScreenshot(before, marksForBefore(changes)),
    markScreenshot(after, marksForAfter(changes)),
  ]);
  const beforeMarkedPath = join(changeDir, "before_marked.png");
  const afterMarkedPath = join(changeDir, "after_marked.png");
  await Promise.all([writeFile(beforeMarkedPath, beforeMarked), writeFile(afterMarkedPath, afterMarked)]);

  const images: ChangeReport["images"] = {
    before: beforePath,
    after: afterPath,
    beforeMarked: beforeMarkedPath,
    afterMarked: afterMarkedPath,
    focus: [],
  };

  // Фрагменты вокруг изменений — то, что реально смотрят в письме и в чате.
  const crops = await focusCrops(beforeMarked, afterMarked, changes);
  for (const [position, crop] of crops.entries()) {
    const path = join(changeDir, `focus_${position + 1}.png`);
    await writeFile(path, crop);
    images.focus.push(path);
  }

  // Пиксельный дифф считаем последним: он самый тяжёлый, и без него отчёт
  // всё равно остаётся полезным.
  try {
    const diff = await pixelDiff(before, after);
    const path = join(changeDir, "pixeldiff.png");
    await writeFile(path, diff.image);

    // Удаление одной строки сдвигает вниз всё, что под ней, и тогда красным
    // заливает пол-страницы. На диске такую картинку оставляем — разбираться
    // постфактум она помогает, — но в письмо и в чат не кладём: сигнала в ней
    // нет, только шум.
    if (diff.ratio <= NOISY_PIXEL_DIFF_RATIO) {
      images.pixelDiff = path;
    } else {
      logger.info(
        { changeDir, ratio: Number(diff.ratio.toFixed(3)) },
        "пиксельный дифф зашумлён сдвигом вёрстки, к уведомлению не прикладываем",
      );
    }
  } catch (error) {
    logger.warn({ changeDir, err: String(error) }, "пиксельный дифф не построен");
  }

  return images;
}

interface Confirmed {
  snapshot: Snapshot;
  screenshot: Buffer;
  hash: string;
  stable: boolean;
}

/**
 * Переснимает страницу и проверяет, что изменение никуда не делось.
 *
 * Лендинги полны каруселей, счётчиков и A/B-подстановок: без этой проверки
 * почта наполнится сообщениями о том, что в блоке отзывов теперь другой
 * отзыв. Ждём не следующего часа, а двадцати секунд — алерт не задерживается.
 */
async function confirm(
  browser: Browser,
  landing: LandingConfig,
  first: { snapshot: Snapshot; screenshot: Buffer; hash: string },
): Promise<Confirmed> {
  if (!landing.confirm) return { ...first, stable: true };

  await new Promise((resolve) => setTimeout(resolve, landing.confirmDelayMs));
  const second = await capturePage(browser, landing);
  const hash = hashSnapshot(second.snapshot);
  return { snapshot: second.snapshot, screenshot: second.screenshot, hash, stable: hash === first.hash };
}

/**
 * Пора ли сообщать о серии неудач.
 *
 * Раньше здесь стояло строгое равенство `failures === threshold`, и это
 * теряло уведомления в самом важном случае. Площадка и сеть падают заодно:
 * на третьей неудаче отправка сама упирается в ту же неработающую сеть,
 * попытка сгорает, счётчик уходит дальше — и повтора не случается никогда.
 * На практике так и вышло: 48 неудач подряд и ни одного доставленного
 * сообщения.
 *
 * Поэтому условие «не меньше порога и об этой серии ещё не сообщили».
 * Спама не будет: серию закрывает `failureAlertSentAt`, а его ставят только
 * после того, как хоть один канал принял сообщение.
 */
export function shouldSendFailureAlert(
  state: LandingState,
  failures: number,
  threshold: number,
  notify: boolean,
): boolean {
  return notify && failures >= threshold && !state.failureAlertSentAt;
}

async function noteFailure(landing: LandingConfig, error: unknown, notify: boolean): Promise<HistoryRecord> {
  const message = error instanceof Error ? error.message : String(error);
  const state = await readState(landing.slug);
  const failures = state.failures + 1;
  const threshold = envInt("NOTIFY_FAIL_THRESHOLD", 3);

  const record: HistoryRecord = {
    ts: new Date().toISOString(),
    status: "error",
    error: message,
  };

  // Сообщаем только когда лендинг лёг всерьёз: одиночный таймаут не повод
  // будить, а вот три подряд — уже похоже на поломку.
  if (shouldSendFailureAlert(state, failures, threshold, notify)) {
    const result = await dispatchFailure(
      {
        slug: landing.slug,
        name: landing.name,
        url: landing.url,
        detectedAt: record.ts,
        failures,
        error: message,
      },
      landing,
    );
    record.notified = result.sent;
    if (Object.keys(result.errors).length > 0) record.notifyErrors = result.errors;

    // Серию закрываем только при настоящей доставке. Отметка после упавшей
    // отправки — ровно тот баг, из-за которого уведомление терялось насовсем.
    const delivered = result.sent.length > 0;
    if (!delivered) {
      logger.warn({ slug: landing.slug, failures }, "сообщить о поломке не удалось, повторим на следующем прогоне");
    }
    await writeState(landing.slug, {
      failures,
      lastError: message,
      ...(delivered ? { failureAlertSentAt: record.ts } : {}),
    });
  } else {
    await writeState(landing.slug, { ...state, failures, lastError: message });
  }

  logger.error({ slug: landing.slug, failures, err: message }, "проверка не удалась");
  return record;
}

async function performCheck(
  browser: Browser,
  landing: LandingConfig,
  options: RunOptions,
): Promise<HistoryRecord> {
  const notify = options.notify !== false;
  const log = logger.child({ slug: landing.slug });

  const first = await capturePage(browser, landing);
  const firstHash = hashSnapshot(first.snapshot);
  const baseline = await readBaseline(landing.slug);

  const record = await (async (): Promise<HistoryRecord> => {
    if (!baseline || options.baselineOnly) {
      await writeBaseline(landing.slug, first.snapshot, first.screenshot, firstHash);
      log.info({ entries: first.snapshot.entries.length }, baseline ? "baseline перезаписан" : "baseline снят");
      return { ts: new Date().toISOString(), hash: firstHash, status: "baseline" };
    }

    if (firstHash === baseline.hash) {
      log.info("изменений нет");
      return { ts: new Date().toISOString(), hash: firstHash, status: "unchanged" };
    }

    const second = await confirm(browser, landing, { ...first, hash: firstHash });

    if (!second.stable) {
      // Страница меняется сама по себе — писать не о чем, но baseline
      // обновляем, иначе будем спотыкаться об это на каждом прогоне.
      await writeBaseline(landing.slug, second.snapshot, second.screenshot, second.hash);
      log.info("изменение не подтвердилось на повторном снимке — на странице динамика");
      return { ts: new Date().toISOString(), hash: second.hash, status: "unstable" };
    }

    // Дифф считаем против подтверждённого снимка: рамки рисуются по его
    // координатам поверх его же скриншота.
    const changes = diffSnapshots(baseline.snapshot, second.snapshot);

    if (changes.length === 0) {
      await writeBaseline(landing.slug, second.snapshot, second.screenshot, second.hash);
      log.info("хэш разошёлся, но различий не нашлось — baseline обновлён");
      return { ts: new Date().toISOString(), hash: second.hash, status: "unchanged" };
    }

    const detectedAt = new Date().toISOString();
    const changeDir = await createChangeDir(landing.slug, stampFor(new Date(detectedAt)));
    const images = await writeArtifacts(changeDir, baseline.screenshot, second.screenshot, changes);

    const report: ChangeReport = {
      slug: landing.slug,
      name: landing.name,
      url: landing.url,
      detectedAt,
      changes,
      counts: countChanges(changes),
      images,
      changeDir,
    };
    await writeFile(join(changeDir, "change.json"), JSON.stringify(report, null, 2));
    log.info({ changes: changes.length, changeDir }, "найдены изменения");

    const result: HistoryRecord = {
      ts: detectedAt,
      hash: second.hash,
      status: "changed",
      changes: changes.length,
    };

    if (notify) {
      const dispatched = await dispatchChange(report, landing);
      result.notified = dispatched.sent;
      if (Object.keys(dispatched.errors).length > 0) result.notifyErrors = dispatched.errors;
    }

    // Baseline двигаем только после отчёта: упади мы на отправке — изменение
    // не потеряется, следующий прогон найдёт его снова.
    await writeBaseline(landing.slug, second.snapshot, second.screenshot, second.hash);
    return result;
  })();

  const state = await readState(landing.slug);
  if (state.failures > 0) {
    log.info({ was: state.failures }, "лендинг снова открывается");
    await writeState(landing.slug, { failures: 0 });
  }

  return record;
}

export async function checkLanding(
  browser: Browser,
  landing: LandingConfig,
  options: RunOptions = {},
): Promise<HistoryRecord> {
  let record: HistoryRecord;
  try {
    record = await performCheck(browser, landing, options);
  } catch (error) {
    record = await noteFailure(landing, error, options.notify !== false);
  }

  await appendHistory(landing.slug, record);
  await prune(landing.slug);
  return record;
}

export async function runAll(landings: LandingConfig[], options: RunOptions = {}): Promise<RunSummary> {
  const active = landings.filter((landing) => landing.enabled);
  const summary: RunSummary = { checked: 0, changed: 0, unchanged: 0, unstable: 0, baselines: 0, errors: 0 };

  if (active.length === 0) {
    logger.warn("в config/landings.yaml нет ни одного включённого лендинга");
    return summary;
  }

  const limit = pLimit(Math.max(1, envInt("CONCURRENCY", 3)));

  await withBrowser(async (browser) => {
    const records = await Promise.all(
      active.map((landing) => limit(() => checkLanding(browser, landing, options))),
    );
    for (const record of records) {
      summary.checked += 1;
      if (record.status === "changed") summary.changed += 1;
      else if (record.status === "unchanged") summary.unchanged += 1;
      else if (record.status === "unstable") summary.unstable += 1;
      else if (record.status === "baseline") summary.baselines += 1;
      else if (record.status === "error") summary.errors += 1;
    }
  });

  logger.info(summary, "прогон завершён");
  return summary;
}
