# Тег обязан совпадать с версией пакета playwright в package.json: в образе
# лежит ревизия Chromium, привязанная к конкретной версии библиотеки, и при
# расхождении Playwright откажется стартовать. Обновляете пакет — правьте тег.
#
# Рядом с тегом закреплён digest. Тег подвижен: под тем же именем в реестр
# может приехать другой образ, и пересборка молча принесёт не тот Chromium,
# в котором мы проверяли sandbox. Закреплён индекс мультиарх-образа, а не
# отдельная платформа, поэтому сборка на amd64 и arm64 по-прежнему работает.
#
# Обновить digest:
#   docker buildx imagetools inspect mcr.microsoft.com/playwright:<тег>
# и взять верхнее поле Digest.
FROM mcr.microsoft.com/playwright:v1.62.1-noble@sha256:dcc5531e97840b9b5e794f2814476b21571c5124a3fca2267d73041f56e7580e

WORKDIR /app

# Браузеры уже в образе — не даём npm скачать их второй раз.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV NODE_ENV=production

# Владелец назначается ДО установки зависимостей, и дальше всё идёт от
# pwuser — непривилегированного пользователя, который уже есть в образе
# Playwright (под root Chromium ругается на sandbox).
#
# Раньше здесь стоял `chown -R /app` после npm ci, и это стоило 77 МБ на
# ровном месте: смена владельца переписывает файл целиком, а в оверлейной
# файловой системе переписанный файл уходит в новый слой — весь node_modules
# лежал в образе дважды. Теперь chown касается двух каталогов, а не тысяч
# файлов, и npm ci сразу пишет от нужного имени.
RUN mkdir -p /app/data && chown pwuser:pwuser /app /app/data
USER pwuser

COPY --chown=pwuser:pwuser package*.json ./
RUN npm ci --omit=dev

COPY --chown=pwuser:pwuser tsconfig.json ./
COPY --chown=pwuser:pwuser src ./src

# Напрямую node, а не `npx tsx`: тот разворачивался в цепочку npm → sh → node,
# и SIGTERM от docker застревал в ней, не доходя до обработчика остановки.
CMD ["node", "--import", "tsx", "src/index.ts"]
