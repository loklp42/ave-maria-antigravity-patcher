# Ave Maria Antigravity Patcher

<div align="center">

![Version](https://img.shields.io/badge/version-2.35.0-blue?style=flat-square)
![Tauri](https://img.shields.io/badge/Tauri_v2-Rust_%2B_React-orange?style=flat-square)
![Platform](https://img.shields.io/badge/Platform-Windows_%7C_Linux-blueviolet?style=flat-square)
![License](https://img.shields.io/badge/License-MIT-green?style=flat-square)

**Портативный нативный патчер для Google Antigravity на базе Tauri v2 (Rust + React).**  
Кастомизация в один клик: живые обои, медиаплеер с караоке, мультиаккаунты, русификация и режим приватности.

[Скачать релиз](https://github.com/ave-maria-dev/ave-maria-antigravity-patcher/releases) • [Возможности](#-возможности) • [Установка](#-установка-и-быстрый-старт) • [Разработка](#-разработка-и-сборка)

</div>

---

## ✨ Возможности

| Компонент | Что делает |
| :--- | :--- |
| 🎨 **Кастомные и живые обои** | Поддержка любых фото (`.png`, `.jpg`, `.webp`, `.gif`), видео (`.mp4`, `.webm`) и автопоиск обоев Steam Wallpaper Engine. Настройка размытия, затемнения, масштаба и адаптивного контраста. Оптимизация GPU (автопауза в неактивном окне). |
| 🎵 **Мини-плеер и караоке** | Управление текущим треком системы (Windows SMTC / Linux MPRIS2), плавный регулятор громкости, синхронный текст песен (LRC) и полноэкранный режим караоке. |
| 👥 **Мультиаккаунты и вкладки** | Несколько независимых профилей Google в одном окне с изолированными сессиями, квотами и языковыми серверами. Поддержка прямого старта с выбранного аккаунта. |
| 🌐 **Полная русификация (RU / EN)** | Качественный перевод интерфейса Antigravity с защитой имён проектов, веток и путей к коду. |
| 🔒 **Режим скрытия данных (Privacy)** | Мгновенное скрытие email и личной информации (размытие-спойлер, раскрывается при наведении). |
| 📊 **Индикатор контекста** | Наглядный круговой счётчик использованных токенов контекстного окна диалога. |

---

## 🚀 Установка и быстрый старт

> 💡 **Безопасно и обратимо:** при первом патчинге автоматически создаётся резервная копия оригинального файла `app.asar.orig`. Вернуть оригинальный Antigravity можно в любой момент одной кнопкой **«Откатить»**.

### 🪟 Windows
1. Скачайте архив релиза (`.zip`) со страницы [Releases](https://github.com/ave-maria-dev/ave-maria-antigravity-patcher/releases) и распакуйте.
2. *(Опционально)* Поместите свои фото или видео в папку `custom_wallpapers/` или добавьте их через кнопку в интерфейсе.
3. Запустите **`AntigravityPatcher.exe`**, выберите нужные функции и нажмите **«Установить патч»**.

### 🐧 Linux
1. Скачайте архив `AntigravityPatcher-linux-x64.tar.gz` из [Releases](https://github.com/ave-maria-dev/ave-maria-antigravity-patcher/releases) и распакуйте.
2. Запустите нативный GUI `./AntigravityPatcher` (или консольный скрипт `./patch-linux.sh install --launch`).
   - Патчер автоматически найдёт установку Antigravity (в `/opt`, `~/.local/share` или системном `PATH`).
   - Если требуются root-права для системной папки, автоматически откроется запрос Polkit (`pkexec`).

<details>
<summary><b>Дополнительные параметры для Linux (CLI и песочница)</b></summary>

- **Консольные команды CLI:**
  ```bash
  ./patch-linux.sh install --launch    # Установка и запуск
  ./patch-linux.sh restore             # Откат к оригиналу
  ./patch-linux.sh status              # Проверка статуса патча
  ./patch-linux.sh dry-run             # Тестовая проверка без изменения файлов
  ```
- **Медиаплеер на Linux:** для управления треками рекомендуется наличие `playerctl` (при его отсутствии используется `gdbus`).
- **Ubuntu 24.04+ (песочница):** при установке из `.tar.gz` без SUID-бита патчер автоматически передает `--no-sandbox` при запуске.
</details>

---

## 🛠️ Разработка и сборка

Патчер построен на базе **Tauri v2**: нативное Rust-ядро выполняет манипуляции с файлами и ASAR, а интерфейс работает на React 19 + TypeScript + Vite.

### Требования
- **Node.js** 20+
- **Rust** 1.82+ и `cargo-tauri` (`cargo install tauri-cli`)
- *(Только для сборки под Linux)*: пакеты WebKitGTK и GTK3 (`libwebkit2gtk-4.1-dev`, `libgtk-3-dev`)

### Сборка
- **Windows:** `.\Build-Patcher.bat` (собирает автономный `AntigravityPatcher.exe` в корень).
- **Linux:** `./build-linux.sh` (собирает нативный бинарник `AntigravityPatcher`).

### Тестирование (Dual-Gate)
Проект покрыт автоматическими тестами на 100%:
```bash
python tests/run_all_tests.py          # 23 системных теста (ASAR, патчи, безопасность)
node tests/test_modules_behavior.js    # 32 сьюта юнит-тестов логики модулей
cargo test --lib --manifest-path "patcher/src-tauri/Cargo.toml"  # 17 Rust юнит-тестов
```

---

## ☕ Поддержка проекта

Если проект вам полезен, поддержать разработку можно через [DonationAlerts](https://www.donationalerts.com/r/ave_maria_dev). Подробнее — в [SPONSORS.md](SPONSORS.md).

---

## ⚖️ Дисклеймер и лицензия

Проект является независимой пользовательской модификацией и не связан с компанией Google. Используйте на свой страх и риск.  
Распространяется под свободной лицензией [MIT](LICENSE).
