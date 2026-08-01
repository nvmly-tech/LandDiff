import { logger } from "../logger.js";
import { maskSecret, secret } from "../secrets.js";
import type { ChangeReport, FailureReport, LandingConfig, Notifier } from "../types.js";
import { email } from "./email.js";
import { telegram } from "./telegram.js";

export { email } from "./email.js";
export { telegram } from "./telegram.js";

const CHANNELS: Record<"email" | "telegram", Notifier> = { email, telegram };

/**
 * Последний рубеж перед журналом и history.jsonl.
 *
 * Токен бота вычищается ещё в самом канале, но сюда приходят и ошибки
 * nodemailer, а он в текст падения кладёт то, что ответил сервер. Чистим оба
 * секрета в одной точке, чтобы не гадать, какая библиотека что напишет.
 */
function sanitize(message: string): string {
  return maskSecret(maskSecret(message, secret("TELEGRAM_BOT_TOKEN")), secret("SMTP_PASS"));
}

export interface DispatchResult {
  sent: string[];
  errors: Record<string, string>;
}

/**
 * Каналы независимы: упавший телеграм не должен отменять письмо, и наоборот.
 * Ошибка канала возвращается наверх для журнала, но прогон не роняет —
 * мониторинг важнее уведомления о нём.
 */
async function dispatch(
  landing: LandingConfig,
  label: string,
  send: (notifier: Notifier) => Promise<void>,
): Promise<DispatchResult> {
  const result: DispatchResult = { sent: [], errors: {} };

  const tasks = landing.notify.map(async (name) => {
    const notifier = CHANNELS[name];
    if (!notifier.configured()) {
      logger.warn({ slug: landing.slug, channel: name }, "канал не настроен, уведомление пропущено");
      result.errors[name] = "канал не настроен";
      return;
    }
    try {
      await send(notifier);
      result.sent.push(name);
      logger.info({ slug: landing.slug, channel: name }, `${label} отправлено`);
    } catch (error) {
      const message = sanitize(error instanceof Error ? error.message : String(error));
      result.errors[name] = message;
      logger.error({ slug: landing.slug, channel: name, err: message }, `${label} не отправлено`);
    }
  });

  await Promise.all(tasks);
  return result;
}

export function dispatchChange(report: ChangeReport, landing: LandingConfig): Promise<DispatchResult> {
  return dispatch(landing, "уведомление об изменениях", (notifier) => notifier.sendChange(report, landing));
}

export function dispatchFailure(report: FailureReport, landing: LandingConfig): Promise<DispatchResult> {
  return dispatch(landing, "уведомление об ошибке", (notifier) => notifier.sendFailure(report, landing));
}
