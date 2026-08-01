import pino from "pino";

const level = process.env.LOG_LEVEL || "info";

/**
 * В контейнере журнал читают через `docker compose logs`, поэтому pretty
 * включён всегда: JSON-строки там глазами не читаются, а объём у нас
 * измеряется десятками строк в час.
 */
export const logger = pino({
  level,
  transport: {
    target: "pino-pretty",
    options: {
      colorize: process.stdout.isTTY === true,
      translateTime: "SYS:yyyy-mm-dd HH:MM:ss",
      ignore: "pid,hostname",
    },
  },
});

export type Logger = typeof logger;
