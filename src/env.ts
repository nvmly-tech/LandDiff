import { existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Подхватывает .env при локальном запуске.
 *
 * В контейнере файл подставляет docker compose через env_file, а на хосте
 * `npm run check` и `npm run test-mail` иначе не увидели бы ни SMTP, ни
 * токена бота. Переменные, уже заданные в окружении, loadEnvFile не трогает,
 * так что разовый `SMTP_HOST=... npm run test-mail` по-прежнему перекрывает
 * файл.
 *
 * Модуль импортируется первой строкой в точках входа: остальные читают
 * process.env уже на этапе загрузки.
 */
const path = resolve(process.env.ENV_FILE || ".env");

if (existsSync(path)) {
  process.loadEnvFile(path);
}
