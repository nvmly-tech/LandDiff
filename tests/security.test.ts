import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { ConfigError, loadLandings, slugify } from "../src/config.js";
import { escapeHtml } from "../src/notify/format.js";
import { maskSecret } from "../src/secrets.js";

function configFile(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "landdiff-sec-"));
  const path = join(dir, "landings.yaml");
  writeFileSync(path, body, "utf8");
  return path;
}

test("схемы кроме http, https и file отвергаются", () => {
  // z.string().url() сам по себе пропускает и javascript:, и data:, и ftp:.
  for (const url of ["javascript:alert(1)", "data:text/html,<script>", "ftp://example.com/"]) {
    assert.throws(
      () => loadLandings(configFile(`landings:\n  - name: Лендинг\n    url: "${url}"\n`)),
      ConfigError,
      `должен быть отвергнут: ${url}`,
    );
  }
});

test("http, https и file принимаются", () => {
  for (const url of ["https://example.com/", "http://example.com/", "file:///tmp/page.html"]) {
    const [landing] = loadLandings(configFile(`landings:\n  - name: Лендинг\n    url: "${url}"\n`));
    assert.equal(landing?.url, url);
  }
});

test("slug не выходит за пределы каталога данных", () => {
  // Имя лендинга задаёт имя каталога в data/ — точки и слэши в нём недопустимы.
  for (const name of ["../../etc/passwd", "..", "a/b/c", "~/.ssh/id_rsa"]) {
    const slug = slugify(name, "https://example.com/");
    assert.doesNotMatch(slug, /[./\\~]/, `slug из «${name}» содержит опасный символ: ${slug}`);
    assert.match(slug, /^[a-z0-9][a-z0-9-]*$/);
  }
});

test("явно заданный slug с обходом каталога не проходит схему", () => {
  assert.throws(
    () => loadLandings(configFile('landings:\n  - name: Лендинг\n    url: https://example.com/\n    slug: "../../etc"\n')),
    ConfigError,
  );
});

test("кавычки экранируются — значение попадает внутрь href", () => {
  // Без этого адрес с кавычкой закрывал бы атрибут, и остаток строки
  // становился бы разметкой письма.
  const hostile = 'https://example.com/?a="><script>alert(1)</script>';
  const escaped = escapeHtml(hostile);

  assert.ok(!escaped.includes('"'));
  assert.ok(!escaped.includes("<"));
  const attribute = `<a href="${escaped}">`;
  assert.equal(attribute.match(/"/g)?.length, 2, "в атрибуте ровно две кавычки — свои");
});

test("пустой секрет не превращает весь текст в звёздочки", () => {
  // Если токен не задан, maskSecret не должен ничего вырезать: иначе
  // ненастроенный канал стирал бы сообщения об ошибках.
  assert.equal(maskSecret("обычная ошибка", ""), "обычная ошибка");
});
