# Сторонние компоненты

Сам LandDiff распространяется по лицензии MIT — см. [LICENSE](LICENSE). Но в
репозитории лежит один файл, написанный не здесь, и на него распространяется
другая лицензия.

## `seccomp-chromium.json`

Профиль seccomp, под которым запускается контейнер. Производная работа от двух
источников, оба под **Apache License 2.0**:

- **Playwright** (Microsoft Corporation) — `utils/docker/seccomp_profile.json`,
  https://github.com/microsoft/playwright
- **Moby** (Docker, Inc.) — дефолтный профиль seccomp, на котором основан
  предыдущий, https://github.com/moby/moby

Полный текст Apache License 2.0: https://www.apache.org/licenses/LICENSE-2.0

### Что изменено относительно оригинала

Apache 2.0 требует обозначать изменения. К профилю Playwright добавлена ровно
одна группа синтаксисов — разрешение вызова `chroot`:

```json
{
  "names": ["chroot"],
  "action": "SCMP_ACT_ALLOW",
  "comment": "LandDiff: sandbox Chromium делает chroot внутрь user namespace…"
}
```

Она понадобилась потому, что контейнер идёт с `cap_drop: ALL`, а дефолтный
профиль Docker пускает `chroot` только при `CAP_SYS_CHROOT`. Без этой правки
sandbox Chromium не поднимается, и браузер падает с `Chromium sandboxing
failed!`. Подробности — в разделе «Безопасность» [README](README.md).

Больше в профиле ничего не менялось: всё остальное закрыто ровно так же, как в
оригинале.
