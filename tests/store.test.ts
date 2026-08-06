import assert from "node:assert/strict";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// DATA_DIR читается на загрузке модуля, поэтому подменяем до импорта.
// node:test запускает каждый файл в своём процессе, так что подмена никому
// из соседних тестов не мешает.
process.env.DATA_DIR = join(mkdtempSync(join(tmpdir(), "landdiff-store-")), "data");
const { createChangeDir, landingDir, writeState, appendHistory } = await import("../src/store.js");

/** Права «для остальных» — то, что нас здесь интересует. */
const otherBits = (path: string) => statSync(path).mode & 0o007;
const ownerBits = (path: string) => (statSync(path).mode & 0o700) >> 6;

test("каталог лендинга закрыт от посторонних пользователей машины", async () => {
  // В data/ лежат скриншоты и разобранное содержимое чужих страниц: на них
  // попадают цены и персональные данные, если те есть на лендинге.
  await writeState("proba", { failures: 0 });

  const dir = landingDir("proba");
  assert.equal(otherBits(dir), 0, `каталог лендинга доступен посторонним: ${dir}`);
  assert.equal(ownerBits(dir), 7, "владелец должен сохранить полный доступ");
});

test("корень data закрыт от посторонних", async () => {
  await writeState("proba2", { failures: 0 });
  assert.equal(otherBits(process.env.DATA_DIR as string), 0, "корень data доступен посторонним");
});

test("каталог с отчётом об изменениях тоже закрыт", async () => {
  const dir = await createChangeDir("proba3", "2026-01-01T00-00-00-000Z");
  assert.equal(otherBits(dir), 0, `каталог отчёта доступен посторонним: ${dir}`);
  // Промежуточный changes/ создаётся тем же вызовом — проверяем и его.
  assert.equal(otherBits(join(landingDir("proba3"), "changes")), 0);
});

test("журнал пишется в закрытый каталог", async () => {
  await appendHistory("proba4", { ts: new Date().toISOString(), status: "unchanged" });
  assert.equal(otherBits(landingDir("proba4")), 0);
});
