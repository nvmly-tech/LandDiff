import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { ConfigError, loadLandings, slugify } from "../src/config.js";
import { escapeHtml } from "../src/notify/format.js";
import { maskSecret, scrubSecrets } from "../src/secrets.js";

function configFile(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "landdiff-sec-"));
  const path = join(dir, "landings.yaml");
  writeFileSync(path, body, "utf8");
  return path;
}

test("схемы кроме http и https отвергаются", () => {
  // z.string().url() сам по себе пропускает и javascript:, и data:, и ftp:.
  for (const url of ["javascript:alert(1)", "data:text/html,<script>", "ftp://example.com/"]) {
    assert.throws(
      () => loadLandings(configFile(`landings:\n  - name: Лендинг\n    url: "${url}"\n`)),
      ConfigError,
      `должен быть отвергнут: ${url}`,
    );
  }
});

test("http и https принимаются", () => {
  for (const url of ["https://example.com/", "http://example.com/"]) {
    const [landing] = loadLandings(configFile(`landings:\n  - name: Лендинг\n    url: "${url}"\n`));
    assert.equal(landing?.url, url);
  }
});

test("file:// закрыт по умолчанию и открывается только флагом", (t) => {
  // file:///proc/self/environ отрисовал бы токен бота в скриншот и разослал
  // его почтой, поэтому схема доступна лишь при явном ALLOW_FILE_URLS.
  const config = configFile('landings:\n  - name: Лендинг\n    url: "file:///tmp/page.html"\n');

  delete process.env.ALLOW_FILE_URLS;
  assert.throws(() => loadLandings(config), ConfigError, "без флага file:// должен быть отвергнут");

  t.after(() => {
    delete process.env.ALLOW_FILE_URLS;
  });
  process.env.ALLOW_FILE_URLS = "1";
  const [landing] = loadLandings(config);
  assert.equal(landing?.url, "file:///tmp/page.html");
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

test("scrubSecrets вычищает и токен бота, и пароль почты из одного текста", (t) => {
  // Стек исключения может нести сразу оба: URL Bot API с токеном в пути и
  // ответ SMTP-сервера. Обработчики верхнего уровня прогоняют стек через это.
  const token = "123456:AAHsecrettokenvalue";
  const pass = "smtp-app-password";
  t.after(() => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.SMTP_PASS;
  });
  process.env.TELEGRAM_BOT_TOKEN = token;
  process.env.SMTP_PASS = pass;

  const stack = `Error: fail at https://api.telegram.org/bot${token}/sendMessage\n  auth=${pass}`;
  const scrubbed = scrubSecrets(stack);

  assert.ok(!scrubbed.includes(token), "токен остался в тексте");
  assert.ok(!scrubbed.includes("AAHsecrettokenvalue"), "хвост токена остался в тексте");
  assert.ok(!scrubbed.includes(pass), "пароль остался в тексте");
  assert.ok(scrubbed.includes("api.telegram.org"), "вычистили лишнее — контекст ошибки потерян");
});

test("scrubSecrets не трогает текст, когда секреты не заданы", (t) => {
  t.after(() => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.SMTP_PASS;
  });
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.SMTP_PASS;
  assert.equal(scrubSecrets("обычная ошибка сети"), "обычная ошибка сети");
});

test("пустой секрет не превращает весь текст в звёздочки", () => {
  // Если токен не задан, maskSecret не должен ничего вырезать: иначе
  // ненастроенный канал стирал бы сообщения об ошибках.
  assert.equal(maskSecret("обычная ошибка", ""), "обычная ошибка");
});
