import assert from "node:assert/strict";
import { test } from "node:test";

import { buildChangeMessage, buildFailureMessage, mask } from "../src/notify/telegram.js";
import { maskSecret } from "../src/secrets.js";
import type { Change, ChangeReport } from "../src/types.js";

function report(changes: Array<Partial<Change>>, name = "Главный лендинг"): ChangeReport {
  const full = changes.map((change, position) => ({
    index: position + 1,
    type: "modified",
    kind: "text",
    key: `k${position}|text`,
    ...change,
  })) as Change[];

  return {
    slug: "main",
    name,
    url: "https://example.com/",
    detectedAt: "2026-07-31T15:00:00.000Z",
    changes: full,
    counts: {
      added: full.filter((change) => change.type === "added").length,
      removed: full.filter((change) => change.type === "removed").length,
      modified: full.filter((change) => change.type === "modified").length,
    },
    images: { focus: [] },
    changeDir: "/app/data/main/changes/x",
  };
}

test("разметка со страницы экранируется, а не исполняется", () => {
  // Ровно та причина, по которой в HTTPSChecker parse_mode вообще не
  // включали. Здесь он нужен ради списка изменений, поэтому весь текст,
  // пришедший с чужого сервера, обязан быть экранирован.
  const message = buildChangeMessage(
    report([{ before: "<b>цена</b> & условия", after: '<a href="http://evil">жми</a>' }]),
  );

  assert.ok(!message.includes("<b>цена</b>"));
  assert.ok(!message.includes('<a href="http://evil">'));
  assert.ok(message.includes("&lt;b&gt;цена&lt;/b&gt; &amp; условия"));
  assert.ok(message.includes("&lt;a href=&quot;http://evil&quot;&gt;жми&lt;/a&gt;"));
});

test("имя лендинга тоже экранируется", () => {
  const message = buildChangeMessage(report([{ before: "а", after: "б" }], "Лендинг <script>"));
  assert.ok(message.includes("Лендинг &lt;script&gt;"));
  // Собственная разметка сообщения при этом на месте.
  assert.ok(message.includes("<b>Лендинг &lt;script&gt;</b>"));
});

test("сообщение не выходит за лимит Bot API и сообщает про остаток", () => {
  const many = Array.from({ length: 400 }, (_, position) => ({
    before: `старое значение номер ${position} `.repeat(4),
    after: `новое значение номер ${position} `.repeat(4),
  }));

  const message = buildChangeMessage(report(many));
  assert.ok(message.length <= 3500, `длина ${message.length}`);
  assert.match(message, /…и ещё \d+ изменени/);
});

test("счётчики попадают в шапку", () => {
  const message = buildChangeMessage(
    report([{ type: "added", after: "Новое" }, { type: "removed", before: "Старое" }]),
  );
  assert.ok(message.includes("+1 добавлено"));
  assert.ok(message.includes("−1 удалено"));
});

test("сообщение об ошибке несёт причину и счётчик", () => {
  const message = buildFailureMessage({
    slug: "main",
    name: "Главный лендинг",
    url: "https://example.com/",
    detectedAt: "2026-07-31T15:00:00.000Z",
    failures: 3,
    error: "сервер ответил HTTP 503",
  });

  assert.ok(message.includes("сервер ответил HTTP 503"));
  assert.ok(message.includes("3 неудачи подряд"));
});

test("токен вырезается из текста ошибки целиком и по частям", () => {
  const token = "123456789:AAF-tHiSiSaFaKeToKeNvAlUe";

  const full = mask(`fetch failed: https://api.telegram.org/bot${token}/sendPhoto`, token);
  assert.ok(!full.includes(token));
  assert.ok(!full.includes("AAF-tHiSiSaFaKeToKeNvAlUe"));

  // В текст может попасть только секретная часть, без идентификатора бота.
  const partial = maskSecret("ошибка на AAF-tHiSiSaFaKeToKeNvAlUe", token);
  assert.ok(!partial.includes("AAF-tHiSiSaFaKeToKeNvAlUe"));
});
