import pixelmatch from "pixelmatch";
import sharp from "sharp";

import type { Change, Rect } from "./types.js";

export const COLORS = {
  added: "#16a34a",
  modified: "#d97706",
  removed: "#dc2626",
} as const;

/** Разрыв между изменениями, после которого начинается новый фрагмент. */
const CLUSTER_GAP_PX = 400;
/** Поля вокруг фрагмента, чтобы правку было видно в контексте. */
const CLUSTER_PADDING_PX = 120;
const CLUSTER_MAX_HEIGHT_PX = 1600;
const MAX_FOCUS_CROPS = 3;

const LABEL_BAND_PX = 44;
const GAP_PX = 24;

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function sizeOf(image: Buffer): Promise<{ width: number; height: number }> {
  const meta = await sharp(image).metadata();
  return { width: meta.width ?? 0, height: meta.height ?? 0 };
}

function clampRect(rect: Rect, width: number, height: number): Rect | null {
  const x = Math.max(0, Math.min(rect.x, width - 1));
  const y = Math.max(0, Math.min(rect.y, height - 1));
  const w = Math.min(rect.w, width - x);
  const h = Math.min(rect.h, height - y);
  if (w <= 1 || h <= 1) return null;
  return { x, y, w, h };
}

interface Mark {
  rect: Rect;
  color: string;
  label: string;
}

/**
 * Рисует рамки поверх готового скриншота.
 *
 * Именно композит поверх PNG, а не перерисовка страницы с наложенным DOM:
 * страница к моменту отчёта могла уже измениться ещё раз, а картинка — нет.
 * Координаты те же, в которых снят скриншот (см. scale: "css" в capture.ts).
 */
export async function markScreenshot(screenshot: Buffer, marks: Mark[]): Promise<Buffer> {
  const { width, height } = await sizeOf(screenshot);
  if (width === 0 || height === 0) return screenshot;

  const shapes: string[] = [];
  for (const mark of marks) {
    const rect = clampRect(mark.rect, width, height);
    if (!rect) continue;
    const badgeWidth = 22 + mark.label.length * 9;
    const badgeY = Math.max(0, rect.y - 22);
    shapes.push(
      `<rect x="${rect.x}" y="${rect.y}" width="${rect.w}" height="${rect.h}" ` +
        `fill="${mark.color}" fill-opacity="0.10" stroke="${mark.color}" stroke-width="3"/>`,
      `<rect x="${rect.x}" y="${badgeY}" width="${badgeWidth}" height="22" rx="4" fill="${mark.color}"/>`,
      `<text x="${rect.x + 8}" y="${badgeY + 16}" font-family="DejaVu Sans, Arial, sans-serif" ` +
        `font-size="14" font-weight="bold" fill="#ffffff">${escapeXml(mark.label)}</text>`,
    );
  }
  if (shapes.length === 0) return screenshot;

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${shapes.join("")}</svg>`;
  return sharp(screenshot)
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .png()
    .toBuffer();
}

export function marksForAfter(changes: Change[]): Mark[] {
  return changes
    .filter((change) => change.afterRect && change.type !== "removed")
    .map((change) => ({
      rect: change.afterRect as Rect,
      color: change.type === "added" ? COLORS.added : COLORS.modified,
      label: String(change.index),
    }));
}

export function marksForBefore(changes: Change[]): Mark[] {
  return changes
    .filter((change) => change.beforeRect && change.type !== "added")
    .map((change) => ({
      rect: change.beforeRect as Rect,
      color: change.type === "removed" ? COLORS.removed : COLORS.modified,
      label: String(change.index),
    }));
}

export interface PixelDiffResult {
  image: Buffer;
  changedPixels: number;
  ratio: number;
}

/**
 * Пиксельный дифф — подстраховка для правок, которых нет в тексте: замены
 * картинки, смены шрифта или цвета. Высота у двух снимков почти всегда
 * разная, поэтому оба дополняются белым до общего размера, иначе сравнивать
 * нечего.
 */
export async function pixelDiff(before: Buffer, after: Buffer): Promise<PixelDiffResult> {
  const [a, b] = await Promise.all([sizeOf(before), sizeOf(after)]);
  const width = Math.max(a.width, b.width);
  const height = Math.max(a.height, b.height);

  const toCanvas = (image: Buffer, size: { width: number; height: number }) =>
    sharp(image)
      .extend({
        top: 0,
        left: 0,
        bottom: height - size.height,
        right: width - size.width,
        background: { r: 255, g: 255, b: 255, alpha: 1 },
      })
      .ensureAlpha()
      .raw()
      .toBuffer();

  const [rawBefore, rawAfter] = await Promise.all([toCanvas(before, a), toCanvas(after, b)]);
  const output = Buffer.alloc(width * height * 4);

  const changedPixels = pixelmatch(rawBefore, rawAfter, output, width, height, {
    threshold: 0.1,
    includeAA: false,
    // Приглушённая подложка: видно и что изменилось, и где на странице.
    alpha: 0.15,
    diffColor: [220, 38, 38],
  });

  const image = await sharp(output, { raw: { width, height, channels: 4 } }).png().toBuffer();
  return { image, changedPixels, ratio: changedPixels / (width * height) };
}

interface Cluster {
  beforeFrom: number;
  beforeTo: number;
  afterFrom: number;
  afterTo: number;
}

/**
 * Группирует изменения по вертикали. Одна правка в шапке и одна в подвале —
 * это два фрагмента, а не один снимок высотой во всю страницу.
 */
export function clusterChanges(changes: Change[]): Cluster[] {
  const spans = changes
    .map((change) => {
      const after = change.afterRect;
      const before = change.beforeRect;
      const anchor = after ?? before;
      if (!anchor) return null;
      return {
        afterFrom: after ? after.y : anchor.y,
        afterTo: after ? after.y + after.h : anchor.y + anchor.h,
        beforeFrom: before ? before.y : anchor.y,
        beforeTo: before ? before.y + before.h : anchor.y + anchor.h,
      };
    })
    .filter((span): span is NonNullable<typeof span> => span !== null)
    .sort((left, right) => left.afterFrom - right.afterFrom);

  const clusters: Cluster[] = [];
  for (const span of spans) {
    const last = clusters[clusters.length - 1];
    if (last && span.afterFrom - last.afterTo <= CLUSTER_GAP_PX) {
      last.afterTo = Math.max(last.afterTo, span.afterTo);
      last.beforeFrom = Math.min(last.beforeFrom, span.beforeFrom);
      last.beforeTo = Math.max(last.beforeTo, span.beforeTo);
      continue;
    }
    clusters.push({ ...span });
  }
  return clusters.slice(0, MAX_FOCUS_CROPS);
}

async function cropBand(image: Buffer, from: number, to: number): Promise<Buffer> {
  const { width, height } = await sizeOf(image);
  const top = Math.max(0, Math.min(Math.round(from) - CLUSTER_PADDING_PX, Math.max(0, height - 1)));
  const bottom = Math.min(height, Math.round(to) + CLUSTER_PADDING_PX);
  const bandHeight = Math.max(1, Math.min(bottom - top, CLUSTER_MAX_HEIGHT_PX));
  return sharp(image).extract({ left: 0, top, width, height: bandHeight }).png().toBuffer();
}

/**
 * Один фрагмент «до | после» рядом, с подписями. Это то, что реально смотрят
 * в письме и в телеграме: полноразмерный снимок лендинга на 12 000 пикселей
 * никто листать не будет, а в фото телеграма он и не влезет.
 */
async function sideBySide(before: Buffer, after: Buffer): Promise<Buffer> {
  const [a, b] = await Promise.all([sizeOf(before), sizeOf(after)]);
  const width = a.width + GAP_PX + b.width;
  const height = Math.max(a.height, b.height) + LABEL_BAND_PX;

  const labels =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${LABEL_BAND_PX}">` +
    `<rect width="${width}" height="${LABEL_BAND_PX}" fill="#111827"/>` +
    `<text x="16" y="29" font-family="DejaVu Sans, Arial, sans-serif" font-size="19" ` +
    `font-weight="bold" fill="#f9fafb">БЫЛО</text>` +
    `<text x="${a.width + GAP_PX + 16}" y="29" font-family="DejaVu Sans, Arial, sans-serif" ` +
    `font-size="19" font-weight="bold" fill="#f9fafb">СТАЛО</text>` +
    `</svg>`;

  return sharp({
    create: { width, height, channels: 3, background: { r: 229, g: 231, b: 235 } },
  })
    .composite([
      { input: Buffer.from(labels), top: 0, left: 0 },
      { input: before, top: LABEL_BAND_PX, left: 0 },
      { input: after, top: LABEL_BAND_PX, left: a.width + GAP_PX },
    ])
    .png()
    .toBuffer();
}

/** Фрагменты «до | после» вокруг каждого скопления изменений. */
export async function focusCrops(
  beforeMarked: Buffer,
  afterMarked: Buffer,
  changes: Change[],
): Promise<Buffer[]> {
  const crops: Buffer[] = [];
  for (const cluster of clusterChanges(changes)) {
    const [before, after] = await Promise.all([
      cropBand(beforeMarked, cluster.beforeFrom, cluster.beforeTo),
      cropBand(afterMarked, cluster.afterFrom, cluster.afterTo),
    ]);
    crops.push(await sideBySide(before, after));
  }
  return crops;
}

/** Ужимает картинку для отправки: PNG лендинга легко весит 10+ МБ. */
export async function downscale(image: Buffer, maxWidth = 1200, quality = 85): Promise<Buffer> {
  return sharp(image)
    .resize({ width: maxWidth, withoutEnlargement: true })
    .flatten({ background: "#ffffff" })
    .jpeg({ quality, mozjpeg: true })
    .toBuffer();
}

/**
 * Ограничения Bot API на фото: сумма сторон ≤ 10000 px и отношение ≤ 20:1.
 * Полностраничный снимок лендинга не проходит ни по одному, поэтому вызов
 * возвращает null — такое отправляется документом, там ограничений нет.
 */
export async function fitTelegramPhoto(image: Buffer): Promise<Buffer | null> {
  const { width, height } = await sizeOf(image);
  if (width === 0 || height === 0) return null;

  const ratio = Math.max(width / height, height / width);
  if (ratio > 19) return null;

  const scale = Math.min(1, 9500 / (width + height));
  const targetWidth = Math.max(1, Math.floor(width * scale));

  return sharp(image)
    .resize({ width: targetWidth, withoutEnlargement: true })
    .flatten({ background: "#ffffff" })
    .jpeg({ quality: 85, mozjpeg: true })
    .toBuffer();
}
