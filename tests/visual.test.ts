import assert from "node:assert/strict";
import { test } from "node:test";

import sharp from "sharp";

import { clusterChanges, fitTelegramPhoto, focusCrops, markScreenshot, pixelDiff } from "../src/visual.js";
import type { Change } from "../src/types.js";

function change(index: number, y: number, type: Change["type"] = "modified"): Change {
  const rect = { x: 40, y, w: 600, h: 40 };
  return {
    index,
    type,
    kind: "text",
    key: `k${index}|text`,
    before: "было",
    after: "стало",
    beforeRect: rect,
    afterRect: rect,
  };
}

// Подложка заведомо не белая: белым pixelmatch добивает снимок меньшей
// высоты, и на светло-сером фоне разница не набрала бы порога.
function canvas(width: number, height: number, color = { r: 30, g: 64, b: 128 }): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: color } }).png().toBuffer();
}

test("близкие изменения попадают в один фрагмент, далёкие — в разные", () => {
  const clusters = clusterChanges([change(1, 100), change(2, 300), change(3, 5000)]);
  assert.equal(clusters.length, 2);
  assert.equal(clusters[0]?.afterFrom, 100);
  assert.equal(clusters[0]?.afterTo, 340);
  assert.equal(clusters[1]?.afterFrom, 5000);
});

test("фрагментов не больше трёх — письмо не должно превращаться в альбом", () => {
  const many = Array.from({ length: 12 }, (_, position) => change(position + 1, position * 3000));
  assert.equal(clusterChanges(many).length, 3);
});

test("рамки не выходят за границы картинки", async () => {
  const page = await canvas(800, 600);
  const marked = await markScreenshot(page, [
    { rect: { x: 700, y: 550, w: 900, h: 900 }, color: "#16a34a", label: "1" },
  ]);
  const meta = await sharp(marked).metadata();
  assert.equal(meta.width, 800);
  assert.equal(meta.height, 600);
});

test("пиксельный дифф сводит снимки разной высоты", async () => {
  const before = await canvas(800, 600);
  const after = await canvas(800, 900);
  const result = await pixelDiff(before, after);

  const meta = await sharp(result.image).metadata();
  assert.equal(meta.height, 900);
  // Дорисованная белым область отличается от исходной серой подложки.
  assert.ok(result.changedPixels > 0);
});

test("одинаковые снимки дают пустой дифф", async () => {
  const page = await canvas(400, 400);
  const result = await pixelDiff(page, page);
  assert.equal(result.changedPixels, 0);
});

test("фрагмент «до | после» шире исходников и влезает в лимиты фото", async () => {
  const before = await canvas(1440, 4000);
  const after = await canvas(1440, 4000);
  const crops = await focusCrops(before, after, [change(1, 1000)]);

  assert.equal(crops.length, 1);
  const meta = await sharp(crops[0] as Buffer).metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;

  assert.ok(width > 1440 * 2, "две колонки рядом");
  assert.ok(width + height <= 10_000, `сумма сторон ${width + height}`);
  assert.ok(Math.max(width / height, height / width) <= 20);
});

test("полностраничный снимок ужимается до лимита фото", async () => {
  // 1280 × 12000 — обычный лендинг. Сумма сторон 13280 против допустимых 10000.
  const tall = await canvas(1280, 12_000);
  const fitted = await fitTelegramPhoto(tall);
  assert.ok(fitted);

  const meta = await sharp(fitted).metadata();
  assert.ok((meta.width ?? 0) + (meta.height ?? 0) <= 10_000);
});

test("простыня с недопустимым отношением сторон отвергается — уйдёт документом", async () => {
  const strip = await canvas(600, 30_000);
  assert.equal(await fitTelegramPhoto(strip), null);
});
