/**
 * Дымовая проверка собранного образа.
 *
 * Отвечает на вопрос, который не закрывают ни сборка, ни юнит-тесты: способен
 * ли образ вообще работать. Проверяются две вещи, и обе ломаются молча.
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
 * Запускается в CI после сборки и вручную на своей установке:
 *   docker run --rm --cap-drop ALL --security-opt no-new-privileges:true \
 *     --security-opt seccomp=./seccomp-chromium.json --shm-size 1g \
 *     -v "$PWD/scripts/smoke.mjs:/app/smoke.mjs:ro" -w /app landdiff:ci \
 *     node smoke.mjs
 */
import { readFileSync, readdirSync, readlinkSync } from "node:fs";
import { chromium } from "playwright";

const fail = (message) => {
  console.error(`ПРОВЕРКА НЕ ПРОЙДЕНА: ${message}`);
  process.exit(1);
};

const version = JSON.parse(readFileSync("/app/node_modules/playwright/package.json", "utf8")).version;
console.log(`playwright ${version}, ожидает браузер в ${chromium.executablePath()}`);

let browser;
try {
  browser = await chromium.launch({
    chromiumSandbox: true,
    args: ["--disable-dev-shm-usage", "--disable-gpu"],
  });
} catch (error) {
  fail(
    `браузер не запустился — вероятно, версия playwright разошлась с тегом образа ` +
      `в Dockerfile либо снят seccomp-профиль.\n${String(error).split("\n").slice(0, 3).join("\n")}`,
  );
}

const page = await browser.newPage();
await page.setContent("<h1>smoke</h1>");
const text = await page.textContent("h1");
if (text !== "smoke") fail(`страница не отрисовалась, получено: ${JSON.stringify(text)}`);

// Renderer обязан жить в собственном user namespace: это и есть признак, что
// sandbox поднялся, а не был тихо отключён.
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

await browser.close();
console.log(`образ работоспособен: страница отрисована, renderer изолирован (${isolated} из ${renderers})`);
