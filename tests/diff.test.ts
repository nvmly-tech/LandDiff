import assert from "node:assert/strict";
import { test } from "node:test";

import { countChanges, diffSnapshots, hashSnapshot } from "../src/diff.js";
import type { Snapshot, SnapshotEntry } from "../src/types.js";

function snapshot(entries: Array<Partial<SnapshotEntry> & { key: string; value: string }>): Snapshot {
  return {
    url: "https://example.com/",
    capturedAt: "2026-07-31T12:00:00.000Z",
    width: 1440,
    height: 3000,
    entries: entries.map((entry, position) => ({
      kind: "text",
      rect: { x: 0, y: position * 100, w: 800, h: 40 },
      ...entry,
    })) as SnapshotEntry[],
  };
}

test("хэш не зависит от координат", () => {
  const first = snapshot([{ key: "a|text", value: "Цена" }]);
  const second = snapshot([{ key: "a|text", value: "Цена" }]);
  second.entries[0]!.rect = { x: 0, y: 5000, w: 800, h: 40 };

  assert.equal(hashSnapshot(first), hashSnapshot(second));
});

test("хэш не зависит от порядка обхода", () => {
  const straight = snapshot([
    { key: "a|text", value: "Первый" },
    { key: "b|text", value: "Второй" },
  ]);
  const reversed = snapshot([
    { key: "b|text", value: "Второй" },
    { key: "a|text", value: "Первый" },
  ]);

  assert.equal(hashSnapshot(straight), hashSnapshot(reversed));
});

test("хэш реагирует на правку значения", () => {
  const before = snapshot([{ key: "a|text", value: "Скидка 20%" }]);
  const after = snapshot([{ key: "a|text", value: "Скидка 35%" }]);

  assert.notEqual(hashSnapshot(before), hashSnapshot(after));
});

test("находит добавление, удаление и правку", () => {
  const before = snapshot([
    { key: "a|text", value: "Скидка 20%" },
    { key: "b|text", value: "Бесплатная доставка" },
  ]);
  const after = snapshot([
    { key: "a|text", value: "Скидка 35%" },
    { key: "c|text", value: "Осталось 3 места" },
  ]);

  const changes = diffSnapshots(before, after);
  assert.deepEqual(countChanges(changes), { added: 1, removed: 1, modified: 1 });

  const modified = changes.find((change) => change.type === "modified");
  assert.equal(modified?.before, "Скидка 20%");
  assert.equal(modified?.after, "Скидка 35%");
});

test("переезд блока на другое место не считается изменением", () => {
  // Вставка секции сверху сдвигает nth-of-type у всех соседей: ключи меняются,
  // хотя текст на странице тот же. Без сведения по значению это выглядело бы
  // как «удалили всё и добавили всё заново».
  const before = snapshot([
    { key: "section:1>p:1|text", value: "Курс по продажам" },
    { key: "section:2>p:1|text", value: "Тариф «Базовый»" },
  ]);
  const after = snapshot([
    { key: "section:2>p:1|text", value: "Курс по продажам" },
    { key: "section:3>p:1|text", value: "Тариф «Базовый»" },
  ]);

  assert.deepEqual(diffSnapshots(before, after), []);
});

test("одинаковые значения на разных узлах разводятся, а не схлопываются", () => {
  const before = snapshot([
    { key: "a|text", value: "Купить" },
    { key: "b|text", value: "Купить" },
  ]);
  const after = snapshot([
    { key: "a|text", value: "Купить" },
    { key: "b|text", value: "Заказать" },
  ]);

  const changes = diffSnapshots(before, after);
  assert.equal(changes.length, 1);
  assert.equal(changes[0]?.type, "modified");
  assert.equal(changes[0]?.key, "b|text");
});

test("номера идут сверху вниз по странице", () => {
  const before = snapshot([]);
  const after: Snapshot = {
    ...snapshot([]),
    entries: [
      { key: "low|text", kind: "text", value: "Подвал", rect: { x: 0, y: 2000, w: 100, h: 20 } },
      { key: "high|text", kind: "text", value: "Шапка", rect: { x: 0, y: 10, w: 100, h: 20 } },
    ],
  };

  const changes = diffSnapshots(before, after);
  assert.deepEqual(
    changes.map((change) => [change.index, change.after]),
    [
      [1, "Шапка"],
      [2, "Подвал"],
    ],
  );
});
