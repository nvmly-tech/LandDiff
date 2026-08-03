# Тег обязан совпадать с версией пакета playwright в package.json: в образе
# лежит ревизия Chromium, привязанная к конкретной версии библиотеки, и при
# расхождении Playwright откажется стартовать. Обновляете пакет — правьте тег.
FROM mcr.microsoft.com/playwright:v1.62.1-noble

WORKDIR /app

# Браузеры уже в образе — не даём npm скачать их второй раз.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev

COPY tsconfig.json ./
COPY src ./src

# Каталог создаётся заранее и отдаётся непривилегированному пользователю,
# который уже есть в образе Playwright: под root Chromium ругается на sandbox.
RUN mkdir -p /app/data && chown -R pwuser:pwuser /app
USER pwuser

# Напрямую node, а не `npx tsx`: тот разворачивался в цепочку npm → sh → node,
# и SIGTERM от docker застревал в ней, не доходя до обработчика остановки.
CMD ["node", "--import", "tsx", "src/index.ts"]
