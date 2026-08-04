// Первым импортом: остальные модули читают process.env уже при загрузке.
import "./env.js";

import sharp from "sharp";

import { CONFIG_PATH, ConfigError, loadLandings } from "./config.js";
import { logger } from "./logger.js";
import { email, telegram } from "./notify/index.js";
import { acquireLock, releaseLock, runAll } from "./runner.js";
import { landingDir, orphanedDirs } from "./store.js";
import type { LandingConfig } from "./types.js";

const USAGE = `LandDiff — мониторинг лендингов

  npm run check                  проверить все лендинги
  npm run check -- --only=slug   проверить один (можно перечислить через запятую)
  npm run check -- --no-notify   проверить, но ничего не отправлять
  npm run baseline -- --all      снять baseline заново по всем
  npm run baseline -- --only=slug
  npm run list                   показать лендинги и их slug
  npm run test-mail              отправить проверочное письмо
  npm run test-telegram          отправить проверочное сообщение в чат
  npm start                      постоянный режим с расписанием
`;

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function option(name: string): string | undefined {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found?.slice(prefix.length);
}

function select(landings: LandingConfig[]): LandingConfig[] {
  const only = option("only");
  if (!only) return landings;

  const wanted = new Set(only.split(",").map((value) => value.trim()).filter(Boolean));
  const picked = landings.filter((landing) => wanted.has(landing.slug));

  const missing = [...wanted].filter((slug) => !picked.some((landing) => landing.slug === slug));
  if (missing.length > 0) {
    throw new ConfigError(
      `не нашёл лендинги: ${missing.join(", ")}. Доступные slug смотрите в \`npm run list\`.`,
    );
  }
  // --only включает лендинг явно, даже если он помечен enabled: false.
  return picked.map((landing) => ({ ...landing, enabled: true }));
}

async function commandList(): Promise<void> {
  const landings = loadLandings();
  const width = Math.max(...landings.map((landing) => landing.slug.length), 4);
  process.stdout.write(`Конфигурация: ${CONFIG_PATH}\n\n`);
  for (const landing of landings) {
    const mark = landing.enabled ? " " : "×";
    process.stdout.write(
      `${mark} ${landing.slug.padEnd(width)}  ${landing.name}\n` +
        `  ${" ".repeat(width)}  ${landing.url}\n` +
        `  ${" ".repeat(width)}  каналы: ${landing.notify.join(", ") || "нет"}\n` +
        `  ${" ".repeat(width)}  каталог: ${landingDir(landing.slug)}\n`,
    );
  }

  const orphans = await orphanedDirs(landings.map((landing) => landing.slug));
  if (orphans.length > 0) {
    process.stdout.write(`\nВ data/ остались каталоги без лендинга: ${orphans.join(", ")}\n`);
  }
}

async function commandRun(baselineOnly: boolean): Promise<void> {
  const landings = select(loadLandings());
  if (baselineOnly && !flag("all") && !option("only")) {
    throw new ConfigError("baseline перезаписывает эталон — подтвердите намерение флагом --all или --only=slug");
  }

  if (!(await acquireLock())) {
    process.exitCode = 1;
    return;
  }
  try {
    const summary = await runAll(landings, { baselineOnly, notify: !flag("no-notify") });
    if (summary.errors > 0) process.exitCode = 1;
  } finally {
    await releaseLock();
  }
}

async function commandTestMail(): Promise<void> {
  const landings = loadLandings();
  const to = option("to")?.split(",").map((value) => value.trim()) ??
    [...new Set(landings.flatMap((landing) => landing.emailTo))];

  if (to.length === 0) {
    throw new ConfigError("некому слать: заполните emailTo в config/landings.yaml или передайте --to=адрес");
  }

  await email.sendTest(to, "Если вы видите это письмо, SMTP настроен верно.");
  await email.close();
  logger.info({ to }, "проверочное письмо отправлено");
}

async function commandTestTelegram(): Promise<void> {
  // Картинка нужна, чтобы проверить не только токен, но и загрузку файлов:
  // на неё уходит другой путь в API и другой таймаут.
  const image = await sharp({
    create: { width: 600, height: 200, channels: 3, background: { r: 17, g: 24, b: 39 } },
  })
    .composite([
      {
        input: Buffer.from(
          `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="200">` +
            `<text x="30" y="115" font-family="DejaVu Sans, Arial, sans-serif" font-size="42" ` +
            `fill="#f9fafb">LandDiff на связи</text></svg>`,
        ),
        top: 0,
        left: 0,
      },
    ])
    .jpeg({ quality: 85 })
    .toBuffer();

  await telegram.sendTest("Если вы видите это сообщение, бот настроен верно.", image);
  logger.info("проверочное сообщение отправлено");
}

async function main(): Promise<void> {
  const command = process.argv[2];

  switch (command) {
    case "check":
      await commandRun(false);
      break;
    case "baseline":
      await commandRun(true);
      break;
    case "list":
      await commandList();
      break;
    case "test-mail":
      await commandTestMail();
      break;
    case "test-telegram":
      await commandTestTelegram();
      break;
    default:
      process.stdout.write(USAGE);
      process.exitCode = command ? 1 : 0;
  }
}

main().catch((error) => {
  // Ошибку конфигурации показываем как есть: в ней написано, что чинить,
  // и стек к этому ничего не добавляет.
  if (error instanceof ConfigError) {
    logger.error(error.message);
  } else {
    logger.error({ err: error instanceof Error ? error.stack : String(error) }, "команда не выполнена");
  }
  process.exitCode = 1;
});
