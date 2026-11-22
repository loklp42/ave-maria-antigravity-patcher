# Ave Maria Antigravity Patcher

Портативный нативный патчер для **Google Antigravity 2.34.0 (Windows и Linux)** на базе **Tauri v2 (Rust + React/TypeScript)** и кроссплатформенного CLI-ядра на Python.

Позволяет в один клик установить, обновить или откатить кастомизацию: живые и фото-обои, мини-плеер с караоке, индикатор памяти чата, полную русификацию (RU/EN), режим скрытия личных данных и мультиаккаунтное ядро.

---

## Возможности

- **Живые и статичные обои (`wallpaperEngine.js`):**
  - Автопоиск обоев Steam Wallpaper Engine (AppID `431960`) на Windows и Linux (включая Flatpak и Snap Steam).
  - Поддержка любых своих фото (`.jpg`, `.png`, `.webp`, `.gif`, `.bmp`) и видео (`.mp4`, `.webm`) через папку `custom_wallpapers/` или кнопку `+ Добавить фото / видео`.
  - Затемнение, размытие, насыщенность, контраст, масштабирование, авто-подбор акцента и WCAG-контраста текста.
  - Оптимизация GPU (отключение тяжёлого `backdrop-filter`, пауза в неактивном окне, статичный стоп-кадр в превью).
- **Музыкальный плеер и караоке (`agyExtras.js`, `agyMediaDaemon.js`):**
  - Интеграция с **Windows SMTC** и **Linux MPRIS2** (`playerctl` / `gdbus`) + управление громкостью (**CoreAudio** на Windows, **PipeWire `wpctl` / PulseAudio `pactl` / `amixer`** на Linux).
  - Синхронные тексты песен, полноэкранное караоке и аудио-визуализатор.
  - Управление прямо со свёрнутой панели (предыдущий / пауза / следующий / боковой ползунок громкости).
  - Опциональное раскрытие мини-виджета при наведении и заморозка смены строк караоке под курсором.
- **Индикатор памяти чата (`agyExtras.js`):**
  - Круговой счётчик использованных токенов контекстного окна с детальной разбивкой.
- **Русификация (RU / EN) (`agyI18n.js`):**
  - Полный перевод интерфейса Antigravity с защитой имён пользовательских папок и кода.
- **Режим скрытия личных данных:**
  - Размывает почту и аккаунтные данные как спойлер в Telegram (проявляется при наведении).
- **Мультиаккаунтное ядро (`agyTabManager.js`, `agyAccounts.js`, `agyWinUserIsolation.js`):**
  - Вкладки профилей, независимые языковые серверы и изоляция профилей (локальные пользователи на Windows, изолированные `--gemini_dir` и XDG-каталоги на Linux).

---

## Установка

### Windows
1. Скачай архив из раздела **Releases** и распакуй в любую папку.
2. *(По желанию)* Положи свои фото или видео в папку `custom_wallpapers/` — или используй установленные обои Steam Wallpaper Engine (находятся автоматически).
3. Запусти **`AntigravityPatcher.exe`**, выбери нужные компоненты и нажми **Установить патч** → **Запустить**.

### Linux
Патчер автоматически находит установку Antigravity через `PATH`, `.desktop`-файлы и стандартные каталоги (`/opt/Antigravity`, `/opt/antigravity`, `/usr/share/antigravity`, `/usr/lib/antigravity`, `~/.local/share/antigravity` и др.). Если каталог `resources/` принадлежит `root`, права запрашиваются автоматически через **Polkit (`pkexec`)**.

- **Готовый релиз (рекомендуется):**
  1. Скачай `AntigravityPatcher-linux-x64.tar.gz` из раздела **Releases** и распакуй.
  2. Запусти GUI `./AntigravityPatcher` или CLI `./patch-linux.sh install --launch`.
- **Быстрая установка через CLI из исходников (нужен только Python 3):**
  ```bash
  chmod +x patch-linux.sh
  ./patch-linux.sh install --launch
  # Проверка статуса:  ./patch-linux.sh status
  # Dry-run проверка:  ./patch-linux.sh dry-run
  # Откат на оригинал: ./patch-linux.sh restore
  # Указать папку:     ./patch-linux.sh install --dir /opt/Antigravity
  # Флаги компонентов: --no-wallpaper --no-media --no-context --no-i18n --no-accounts
  ```
- **Сборка нативного GUI-патчера (Tauri v2) из исходников:**
  ```bash
  chmod +x build-linux.sh
  ./build-linux.sh
  ./AntigravityPatcher
  ```
- *(Опционально, для лучшей работы медиаплеера на Linux)* Рекомендуется установить `playerctl` (если его нет, автоматически используется `gdbus`).
- *(Заметка для Ubuntu 24.04+)* При установке Antigravity из `.tar.gz` без SUID-бита на `chrome-sandbox` патчер при запуске автоматически добавляет `--no-sandbox`. Если запускаешь бинарник вручную — используй `--no-sandbox` или `sudo chown root:root /opt/Antigravity/chrome-sandbox && sudo chmod 4755 /opt/Antigravity/chrome-sandbox`.

> При первой установке автоматически создаётся резервная копия `app.asar.orig`. Вернуть оригинальный Antigravity можно в любой момент кнопкой **Откатить** или командой `./patch-linux.sh restore`.

---

## Архитектура и сборка из исходников

- **Desktop / Backend:** Tauri v2 (Rust) — автономный бинарник (`AntigravityPatcher.exe` / `AntigravityPatcher`) без внешних DLL, Python или Node.js в рантайме.
- **ASAR Engine (`patcher/src-tauri/src/asar.rs`, `patcher_core/asar_engine.py`):** парсер и пакер Chromium ASAR с сохранением `unpacked` (файлов и директорий), `executable`, `symlink`-метаданных и 4-МБ SHA-256 блоками целостности.
- **Frontend (`patcher/src/`):** React 19 + TypeScript + Vite 6 + чистый CSS с настройками языка (`RU / EN`), масштаба и фона.

### Требования для сборки
- [Rust](https://rustup.rs/) + `cargo-tauri` (`cargo install tauri-cli`)
- [Node.js](https://nodejs.org/) 20+
- На Linux дополнительно: `libwebkit2gtk-4.1-dev`, `libgtk-3-dev`, `libayatana-appindicator3-dev`, `librsvg2-dev` (подробные команды для Ubuntu/Fedora/Arch выводит `./build-linux.sh`)

### Команды

**Windows (PowerShell):**
```powershell
# Сборка AntigravityPatcher.exe в корень проекта
.\Build-Patcher.bat

# Запуск всех автотестов (Python + Node)
.\Run-Tests.bat

# Rust-тесты
cd patcher\src-tauri && cargo test --lib
```

**Linux (Bash):**
```bash
# Сборка GUI AntigravityPatcher в корень проекта
./build-linux.sh

# Запуск всех автотестов (Python + Node + Rust)
./run-tests.sh
```

---

## Поддержка проекта

Если патчер оказался полезен, поддержать развитие проекта можно через [DonationAlerts](https://www.donationalerts.com/r/ave_maria_dev) (подробнее в [SPONSORS.md](SPONSORS.md)).

---

## Дисклеймер и лицензия

Проект является независимой неофициальной модификацией и не связан с Google. Используйте на свой страх и риск.

Распространяется под лицензией [MIT](LICENSE).
