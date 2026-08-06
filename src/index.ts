// Первым импортом: остальные модули читают process.env уже при загрузке.
import "./env.js";

import cron from "node-cron";

import { CONFIG_PATH, ConfigError, loadLandings } from "./config.js";
import { logger } from "./logger.js";
import { email, telegram } from "./notify/index.js";
import { acquireLock, releaseLock, runAll } from "./runner.js";
import { env, envBool, scrubSecrets } from "./secrets.js";

const SCHEDULE = env("CRON_SCHEDULE", "0 * * * *");
const TIMEZONE = env("TZ", "UTC");

let running = false;

/**
 * Один прогон по расписанию.
 *
 * Конфигурация перечитывается каждый раз: добавить лендинг — значит поправить
 * config/landings.yaml, перезапускать контейнер для этого не нужно.
 */
async function tick(reason: string): Promise<void> {
  if (running) {
    logger.warn({ reason }, "предыдущий прогон ещё идёт, пропускаем");
    return;
  }
  running = true;
  try {
    const landings = loadLandings();
    logger.info({ reason, landings: landings.filter((landing) => landing.enabled).length }, "прогон начат");

    if (!(await acquireLock())) return;
    try {
      await runAll(landings);
    } finally {
      await releaseLock();
    }
  } catch (error) {
    if (error instanceof ConfigError) {
      // Конфиг чинится руками; падать из-за него службе незачем — следующий
      // прогон подхватит исправленный файл.
      logger.error(error.message);
    } else {
      // Стек чистим: он может нести URL с токеном в пути или ответ SMTP-сервера.
      logger.error({ err: scrubSecrets(error instanceof Error ? (error.stack ?? error.message) : String(error)) }, "прогон провалился");
    }
  } finally {
    running = false;
  }
}

function checkChannels(): void {
  if (!telegram.configured()) {
    logger.warn("Telegram не настроен: не заданы TELEGRAM_BOT_TOKEN или TELEGRAM_CHAT_ID");
  }
  if (!email.configured()) {
    logger.warn("Почта не настроена: нужны SMTP_HOST, SMTP_USER и SMTP_PASS (или SMTP_PASS_FILE)");
  }
}

async function main(): Promise<void> {
  logger.info({ schedule: SCHEDULE, timezone: TIMEZONE, config: CONFIG_PATH }, "LandDiff запущен");

  if (!cron.validate(SCHEDULE)) {
    logger.error({ schedule: SCHEDULE }, "CRON_SCHEDULE не разбирается, служба остановлена");
    process.exit(1);
  }

  checkChannels();

  const task = cron.schedule(SCHEDULE, () => void tick("расписание"), { timezone: TIMEZONE });

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "останавливаемся");
    await task.stop();
    await email.close().catch(() => {});
    // Лок снимаем всегда: иначе следующий старт решит, что прогон ещё идёт.
    await releaseLock().catch(() => {});
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  if (envBool("RUN_ON_START", true)) {
    await tick("старт");
  }
}

void main();
