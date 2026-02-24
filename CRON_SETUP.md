# Запуск раз в минуту через cron-job.org

GitHub Actions не умеет schedule чаще чем раз в 5 минут. Чтобы проверять автомат каждую минуту, используем внешний cron.

## 1. Токен GitHub (PAT)

**Developer settings** — это настройки аккаунта, не репозитория.

1. В правом верхнем углу нажми на **свой аватар** → **Settings** (настройки аккаунта).
2. В левом меню в самом низу — **Developer settings** → **Personal access tokens** → **Tokens (classic)**.
3. **Generate new token (classic)**.
4. Название: например `tuya-watch-cron`.
5. Срок: на твой выбор (90 days / No expiration).
6. Права: отметь **repo** (полный доступ к репозиторию).
7. Сгенерируй и **скопируй токен** — второй раз его не покажут.

## 2. Настройка cron-job.org

1. Зарегистрируйся на [cron-job.org](https://cron-job.org) (бесплатно).
2. **Create cronjob**.
3. Поля:
   - **Title:** `Tuya Watch` (любое).
   - **URL:**  
     `https://api.github.com/repos/YOUR_USERNAME/YOUR_REPO/actions/workflows/watch.yml/dispatches`  
     Подставь вместо `YOUR_USERNAME` и `YOUR_REPO` свой логин и имя репозитория (например `Rybus1/tuya-power-watch`).
   - **Schedule:** каждую минуту — выбери **Every minute** или `* * * * *`.
   - **Request Method:** **POST**.
   - **Request Headers:** добавь два заголовка:
     - `Authorization`: `token ВАШ_GITHUB_PAT` (подставь токен из шага 1).
     - `Accept`: `application/vnd.github.v3+json`
   - **Request Body:** включи **Custom body**, тип JSON, содержимое:
     ```json
     {"ref":"main"}
     ```
     (если сервис глючит с телом — можно попробовать оставить тело пустым.)
4. Сохрани cronjob (**Create** / **Update**).

Готово. Каждую минуту cron-job.org будет отправлять POST в GitHub, и workflow будет запускаться.

## Проверка

- В репозитории: вкладка **Actions** — появятся запуски с типом `repository_dispatch` и `cron-tick`.
- При первом запуске можно включить уведомления cron-job.org о сбоях (опционально).

## Безопасность

- Токен хранится только в настройках cron-job.org и в твоём браузере.
- Не коммить токен в репозиторий.
- Если токен утёк — сразу отзови его в GitHub и создай новый.
