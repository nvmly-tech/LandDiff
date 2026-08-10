/**
 * Дымовая проверка собранного образа.
 *
 * Отвечает на вопрос, который не закрывают ни сборка, ни юнит-тесты: способен
 * ли образ делать свою работу. Проверяются три вещи, и все три ломаются молча.
 *
 * 1. Версия playwright и ревизия браузера в образе совпадают. Путь к браузеру
 *    привязан к номеру ревизии, а тег базового образа задаётся отдельно в
 *    Dockerfile. Разъедутся — браузер не запустится, но `docker build` при
 *    этом пройдёт, и тесты пройдут: они браузер не поднимают.
 *
 * 2. Sandbox поднялся. У Playwright он выключен по умолчанию, а из-под docker
 *    требует послаблений в seccomp-профиле. Снять профиль или потерять флаг —
 *    и служба продолжит работать, открывая чужие страницы без изоляции.
 *
 * 3. Извлечение содержимого работает. Функция обхода DOM уезжает в браузер
 *    через page.evaluate, и tsx оборачивает именованные функции в вызовы
 *    __name, которых на странице нет, — под это в capture.ts стоит заплатка.
 *    Смена tsx, esbuild или playwright может сломать связку, и тогда снапшот
 *    молча приходит пустым: страница «не менялась» никогда, уведомлений нет.
 *    Юнит-тесты этот путь не трогают, потому что он требует браузера.
 *
 * Запускается в CI после сборки и вручную на своей установке:
 *   docker run --rm --cap-drop ALL --security-opt no-new-privileges:true \
 *     --security-opt seccomp=./seccomp-chromium.json --shm-size 1g \
 *     -v "$PWD/scripts/smoke.mjs:/app/smoke.mjs:ro" -w /app landdiff:ci \
 *     node --import tsx smoke.mjs
 */
import { readFileSync, readdirSync, readlinkSync, writeFileSync } from "node:fs";
import { chromium } from "playwright";

import { capturePage, withBrowser } from "/app/src/capture.js";

const fail = (message) => {
  console.error(`ПРОВЕРКА НЕ ПРОЙДЕНА: ${message}`);
  process.exit(1);
};

const version = JSON.parse(readFileSync("/app/node_modules/playwright/package.json", "utf8")).version;
console.log(`playwright ${version}, ожидает браузер в ${chromium.executablePath()}`);

// Страница пишется на месте, а не берётся из fixtures: те исключены из образа,
// и проба должна работать всюду, где есть сам образ. Здесь по одному узлу на
// каждый вид записи, который умеет снимать extractSnapshot.
const PAGE = `<!doctype html><html lang="ru"><body>
  <h1>Заголовок пробы</h1>
  <p>Текст абзаца пробы</p>
  <a href="/куда-то">Ссылка пробы</a>
  <img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='40' height='40'%3E%3Crect width='40' height='40' fill='%23123456'/%3E%3C/svg%3E" alt="Картинка пробы" width="40" height="40">
  <div style="width:50px;height:50px;background-image:url('data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2210%22 height=%2210%22%3E%3C/svg%3E')">фон пробы</div>
</body></html>`;
const pagePath = "/tmp/landdiff-smoke.html";
writeFileSync(pagePath, PAGE, "utf8");

await withBrowser(async (browser) => {
  // --- Шаги 1 и 2: браузер поднялся, renderer изолирован ---
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.setContent("<h1>smoke</h1>");
  if ((await page.textContent("h1")) !== "smoke") fail("страница не отрисовалась");

  const hostNs = readlinkSync("/proc/1/ns/user");
  let renderers = 0;
  let isolated = 0;
  for (const pid of readdirSync("/proc").filter((name) => /^\d+$/.test(name))) {
    let cmdline = "";
    try {
      cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8");
    } catch {
      continue;
    }
    if (!cmdline.includes("--type=renderer")) continue;
    renderers += 1;
    if (cmdline.includes("--no-sandbox")) fail("renderer запущен с --no-sandbox");
    try {
      if (readlinkSync(`/proc/${pid}/ns/user`) !== hostNs) isolated += 1;
    } catch {
      /* процесс мог завершиться между перечислением и чтением */
    }
  }
  if (renderers === 0) fail("не найдено ни одного процесса renderer — проверять нечего");
  if (isolated === 0) fail(`renderer(ов) ${renderers}, но ни один не изолирован в своём user namespace`);
  await context.close();
  console.log(`sandbox активен: renderer изолирован (${isolated} из ${renderers})`);

  // --- Шаг 3: настоящий путь съёмки, включая page.evaluate ---
  const { snapshot, screenshot } = await capturePage(browser, {
    slug: "smoke",
    name: "smoke",
    url: `file://${pagePath}`,
    enabled: true,
    viewport: { width: 1024, height: 768 },
    settleMs: 200,
    confirm: false,
    confirmDelayMs: 0,
    navigationTimeoutMs: 20_000,
    navigationAttempts: 1,
    ignoreSelectors: [],
    ignorePatterns: [],
    notify: [],
    emailTo: [],
  });

  if (snapshot.entries.length === 0) {
    fail(
      "снапшот пуст — page.evaluate вернул ничего. Обычно это значит, что " +
        "заплатка под esbuild разошлась с версией tsx или playwright.",
    );
  }
  if (screenshot.byteLength === 0) fail("скриншот пуст");

  const kinds = new Set(snapshot.entries.map((entry) => entry.kind));
  for (const kind of ["text", "link", "img"]) {
    if (!kinds.has(kind)) fail(`в снапшоте нет записей вида «${kind}» — извлечение работает частично`);
  }
  const texts = snapshot.entries.filter((entry) => entry.kind === "text").map((entry) => entry.value);
  if (!texts.some((value) => value.includes("Заголовок пробы"))) {
    fail(`заголовок не попал в снапшот, собрано: ${JSON.stringify(texts.slice(0, 5))}`);
  }

  console.log(
    `извлечение работает: записей ${snapshot.entries.length}, ` +
      `виды [${[...kinds].join(", ")}], скриншот ${screenshot.byteLength} байт`,
  );
});

console.log("образ работоспособен");
