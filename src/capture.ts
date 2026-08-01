import { chromium, type Browser, type Page } from "playwright";

import { extractSnapshot } from "./extract.js";
import { logger } from "./logger.js";
import type { LandingConfig, Snapshot } from "./types.js";

export interface Capture {
  snapshot: Snapshot;
  screenshot: Buffer;
}

const MAX_ENTRIES = 6000;
const MAX_VALUE_LENGTH = 400;
/** Верхняя граница координат: страница выше этого не бывает даже у лендингов. */
const MAX_COORDINATE = 200_000;

/** Сколько ждём сетевого затишья после DOMContentLoaded. */
const NETWORK_IDLE_TIMEOUT_MS = 15_000;

/**
 * Sandbox Chromium остаётся включённым.
 *
 * Мы ходим на чужие страницы, содержимое которых по определению не
 * контролируем, — это и есть тот случай, ради которого sandbox существует:
 * без него эксплойт рендерера сразу получает права нашего процесса и доступ
 * к data/ и к переменным окружения с токеном. Расхожий совет добавить
 * --no-sandbox относится к запуску от root; в нашем образе процесс идёт от
 * pwuser, и sandbox поднимается штатно, в том числе с cap_drop: ALL.
 *
 * --disable-dev-shm-usage: /dev/shm по умолчанию мал, и вкладка падает на
 * тяжёлых страницах. В compose поднят shm_size, флаг оставлен на случай
 * запуска без него.
 */
export async function launchBrowser(): Promise<Browser> {
  return chromium.launch({
    args: ["--disable-dev-shm-usage", "--disable-gpu", "--hide-scrollbars"],
  });
}

export async function withBrowser<T>(fn: (browser: Browser) => Promise<T>): Promise<T> {
  const browser = await launchBrowser();
  try {
    return await fn(browser);
  } finally {
    await browser.close().catch(() => {});
  }
}

/**
 * Заплатка под esbuild, на котором работает tsx.
 *
 * Он оборачивает именованные функции в хелпер __name, чтобы сохранить их
 * имена. Функция, уезжающая в браузер через page.evaluate, сериализуется
 * вместе с этими вызовами, а хелпера на странице нет — и extractSnapshot
 * падает с «__name is not defined». Объявляем заглушку до любых скриптов
 * страницы. Задано строкой намеренно: функцию esbuild переписал бы ровно
 * тем же способом.
 */
const ESBUILD_NAME_SHIM = "globalThis.__name = globalThis.__name || function (target) { return target; };";

/** Глушим всё, что перерисовывается само по себе между двумя снимками. */
const FREEZE_CSS = `
*, *::before, *::after {
  animation: none !important;
  animation-duration: 0s !important;
  animation-delay: 0s !important;
  transition: none !important;
  transition-duration: 0s !important;
  caret-color: transparent !important;
}
html { scroll-behavior: auto !important; }
video, [autoplay] { visibility: hidden !important; }
`;

function finite(value: unknown, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(-MAX_COORDINATE, Math.min(MAX_COORDINATE, Math.round(parsed)));
}

/**
 * Приводит пришедший из браузера снапшот к своим границам.
 *
 * Ограничители внутри extractSnapshot опираются на Array.prototype.push,
 * String.prototype.slice и прочие прототипы, которыми владеет страница:
 * достаточно их переопределить, и в Node вернётся сколько угодно данных
 * (проверено — значения по 50 000 символов вместо 400). Поэтому те же рамки
 * ставятся ещё раз здесь, где страница ни на что повлиять не может.
 *
 * Заодно чинятся NaN и Infinity в координатах: по ним потом строится SVG
 * с рамками и режутся фрагменты, и нечисло уронило бы sharp.
 */
function clampSnapshot(raw: Snapshot): Snapshot {
  const entries = (Array.isArray(raw.entries) ? raw.entries : [])
    .slice(0, MAX_ENTRIES)
    .map((entry) => ({
      key: String(entry?.key ?? "").slice(0, 512),
      kind: (["text", "img", "link", "bg"] as const).includes(entry?.kind) ? entry.kind : "text",
      value: String(entry?.value ?? "").slice(0, MAX_VALUE_LENGTH),
      rect: {
        x: finite(entry?.rect?.x, 0),
        y: finite(entry?.rect?.y, 0),
        w: Math.max(0, finite(entry?.rect?.w, 0)),
        h: Math.max(0, finite(entry?.rect?.h, 0)),
      },
    }));

  return {
    url: String(raw.url ?? "").slice(0, 2048),
    capturedAt: new Date().toISOString(),
    width: Math.max(1, finite(raw.width, 0)),
    height: Math.max(1, finite(raw.height, 0)),
    entries,
  };
}

async function stabilize(page: Page, landing: LandingConfig): Promise<void> {
  await page.addStyleTag({ content: FREEZE_CSS });

  // Каждый селектор — отдельным правилом: браузер выбрасывает невалидные
  // правила поштучно, и одна опечатка в конфиге не отключает остальные.
  if (landing.ignoreSelectors.length > 0) {
    const css = landing.ignoreSelectors
      .map((selector) => `${selector} { visibility: hidden !important; }`)
      .join("\n");
    await page.addStyleTag({ content: css });
  }

  if (landing.waitForSelector) {
    await page.waitForSelector(landing.waitForSelector, { timeout: landing.navigationTimeoutMs });
  }

  // Прокрутка до низа и обратно: без неё картинки с loading="lazy" остаются
  // пустыми, и первый же честный визит выглядит как изменение половины страницы.
  await page.evaluate(async () => {
    const step = Math.max(200, Math.floor(window.innerHeight * 0.8));
    for (let y = 0; y < document.documentElement.scrollHeight; y += step) {
      window.scrollTo(0, y);
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
    window.scrollTo(0, 0);
    await new Promise((resolve) => setTimeout(resolve, 200));
  });

  await page.evaluate(() => document.fonts.ready.then(() => undefined)).catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: NETWORK_IDLE_TIMEOUT_MS }).catch(() => {});
  await page.waitForTimeout(landing.settleMs);
}

/**
 * Открывает лендинг и возвращает нормализованный снапшот вместе со
 * скриншотом всей страницы. Оба сняты в одном состоянии страницы, поэтому
 * координаты из снапшота совпадают с пикселями скриншота.
 */
export async function capturePage(browser: Browser, landing: LandingConfig): Promise<Capture> {
  const context = await browser.newContext({
    viewport: landing.viewport,
    // Скриншот снимаем в CSS-пикселях (см. scale ниже), поэтому масштаб 1 —
    // иначе координаты из getBoundingClientRect разъедутся с картинкой.
    deviceScaleFactor: 1,
    locale: "ru-RU",
    reducedMotion: "reduce",
    userAgent: landing.userAgent,
    extraHTTPHeaders: Object.keys(landing.extraHeaders ?? {}).length > 0 ? landing.extraHeaders : undefined,
  });
  context.setDefaultTimeout(landing.navigationTimeoutMs);

  try {
    const page = await context.newPage();
    await page.addInitScript({ content: ESBUILD_NAME_SHIM });

    // domcontentloaded + отдельное ожидание затишья: на networkidle в goto
    // навсегда зависают страницы с поллингом или открытым websocket.
    const response = await page.goto(landing.url, {
      waitUntil: "domcontentloaded",
      timeout: landing.navigationTimeoutMs,
    });
    const status = response?.status() ?? 0;
    if (status >= 400) {
      throw new Error(`сервер ответил HTTP ${status}`);
    }

    await stabilize(page, landing);

    const snapshot = clampSnapshot(
      await page.evaluate(extractSnapshot, {
        rootSelector: landing.region,
        ignorePatterns: landing.ignorePatterns,
        maxEntries: MAX_ENTRIES,
        maxValueLength: MAX_VALUE_LENGTH,
      }),
    );

    if (snapshot.entries.length >= MAX_ENTRIES) {
      logger.warn(
        { slug: landing.slug, maxEntries: MAX_ENTRIES },
        "снапшот упёрся в потолок записей — часть страницы не отслеживается, сузьте region",
      );
    }

    const screenshot = await page.screenshot({
      fullPage: true,
      type: "png",
      animations: "disabled",
      caret: "hide",
      // scale: "css" — 1 CSS-пиксель = 1 пиксель картинки. Ровно то, в чём
      // getBoundingClientRect отдаёт координаты, и то, в чём мы рисуем рамки.
      scale: "css",
    });

    return { snapshot, screenshot };
  } finally {
    await context.close().catch(() => {});
  }
}
