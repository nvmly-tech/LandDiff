import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { ConfigError, loadLandings, slugify } from "../src/config.js";

function configFile(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "landdiff-"));
  const path = join(dir, "landings.yaml");
  writeFileSync(path, body, "utf8");
  return path;
}

test("списки складываются, остальные поля перекрываются", () => {
  const path = configFile(`
defaults:
  ignoreSelectors: ["#cookie"]
  ignorePatterns: ["\\\\d+"]
  settleMs: 1500
  notify: [email, telegram]
  emailTo: ["a@example.com"]
landings:
  - name: Первый
    url: https://example.com/
    ignoreSelectors: [".ticker"]
    settleMs: 3000
    notify: [telegram]
`);

  const [landing] = loadLandings(path);
  assert.deepEqual(landing?.ignoreSelectors, ["#cookie", ".ticker"]);
  assert.deepEqual(landing?.ignorePatterns, ["\\d+"]);
  assert.equal(landing?.settleMs, 3000);
  assert.deepEqual(landing?.notify, ["telegram"]);
  assert.deepEqual(landing?.emailTo, ["a@example.com"]);
});

test("кириллица в имени превращается в пригодный для пути slug", () => {
  assert.equal(slugify("Главный лендинг", "https://example.com/"), "glavnyy-lending");
  assert.equal(slugify("Акция 2026!", "https://example.com/"), "akciya-2026");
});

test("имя без латиницы всё равно даёт стабильный slug", () => {
  const first = slugify("日本語", "https://example.com/promo");
  const second = slugify("日本語", "https://example.com/promo");
  assert.equal(first, second);
  assert.match(first, /^[a-z0-9][a-z0-9-]*$/);
});

test("совпадающие slug ловятся при загрузке, а не в рантайме", () => {
  // Два лендинга с одним slug писали бы в один каталог и затирали baseline
  // друг другу — заметить это по письмам почти невозможно.
  const path = configFile(`
landings:
  - name: Лендинг
    url: https://example.com/a
  - name: Лендинг
    url: https://example.com/b
`);

  assert.throws(() => loadLandings(path), (error: unknown) => {
    assert.ok(error instanceof ConfigError);
    assert.match(error.message, /совпал slug/);
    return true;
  });
});

test("нерабочее регулярное выражение отвергается сразу", () => {
  const path = configFile(`
defaults:
  ignorePatterns: ["([unclosed"]
landings:
  - name: Лендинг
    url: https://example.com/
`);

  assert.throws(() => loadLandings(path), ConfigError);
});

test("отсутствующий файл объясняет, что делать", () => {
  assert.throws(() => loadLandings("/nope/landings.yaml"), (error: unknown) => {
    assert.ok(error instanceof ConfigError);
    assert.match(error.message, /landings\.example\.yaml/);
    return true;
  });
});
