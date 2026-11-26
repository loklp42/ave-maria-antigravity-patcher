"use strict";

function agyI18nBootstrap() {
    if (window.__agyI18n) return;

    function formatDurationRu(raw) {
        if (!raw) return "";
        return String(raw)
            .replace(/\bjust\s+now\b/gi, "только что")
            .replace(/<\s*1\s*m\b/gi, "<1 мин")
            .replace(/(\d+)\s*mo\b/gi, "$1 мес")
            .replace(/(\d+)\s*months?\b/gi, "$1 мес")
            .replace(/(\d+)\s*weeks?\b/gi, "$1 нед")
            .replace(/(\d+)\s*w\b/gi, "$1 нед")
            .replace(/(\d+)\s*days?\b/gi, "$1 дн")
            .replace(/(\d+)\s*d\b/gi, "$1 д")
            .replace(/(\d+)\s*hours?\b/gi, "$1 ч")
            .replace(/(\d+)\s*hrs?\b/gi, "$1 ч")
            .replace(/(\d+)\s*h\b/gi, "$1 ч")
            .replace(/(\d+)\s*minutes?\b/gi, "$1 мин")
            .replace(/(\d+)\s*mins?\b/gi, "$1 мин")
            .replace(/(\d+)\s*m\b/gi, "$1 мин")
            .replace(/(\d+)\s*seconds?\b/gi, "$1 сек")
            .replace(/(\d+)\s*secs?\b/gi, "$1 сек")
            .replace(/(\d+)\s*s\b/gi, "$1 сек")
            .replace(/\bago\b/gi, "назад");
    }

    function formatMonthRu(raw) {
        if (!raw) return "";
        const months = {
            jan: "января", january: "января",
            feb: "февраля", february: "февраля",
            mar: "марта", march: "марта",
            apr: "апреля", april: "апреля",
            may: "мая",
            jun: "июня", june: "июня",
            jul: "июля", july: "июля",
            aug: "августа", august: "августа",
            sep: "сентября", september: "сентября",
            oct: "октября", october: "октября",
            nov: "ноября", november: "ноября",
            dec: "декабря", december: "декабря"
        };
        return months[String(raw).toLowerCase()] || raw;
    }

    function formatPlanListRu(plans, genitive = true) {
        if (!plans) return "";
        let s = String(plans).trim();
        if (genitive) {
            return s
                .replace(/\bultra\s+and\s+paid\s+pro\b/gi, "Ultra и платного Pro")
                .replace(/\bpaid\s+pro\s+and\s+ultra\b/gi, "платного Pro и Ultra")
                .replace(/\bpaid\s+pro\b/gi, "платного Pro")
                .replace(/\bpro\b/gi, "Pro")
                .replace(/\bultra\b/gi, "Ultra")
                .replace(/\band\b/gi, "и")
                .replace(/\bor\b/gi, "или");
        }
        return s
            .replace(/\bultra\s+and\s+paid\s+pro\b/gi, "Ultra и Pro")
            .replace(/\bpaid\s+pro\s+and\s+ultra\b/gi, "Pro и Ultra")
            .replace(/\bpaid\s+pro\b/gi, "Pro")
            .replace(/\bpro\b/gi, "Pro")
            .replace(/\bultra\b/gi, "Ultra")
            .replace(/\band\b/gi, "и")
            .replace(/\bor\b/gi, "или");
    }

    function formatFullDateRu(raw) {
        if (!raw) return "";
        return String(raw).replace(/([A-Za-z]+)\s+(\d{1,2})(?:,?\s*(\d{4}))?/gi, (match, month, day, year) => {
            const ruMonth = formatMonthRu(month);
            if (!ruMonth || ruMonth.toLowerCase() === month.toLowerCase()) return match;
            return day + " " + ruMonth + (year ? " " + year + " г." : "");
        });
    }

    const EXACT_RU = {
        // Sidebar & Navigation
        "Home": "Главная",
        "New Conversation": "Новый чат",
        "New conversation": "Новый чат",
        "New Chat": "Новый чат",
        "New chat": "Новый чат",
        "New Window": "Новое окно",
        "New Tab": "Новая вкладка",
        "Automations": "Автоматизации",
        "Customizations": "Кастомизация",
        "Marketplace": "Маркетплейс",
        "Projects": "Проекты",
        "Project": "Проект",
        "Conversations": "Диалоги",
        "Conversation": "Диалог",
        "All Conversations": "Все диалоги",
        "Recent Conversations": "Недавние диалоги",
        "Recent": "Недавние",
        "Recents": "Недавние",
        "Settings": "Настройки",
        "Open Settings": "Открыть настройки",
        "No Project": "Без проекта",
        "Not in Project": "Вне проекта",
        "No project selected": "Проект не выбран",
        "Open IDE": "Открыть IDE",
        "Open Folder": "Открыть папку",
        "Open folder": "Открыть папку",
        "Select Folder": "Выбрать папку",
        "Select Folder(s)": "Выберите папки",
        "Select a folder.": "Выберите папку.",
        "Create Project": "Создать проект",
        "Create New Project": "Создать новый проект",
        "New Project": "Новый проект",
        "Add Project": "Добавить проект",
        "Copy Project Name": "Копировать название проекта",
        "Copy Content": "Копировать содержимое",
        "Download File": "Скачать файл",
        "Project Settings": "Настройки проекта",
        "Show in File Explorer": "Показать в проводнике",
        "Show in File Explorer...": "Показать в проводнике...",
        "Delete Project": "Удалить проект",
        "New Conversation in Project": "Новый диалог в проекте",
        "Display Options": "Параметры отображения",
        "Display": "Отображение",
        "Group By": "Группировка",
        "Sort Conversations": "Сортировка диалогов",
        "Sort Projects": "Сортировка проектов",
        "Custom Order": "Свой порядок",
        "Auto Pin": "Автозакрепление",
        "Archived Only": "Только архив",
        "Workspaces": "Рабочие области",
        "Workspace": "Рабочая область",
        "New Workspace": "Новая рабочая область",
        "Last Workspace": "Последняя рабочая область",
        "Inbox": "Входящие",
        "Archive": "Архив",
        "Archived": "В архиве",
        "Pinned": "Закреплённые",
        "Unread": "Непрочитанные",
        "See less": "Свернуть",
        "See more": "Показать ещё",
        "Show more": "Показать ещё",
        "Show less": "Свернуть",
        "View all": "Показать все",
        "Show all": "Показать все",
        "No conversations yet": "Пока нет диалогов",
        "Search": "Поиск",
        "Find": "Найти",
        "Filter": "Фильтр",
        "Sort": "Сортировка",
        "Sort by": "Сортировать по",
        "Only Unread": "Только непрочитанные",
        "Only Archived": "Только архив",
        "Only Automations": "Только автоматизации",
        "Last Updated": "По обновлению",
        "Last Prompt": "По последнему запросу",

        // Top Menu Bar & Window Menu
        "View": "Вид",
        "Window": "Окно",
        "Minimize": "Свернуть",
        "Maximize": "Развернуть",
        "Close": "Закрыть",
        "Zoom In": "Увеличить",
        "Zoom Out": "Уменьшить",
        "Reset Zoom": "Сбросить масштаб",
        "Check for Updates": "Проверить обновления",
        "Check for updates": "Проверить обновления",
        "Command Palette": "Палитра команд",
        "Open Command Palette": "Палитра команд",
        "Give Feedback": "Оставить отзыв",
        "Provide Feedback": "Оставить отзыв",
        "Send Feedback": "Отправить отзыв",
        "Connect to SSH Host...": "Подключиться к SSH-хосту...",
        "Stop SSH Server...": "Остановить SSH-сервер...",
        "SSH Host...": "SSH-хост...",
        "Open SSH Host": "Открыть SSH-хост",
        "Create a project on a machine you reach over SSH. It opens in that host's own window.": "Создать проект на удалённой машине по SSH. Откроется в отдельном окне этого хоста.",
        "Enter [user@]host[:port], or pick a host from your SSH config. Then create the project in its window.": "Введите [user@]host[:port] или выберите хост из конфигурации SSH, затем создайте проект в его окне.",
        ", or pick a host from your SSH config. Then create the project in its window.": ", или выберите хост из конфигурации SSH, затем создайте проект в его окне.",
        "or pick a host from your SSH config. Then create the project in its window.": "или выберите хост из конфигурации SSH, затем создайте проект в его окне.",
        "SSH config:": "Конфиг SSH:",
        "Choose File...": "Выбрать файл...",
        "(default)": "(по умолчанию)",
        "yet. Type one above.": "пока нет хостов. Введите адрес выше.",
        "Work in a New Worktree": "Работать в новом Worktree",
        "Keeps your checkout untouched": "Сохраняет текущую рабочую копию нетронутой",
        "Switch to This Computer": "Переключиться на этот компьютер",
        "This Computer": "Этот компьютер",
        "Your This Computer setting": "Настройка для этого компьютера",
        "Your Global setting": "Глобальная настройка",

        // Local & Global Permissions Popover
        "Local Permissions": "Локальные разрешения",
        "Local permissions": "Локальные разрешения",
        "Remote Permissions": "Удалённые разрешения",
        "Global Permissions": "Глобальные разрешения",
        "Global permissions": "Глобальные разрешения",
        "Permission preset": "Режим разрешений",
        "Security preset": "Режим безопасности",
        "Permission Mode": "Режим разрешений",
        "Permission mode": "Режим разрешений",
        "Permissions Mode": "Режим разрешений",
        "Permission Settings": "Настройки разрешений",
        "Permission Details": "Подробности разрешений",
        "Request Review": "Запрос подтверждения",
        "Require Review": "Запрос подтверждения",
        "Always Proceed": "Всегда выполнять",
        "Proceed in Sandbox": "Выполнять в песочнице",
        "Use Global": "Как в глобальных",
        "Every command requires approval.": "Каждая команда требует подтверждения.",
        "Ask before sensitive operations.": "Спрашивать перед важными операциями.",
        "Automatically decide if commands run.": "Автоматически решать запуск команд.",
        "Run all commands without restrictions.": "Выполнять все команды без ограничений.",
        "File access rules": "Правила доступа к файлам",
        "File reads": "Чтение файлов",
        "File writes": "Запись файлов",
        "Network access rules": "Правила доступа к сети",
        "Read URLs": "Чтение URL",
        "Execute URLs": "Выполнение URL",
        "Terminal commands": "Команды терминала",
        "Commands outside sandbox": "Команды вне песочницы",
        "MCP tools": "Инструменты MCP",
        "Tool permissions": "Разрешения инструментов",
        "Modify permissions for file, terminal, and MCP tools.": "Права доступа для файлов, терминала и MCP-инструментов.",
        "Configure what the agent can do in local and remote conversations.": "Настройка действий агента в локальных и удалённых диалогах.",
        "Configure global allowed and denied resource permissions.": "Настройка глобальных разрешений и запретов доступа к ресурсам.",
        "Terminal sandbox is not supported in this environment": "Песочница терминала не поддерживается в этой среде",
        "Outside of folders file access policy": "Доступ к файлам вне рабочих папок",
        "Configures how the agent tries to access files outside of its working folders.": "Определяет порядок доступа агента к файлам вне рабочих папок.",
        "Enable sandbox mode": "Включить песочницу",
        "Restricts agent tools to a secure, isolated local sandbox.": "Ограничивает инструменты агента изолированной локальной песочницей.",
        "Enable terminal sandbox": "Песочница терминала",
        "Terminal command auto execution": "Автовыполнение команд терминала",
        "Command setup script": "Скрипт инициализации команд",
        "The agent always asks for confirmation before executing terminal commands (except those in the Allow list).": "Агент всегда запрашивает подтверждение перед запуском команд терминала (кроме разрешённых).",
        "Terminal command automatically proceeds if the command runs inside the sandbox. Otherwise, it requests review.": "Команды выполняются автоматически внутри песочницы, иначе запрашивается подтверждение.",
        "Terminal commands automatically proceed inside the sandbox. A command that needs to leave the sandbox proceeds only if an agent judges it reversible, and otherwise requests review.": "Команды автоматически выполняются в песочнице. Вне песочницы — только обратимые, иначе с подтверждением.",
        "The agent never asks for confirmation before executing terminal commands (except those in the Deny list). This provides the agent with the maximum ability to operate over long periods without intervention, but also has the highest risk of the agent executing an unsafe terminal command.": "Агент выполняет все команды терминала без подтверждения (кроме запрещённых). Максимальная автономность, но повышенный риск.",

        // Onboarding Modal (exact + split React text nodes)
        "One last thing before getting started...": "Последний шаг перед началом...",
        "A few things to know, and a couple settings to review.": "Несколько важных моментов и настроек перед стартом.",
        "Optimized for you": "Настроено под вас",
        "Built to help, not hurt": "Создано помогать, а не вредить",
        "You are in control": "Вы всё контролируете",
        "Stay up to date.": "Будьте в курсе.",
        "Customize your experience across the agent, plugins, and product from the settings and marketplace. We won't show you ads or let advertisers influence what": "Настройте агента, плагины и интерфейс в настройках и маркетплейсе. Мы не показываем рекламу и не позволяем рекламодателям влиять на ответы",
        "Automated safeguards help to protect your conversations from insecure or unsafe content. That being said, users should be aware of potential agentic risks, including data exfiltration.": "Автоматическая защита оберегает ваши диалоги от небезопасного контента. При этом помните о потенциальных рисках работы агентов, включая утечку данных.",
        "'s agents are powerful and will help you get a lot done better and faster than before, but still make sure to verify the actions taken by the agent.": ": агенты помогают делать работу быстрее и лучше, но всегда проверяйте выполняемые ими действия.",
        "Telemetry is turned off for your account.": "Телеметрия отключена для вашего аккаунта.",
        "does not collect any of your prompts, content, or model responses but will still collect general usage patterns (e.g., feature adoption, active user counts).": "не собирает ваши промпты, контент или ответы моделей, но учитывает общую статистику использования функций.",
        "does not collect any of your prompts, content, or model responses but does collect general usage patterns such as feature adoption and active user counts (\"product analytics\"). Telemetry data will be handled in accordance with the Google Privacy Policy.": "не собирает ваши промпты, контент или ответы моделей, но учитывает общую аналитику использования в соответствии с Политикой конфиденциальности Google.",
        "AI coding agents are known to have certain security risks, including autonomous code execution, data exfiltration, prompt injection and supply chain risks. Ensure that you monitor and verify all actions taken by the agent.": "AI-агенты для разработки связаны с рисками безопасности, включая автономное выполнение кода, утечку данных и инъекции промптов. Всегда контролируйте и проверяйте действия агента.",
        "Allow Google to collect and use your Interactions data, subject to the": "Разрешить Google собирать и использовать данные взаимодействий согласно",
        "Terms of Service": "Условия использования",
        "Terms of Service & Data Use": "Условия и использование данных",
        "Terms and Privacy:": "Условия и конфиденциальность:",
        "Privacy Policy": "Политика конфиденциальности",
        "Privacy Notice": "Уведомление о конфиденциальности",
        "(excluding product analytics data)": "(кроме данных продуктовой аналитики)",
        "Google Privacy Policy": "Политике конфиденциальности Google",
        ". You can control this from your settings at any point.": ". Вы можете изменить это в настройках в любой момент.",
        "You can control this from your settings at any point.": "Вы можете изменить это в настройках в любой момент.",
        "Sign up for newsletters, tips and tricks, and other notifications about": "Подписаться на рассылку, советы и уведомления о",
        "Build with one agent or a team": "Работайте с одним агентом или командой",
        "Describe what you want. Your agent plans and builds it, and brings in other agents when needed.": "Опишите задачу. Агент составит план, выполнит его и при необходимости подключит других агентов.",
        "Review plans and walkthroughs": "Проверяйте планы и обзоры",
        "Comment on the plan before your agent starts, and get a walkthrough when it finishes.": "Комментируйте план до запуска агента и получайте подробный обзор после завершения.",
        "Set the rules, define the boundaries.": "Задавайте правила и границы.",
        "By default, agents work in folders you choose and ask before sensitive changes. Adjust this anytime in Settings.": "По умолчанию агенты работают в выбранных папках и спрашивают перед важными изменениями. Это можно настроить в Настройках.",
        "Let's tailor the experience for you. What best describes your work?": "Давайте настроим интерфейс под вас. Чем вы занимаетесь?",
        "Data & Analytics": "Данные и аналитика",
        "Science": "Наука",
        "Design": "Дизайн",
        "Other": "Другое",
        "Changes to third-party model access": "Изменения доступа к сторонним моделям",
        "Notice": "Примечание",

        // Composer, Model Selector & Tooltips
        "Ask anything, @ to mention, / for actions": "Спросите что угодно, @ — упоминания, / — команды",
        "Ask anything, @ to mention": "Спросите что угодно, @ — упоминания",
        "Message subagent, @ to mention, / for actions": "Напишите субагенту, @ — упоминания, / — команды",
        "Message subagent, @ to mention": "Напишите субагенту, @ — упоминания",
        "Leave a comment": "Оставить комментарий",
        "Edit comment": "Изменить комментарий",
        "Add Comment": "Добавить комментарий",
        "Save Comment": "Сохранить комментарий",
        "Submit": "Отправить",
        "Model": "Модель",
        "Select Model": "Выбрать модель",
        "Select model": "Выбрать модель",
        "Switch model": "Сменить модель",
        "Change model": "Сменить модель",
        "Applies to /btw and messages sent after this turn": "Применяется к /btw и сообщениям, отправленным после этого шага",
        "Best of N Models": "Модели Best-of-N",
        "Orchestrator": "Оркестратор",
        "The Orchestrator's own planner": "Собственный планировщик оркестратора",
        "Thinking effort": "Глубина размышлений",
        "Reasoning effort": "Глубина размышлений",
        "Effort": "Глубина",
        "Controls how much time and quota the model spends reasoning before responding. Higher effort improves accuracy on hard problems, at the cost of slower responses and higher quota use.": "Определяет, сколько времени и квоты модель тратит на размышление перед ответом. Высокий уровень повышает точность на сложных задачах, но замедляет ответы и увеличивает расход квоты.",
        "Offloads routine steps to a faster executor. Same quality, fewer tokens used.": "Передаёт рутинные шаги быстрому исполнителю. То же качество, меньше токенов.",
        "For most deep reasoning and complex problems": "Для глубокого анализа и сложных задач",
        "The original Gemini 4 model for advanced workflows": "Оригинальная модель Gemini 4 для сложных рабочих процессов",
        "The original Gemini 4 model for advanced workflows. Leaving on Nov 30.": "Оригинальная модель Gemini 4 для сложных рабочих процессов. Будет отключена 30 ноября.",
        "The original Gemini 4 model for advanced workflows. Leaving on Nov 30": "Оригинальная модель Gemini 4 для сложных рабочих процессов. Будет отключена 30 ноября",
        "Leaving on Nov 30.": "Будет отключена 30 ноября.",
        "Leaving on Nov 30": "Будет отключена 30 ноября",
        "Leaving Soon": "Скоро устареет",
        "Leaving soon": "Скоро устареет",
        "Use Hydrogen for better quality with lower quota usage. Leaving on Nov 30.": "Используйте Hydrogen для лучшего качества при меньшем расходе квоты. Будет отключена 30 ноября.",
        "Use Hydrogen for better quality with lower quota usage. Leaving on Nov 30": "Используйте Hydrogen для лучшего качества при меньшем расходе квоты. Будет отключена 30 ноября",
        "Use Hydrogen for better quality with lower quota usage.": "Используйте Hydrogen для лучшего качества при меньшем расходе квоты.",
        "Use Hydrogen for better quality with lower quota usage": "Используйте Hydrogen для лучшего качества при меньшем расходе квоты",
        "Gemini 4 Hydrogen is currently available to paid Pro and Ultra subscribers.": "Gemini 4 Hydrogen сейчас доступна подписчикам тарифов платного Pro и Ultra.",
        "Gemini 4 Neon is currently available to paid Pro and Ultra subscribers.": "Gemini 4 Neon сейчас доступна подписчикам тарифов платного Pro и Ultra.",
        "Gemini 4 Argon is currently available to Ultra and paid Pro subscribers.": "Gemini 4 Argon сейчас доступна подписчикам тарифов Ultra и платного Pro.",
        "Gemini 4 Carbon is currently available to Ultra and paid Pro subscribers.": "Gemini 4 Carbon сейчас доступна подписчикам тарифов Ultra и платного Pro.",
        "Gemini 4 Argon is currently available to Ultra and paid Pro plan subscribers.": "Gemini 4 Argon сейчас доступна подписчикам тарифов Ultra и платного Pro.",
        "Gemini 4 Carbon is currently available to Ultra and paid Pro plan subscribers.": "Gemini 4 Carbon сейчас доступна подписчикам тарифов Ultra и платного Pro.",
        "Gemini 4 Hydrogen is currently available to paid Pro and Ultra plan subscribers.": "Gemini 4 Hydrogen сейчас доступна подписчикам тарифов платного Pro и Ultra.",
        "Gemini 4 Neon is currently available to paid Pro and Ultra plan subscribers.": "Gemini 4 Neon сейчас доступна подписчикам тарифов платного Pro и Ultra.",
        "Opus 5.5 is now available on paid Pro and Ultra plans. Third-party model access will no longer be available on your current plan starting on November 30, 2026.": "Opus 5.5 доступна на платных тарифах Pro и Ultra. Доступ к сторонним моделям на вашем текущем тарифе прекратится с 30 ноября 2026 г.",
        "Sonnet 5.5 is now available on paid Pro and Ultra plans. Third-party model access will no longer be available on your current plan starting on November 30, 2026.": "Sonnet 5.5 доступна на платных тарифах Pro и Ultra. Доступ к сторонним моделям на вашем текущем тарифе прекратится с 30 ноября 2026 г.",
        "For speed and efficiency in execution tasks": "Для высокой скорости и эффективности выполнения задач",
        "Add Model": "Добавить модель",
        "Edit Model": "Изменить модель",
        "Loading models...": "Загрузка моделей...",
        "No models available": "Нет доступных моделей",
        "Custom models are only supported on Linux machines.": "Пользовательские модели поддерживаются только на Linux.",
        "Model quota reached": "Квота модели исчерпана",
        "Baseline model quota reached": "Базовая квота модели исчерпана",
        "Insufficient AI Credits": "Недостаточно AI-кредитов",
        "Your AI credits balance is too low to continue.": "Недостаточно AI-кредитов для продолжения.",
        "To continue using this model now, enable AI Credit overages.": "Чтобы продолжить использовать эту модель сейчас, включите списание AI-кредитов.",
        "Enable Overages": "Включить кредиты",
        "Purchase Credits": "Купить кредиты",
        "See Plans": "Смотреть тарифы",
        "See plans": "Смотреть тарифы",
        "Select another model": "Выбрать другую модель",
        "Plan upgrade required": "Требуется обновление тарифа",
        "Conversation limit reached": "Достигнут лимит диалогов",
        "Daily conversation limit reached": "Достигнут дневной лимит диалогов",
        "Authentication expired": "Сессия истекла",
        "Your session has expired. Please log back in to continue.": "Срок действия сессии истёк. Войдите снова для продолжения.",
        "Log back in": "Войти снова",
        "Verification required": "Требуется подтверждение",
        "Action required": "Требуется действие",
        "Agent terminated due to error": "Агент остановлен из-за ошибки",
        "Too many requests, please try again in a bit!": "Слишком много запросов, попробуйте немного позже.",
        "Too many environments running": "Запущено слишком много окружений",
        "Copy debug info": "Копировать отладку",

        // Usage Popover & Models Settings
        "Usage": "Использование",
        "View Usage": "Показать расход",
        "Usage & Billing": "Расход и оплата",
        "Models": "Модели",
        "Models Tab": "Вкладка моделей",
        "Models & Usage": "Модели и расход",
        "Default Model": "Модель по умолчанию",
        "Model Quota": "Квота моделей",
        "Model Credits": "Кредиты моделей",
        "Manage your model quota and credits.": "Управление квотами и кредитами моделей.",
        "Refresh quota and credits data": "Обновить квоту и кредиты",
        "Refreshing...": "Обновление...",
        "No quota information available.": "Нет данных о квоте.",
        "Plan": "Тариф",
        "Current Plan": "Текущий тариф",
        "Your Plan:": "Ваш тариф:",
        "Available AI Credits:": "Доступно AI-кредитов:",
        "Subscription": "Подписка",
        "Manage Subscription": "Управление подпиской",
        "Upgrade": "Обновить тариф",
        "Pay As You Go": "Оплата по факту",
        "Quota": "Квота",
        "Credits": "Кредиты",
        "Billing": "Оплата",
        "Enable AI Credit Overages": "Использовать AI-кредиты сверх лимита",
        "When toggled on, Antigravity will use your AI credits to fulfill model requests once you're out of model quota. Antigravity will always use your model quota first before using AI credits.": "При включении Antigravity расходует AI-кредиты после исчерпания квоты моделей. Сначала всегда используется основная квота.",
        "See Activity": "История",
        "Get More AI Credits": "Пополнить кредиты",
        "Orchestrator Settings": "Настройки оркестратора",
        "Choose the models Orchestrator uses. A larger, smarter orchestrator model with a faster, cheaper executor gives high quality for fewer tokens.": "Выберите модели оркестратора. Мощный планировщик и быстрый исполнитель дают высокое качество при меньшем расходе токенов.",
        "Orchestrator Model": "Модель-оркестратор",
        "Plans the work, makes design decisions, and reviews the result. Pick a top-tier model. You can also pick one per conversation from the Orchestrator row in the model menu.": "Планирует работу, принимает архитектурные решения и проверяет результат. Можно также выбрать отдельно для диалога в меню моделей.",
        "Executor Model": "Модель-исполнитель",
        "Carries out the plan: searches, edits, builds, and tests. Pick a faster, cheaper model.": "Выполняет план: поиск, правки, сборка и тесты. Выберите более быструю и экономичную модель.",
        "Gemini Models": "Модели Gemini",
        "Claude and GPT models": "Модели Claude и GPT",
        "Claude & GPT": "Модели Claude и GPT",
        "Gemini & Argon": "Модели Gemini и Argon",
        "Gemini & Argon Models": "Модели Gemini и Argon",
        "Weekly Limit Remaining": "Недельный лимит",
        "Five Hour Limit Remaining": "5-часовой лимит",
        "Gemini 4 Argon Weekly Limit": "Недельный лимит Gemini 4 Argon",
        "Weekly limit": "Недельный лимит",
        "Daily limit": "Дневной лимит",
        "5h limit": "Лимит за 5 ч",
        "% left": "% осталось",
        "You can upgrade to a Google AI Ultra plan to receive higher rate limits.": "Вы можете перейти на тариф Google AI Ultra для увеличения лимитов.",
        "For Antigravity Business consumption options, see": "Варианты тарификации Antigravity Business описаны в",

        // Settings — General
        "General": "Основные",
        "Configure agent execution, queued message delivery, and permissions.": "Настройка работы агента, очереди сообщений и разрешений.",
        "Interface Layout": "Макет интерфейса",
        "Knowledge Work": "Работа со знаниями",
        "Software Engineering": "Разработка ПО",
        "Simplified interface for research, writing, and everyday tasks.": "Упрощённый интерфейс для исследований, текстов и повседневных задач.",
        "Full interface for coding, developer tools, and managing agents.": "Полный интерфейс для разработки, инструментов и управления агентами.",
        "The full developer experience.": "Полный набор инструментов разработчика.",
        "Project 4K interface without developer tooling.": "Упрощённый интерфейс без инструментов разработки.",
        "Queued messages": "Сообщения в очереди",
        "Configure when follow-up messages are sent.": "Настройка отправки последующих сообщений.",
        "Queue": "В очередь",
        "Queued": "В очереди",
        "Send Immediately": "Отправлять сразу",
        "Queue until after the current turn.": "Ставить в очередь до завершения текущего шага.",
        "Interrupt the agent and send immediately.": "Прервать агента и отправить сразу.",
        "Send message": "Отправка сообщения",
        "Choose which key sends a message in the chat composer.": "Выберите клавишу для отправки сообщений в чате.",
        "Enter to send": "Отправка по Enter",
        "Send with Enter": "Отправлять по Enter",
        "Send messages with the keyboard's Enter key instead of starting a new line.": "Отправлять сообщения клавишей Enter вместо переноса строки.",
        "Press Enter to send, Shift+Enter for a new line.": "Enter — отправка, Shift+Enter — новая строка.",
        "Press Ctrl+Enter to send, Enter for a new line.": "Ctrl+Enter — отправка, Enter — новая строка.",
        "Press Cmd+Enter to send, Enter for a new line.": "Cmd+Enter — отправка, Enter — новая строка.",
        "New conversation button": "Кнопка «Новый чат»",
        "Which workspace the New Conversation button and keyboard shortcut start you in.": "В какой рабочей области открывается новый диалог.",
        "Create a new workspace from your first message.": "Создавать новую рабочую область из первого сообщения.",
        "Start without a workspace, for general questions.": "Начинать без рабочей области, для общих вопросов.",
        "Reuse your last workspace.": "Использовать последнюю рабочую область.",
        "Voice": "Голос",
        "Voice engine": "Голосовой движок",
        "The voice used in Voice mode. Powered by Gemini Live.": "Голос в голосовом режиме (на базе Gemini Live).",
        "How loud Antigravity's voice is.": "Громкость голоса Antigravity.",
        "System default": "По умолчанию",
        "Microphone": "Микрофон",
        "Input device for voice mode and dictation.": "Микрофон для голосового режима и диктовки.",
        "Recordings": "Записи",
        "No recordings": "Нет записей",
        "Save audio recordings": "Сохранять аудиозаписи",
        "Delete all": "Удалить все",
        "Delete all recordings?": "Удалить все записи?",
        "Not set": "Не задано",
        "A shell setup script run before every command the agent executes.": "Скрипт инициализации оболочки перед выполнением команд агента.",
        "Run terminal commands with sandbox restrictions.": "Запускать команды терминала в песочнице.",

        // Settings — Application
        "Application": "Приложение",
        "App": "Приложение",
        "Manage Antigravity app settings.": "Управление параметрами приложения Antigravity.",
        "Prevent Sleep": "Не давать засыпать",
        "Keep Awake": "Не давать засыпать",
        "Prevent the computer from sleeping while the app is running.": "Не давать компьютеру засыпать во время работы приложения.",
        "Keep In Menu Bar": "Оставлять в трее",
        "Keep the app accessible from the menu bar and running in the background when all windows are closed.": "Оставлять приложение в трее и продолжать работу в фоне после закрытия окон.",
        "Keep the app running in the background when all windows are closed.": "Оставлять приложение в фоне после закрытия всех окон.",
        "Run in Background": "Работа в фоне",
        "Run in background": "Работа в фоне",
        "Updater": "Обновления",
        "Updates": "Обновления",
        "Auto Update": "Автообновление",
        "Automatic Check for Updates": "Автопроверка обновлений",
        "Automatically prompt you to restart the app when a new update is available. When disabled, you can check for updates manually from the app menu.": "Автоматически предлагать перезапуск при выходе обновления. Если выключено, обновления можно проверять вручную в меню.",
        "Remote Control": "Удалённое управление",
        "Open in Remote Control": "Открыть в удалённом управлении",
        "Enable Remote Control": "Удалённое управление",
        "Work with local agents from another device.": "Работайте с локальными агентами с другого устройства.",
        "Manage your conversations from the companion website.": "Управляйте диалогами с веб-сайта.",
        "Device Name": "Имя устройства",
        "Nickname": "Имя устройства",
        "A label for this computer when you connect from another device. Changing it reconnects.": "Имя этого компьютера для подключения с других устройств. Изменение переподключит сессию.",
        "A nickname for identifying this application in the companion website. Changing this will restart the connection.": "Имя для отображения этого приложения на веб-сайте. Изменение перезапустит соединение.",
        "Scan the code to open this device in Remote Control, or": "Отсканируйте QR-код для удалённого управления или",
        "copy link": "скопируйте ссылку",
        "Continue your work from another device with Remote Control. Scan the QR code or open the link below.": "Продолжите работу с другого устройства через удалённое управление. Отсканируйте QR-код или откройте ссылку ниже.",
        "Notification Settings": "Настройки уведомлений",
        "To modify notification settings, open your operating system's system preferences.": "Чтобы изменить параметры уведомлений, откройте системные настройки ОС.",
        "Open System Preferences": "Системные настройки",

        // Settings — Appearance
        "Appearance": "Внешний вид",
        "Configure the agent's visual theme and display preferences.": "Настройка темы и параметров отображения.",
        "Theme": "Тема",
        "Color Theme": "Цветовая тема",
        "Dark": "Тёмная",
        "Light": "Светлая",
        "System": "Системная",
        "Auto (System)": "Авто (система)",
        "Contrast": "Контрастность",
        "Strong": "Высокая",
        "Font": "Шрифт",
        "Font Size": "Размер шрифта",
        "Font Family": "Шрифт",
        "Dark Theme": "Тёмная тема",
        "Light Theme": "Светлая тема",
        "Preset": "Пресет",
        "Default Dark": "Тёмная по умолчанию",
        "Default Light": "Светлая по умолчанию",
        "Reset to preset": "Сбросить пресет",
        "Background": "Фон",
        "Foreground": "Текст",
        "Accent": "Акцент",
        "Code Preview": "Предпросмотр кода",
        "Conversation Steps": "Шаги диалога",
        "Choose how much detail is shown during a conversation.": "Уровень подробности отображения хода диалога.",
        "Verbose": "Подробно",
        "Custom Context Menus": "Быстрое контекстное меню",
        "Replace the default browser right-click menu with quick actions.": "Заменить стандартное контекстное меню браузера быстрыми действиями.",
        "Screen Reader": "Экранный диктор",
        "Screen Reader Mode": "Режим экранного диктора",
        "Optimize the interface and terminal output for screen readers.": "Оптимизировать интерфейс и терминал для экранных дикторов.",
        "Chat": "Чат",
        "Chat Layout": "Макет чата",
        "Chat Settings": "Настройки чата",
        "Conversation Width": "Ширина диалога",
        "Configure the maximum width of the conversation panel.": "Максимальная ширина панели диалога.",
        "Narrow": "Узкий",
        "Standard": "Стандартный",
        "Wide": "Широкий",
        "Full": "Полная",
        "Fill": "Заполнить",
        "Terminal Placement": "Расположение терминала",
        "Terminal Location": "Расположение терминала",
        "Choose where terminal sessions appear.": "Выберите расположение сессий терминала.",
        "Side Panel": "Боковая панель",
        "Bottom Panel": "Нижняя панель",
        "Markdown Artifact Width": "Ширина артефактов",
        "Artifact Width": "Ширина артефакта",
        "Configure the default width of markdown artifacts.": "Ширина markdown-артефактов по умолчанию.",
        "Context and Quota Indicator": "Индикатор контекста и квоты",
        "Show how full the context window is next to the send button. Click it for a breakdown and to see your model quota.": "Показывать заполненность контекстного окна рядом с кнопкой отправки. Нажмите для подробностей и квот.",
        "Layout": "Макет",
        "Density": "Плотность",
        "Compact": "Компактный",
        "Comfortable": "Комфортный",
        "Spacious": "Просторный",
        "Input Box": "Поле ввода",
        "Composer": "Поле ввода",

        // Settings — Shortcuts (categories, controls & all command labels)
        "Shortcuts": "Горячие клавиши",
        "Keyboard Shortcuts": "Горячие клавиши",
        "Keyboard shortcuts": "Горячие клавиши",
        "Keyboard shortcuts for quick navigation and control.": "Горячие клавиши для быстрой навигации и управления.",
        "Keybinding Scheme": "Схема клавиш",
        "Antigravity (AGY) Style": "Стиль Antigravity (AGY)",
        "VS Code Default": "По умолчанию (VS Code)",
        "Choose between non-colliding VS Code defaults or standalone Antigravity chords.": "Выберите схему клавиш VS Code или сочетания Antigravity.",
        "Manage your keybinding scheme and customize shortcuts in VS Code.": "Управление схемой клавиш и горячими клавишами.",
        "All active Antigravity shortcuts and user keybinding overrides are managed directly by VS Code.": "Все активные сочетания клавиш Antigravity управляются напрямую в VS Code.",
        "Customize Shortcuts": "Настроить сочетания клавиш",
        "Open Keyboard Shortcuts": "Открыть сочетания клавиш",
        "Search shortcuts...": "Поиск горячих клавиш...",
        "Search shortcuts ...": "Поиск горячих клавиш...",
        "Search shortcuts": "Поиск горячих клавиш",
        "Clear search": "Очистить поиск",
        "Navigation": "Навигация",
        "Layout Controls": "Управление макетом",
        "Add Shortcut": "Добавить сочетание",
        "Edit Shortcut": "Изменить сочетание",
        "Remove Shortcut": "Удалить сочетание",
        "Reset to Default": "Сбросить",
        "Reset All to Defaults": "Сбросить все",
        "Stop Editing": "Завершить",
        "Press keys...": "Нажмите клавиши...",
        "Click": "Клик",
        "Middle Click": "Средняя кнопка",
        "Open File Search": "Поиск файлов",
        "Open Conversation in New Tab": "Открыть диалог в новой вкладке",
        "Select Previous Conversation": "Предыдущий диалог",
        "Select Next Conversation": "Следующий диалог",
        "Move Conversation Up": "Переместить диалог вверх",
        "Move Conversation Down": "Переместить диалог вниз",
        "Previous Side Panel Tab": "Предыдущая вкладка боковой панели",
        "Next Side Panel Tab": "Следующая вкладка боковой панели",
        "Collapse All Folders": "Свернуть все папки",
        "Expand All Folders": "Развернуть все папки",
        "Toggle Sidebar": "Показать/скрыть панель",
        "Toggle Side Panel": "Боковая панель",
        "Toggle Terminal": "Терминал",
        "Toggle Overview Panel": "Обзор",
        "Toggle Word Wrap": "Перенос строк",
        "Toggle Model Selector": "Выбор модели",
        "Toggle Project Selector": "Выбор проекта",
        "Toggle Environment Selector": "Выбор окружения",
        "Toggle Maximize Side Panel": "Развернуть боковую панель",
        "Toggle Between Light/Dark Themes": "Переключить светлую/тёмную тему",
        "Open Conversation Picker": "Выбор диалога",
        "Search Conversations": "Поиск по диалогам",
        "Open Workspace Selector": "Выбор рабочей области",
        "File Picker": "Выбор файла",
        "Code Search": "Поиск по коду",
        "Open in Code Search": "Поиск по коду (Code Search)",
        "Terminal: Add to Chat": "Терминал: добавить в чат",
        "Terminal: Select All": "Терминал: выделить всё",
        "Submit Prompt (Alternate to Enter)": "Отправить запрос (альтернатива Enter)",
        "Enter always submits. This adds a second shortcut.": "Enter всегда отправляет. Это добавляет второе сочетание.",
        "Open Trajectory Debug View": "Отладка траектории",
        "This shortcut is reserved by browser tabs and may not trigger in Web mode. It works in the Desktop Hub or installed PWA.": "Это сочетание зарезервировано вкладками браузера в веб-режиме, но работает в десктопном приложении.",

        // Settings — Notifications
        "Notifications": "Уведомления",
        "Manage your notification preferences.": "Настройка уведомлений.",
        "Enable Notifications for Agent": "Уведомления агента",
        "Show system notifications when your action is needed or the agent finishes.": "Показывать системные уведомления при завершении или запросе действия.",
        "Enable Sounds for Agent": "Звуки агента",
        "Play a sound when your action is needed or the agent finishes.": "Воспроизводить звук при завершении задачи или запросе действия.",
        "Sound": "Звук",
        "Sounds": "Звуки",
        "Sound Effects": "Звуковые эффекты",
        "Agent Sound": "Звук агента",
        "Agent Sounds": "Звуки агента",
        "Notification Sound": "Звук уведомлений",
        "Volume": "Громкость",
        "Chime volume": "Громкость сигнала",
        "Sound Volume": "Громкость звука",
        "Audio Volume": "Громкость аудио",
        "Set the volume of agent sounds.": "Громкость звуковых уведомлений агента.",
        "System Notifications": "Системные уведомления",
        "Desktop Notifications": "Уведомления на рабочем столе",

        // Settings — Browser
        "Browser": "Браузер",
        "Built-in Browser": "Встроенный браузер",
        "External Browser": "Внешний браузер",
        "Side Panel Preview": "Предпросмотр в боковой панели",
        "Configure built-in browser, link opening, and browser subagent preferences.": "Настройки встроенного браузера, ссылок и браузерного агента.",
        "Open Links In": "Открывать ссылки в",
        "Choose where links open by default when clicked.": "Выберите, где открывать ссылки по клику.",
        "Download Location": "Папка загрузок",
        "Folder where files downloaded in the built-in browser are saved.": "Папка для сохранения файлов из встроенного браузера.",
        "Change...": "Изменить...",
        "Browsing Data": "Данные браузера",
        "Browsing History": "История просмотров",
        "Browsing history": "История просмотров",
        "Manage": "Управление",
        "Clear visited URLs and autocomplete suggestions from the built-in browser.": "Очистить историю посещённых сайтов и подсказок встроенного браузера.",
        "Clear history, cookies and site data from the built-in browser, or manage cookies for each site.": "Очистка истории, cookie и данных сайтов встроенного браузера.",
        "Cookies by Site": "Файлы cookie по сайтам",
        "Cookies and site data": "Cookie и данные сайтов",
        "Cookies and other site data": "Cookie и другие данные сайтов",
        "Clear cookies and site data": "Очистить cookie и данные сайтов",
        "Clear Browsing Data": "Очистить данные браузера",
        "Clear Browsing Data?": "Очистить данные браузера?",
        "No sites have cookies in the built-in browser.": "Во встроенном браузере нет сохранённых cookie.",
        "Browser Subagent": "Браузерный субагент",
        "Enable Browser Agent": "Включить браузерного агента",
        "Let the agent open URLs, read web pages, and interact with browser content. This gives the agent access to important (and often critical) knowledge and methods of validation, but any browser integration does increase exposure to external malicious parties for security exploits.": "Разрешить агенту открывать URL, читать веб-страницы и взаимодействовать с контентом. Это расширяет возможности проверки, но увеличивает риски со стороны внешних сайтов.",
        "Browser Javascript Execution Policy": "Выполнение JavaScript в браузере",
        "Controls whether the agent can run custom JavaScript to automate complex browser actions.": "Разрешить агенту выполнять JavaScript для автоматизации браузера.",
        "Block all browser JavaScript execution.": "Запретить выполнение JavaScript в браузере.",
        "Prompt for approval before running browser scripts.": "Запрашивать подтверждение перед запуском скриптов.",
        "Allow full browser script execution without prompting.": "Разрешить выполнение скриптов без подтверждения.",
        "Browser Actuation Rules": "Правила браузерного агента",
        "Configure allowed and denied URLs for the browser subagent. It runs in the built-in browser, so no separate browser install is needed.": "Настройка разрешённых и запрещённых URL для браузерного субагента.",
        "Browser Actuation Permissions": "Разрешения управления браузером",
        "Allow/deny agent browser actuation access to specific URLs.": "Разрешить или запретить управление браузером на выбранных URL.",
        "Download Permissions": "Разрешения загрузок",
        "Download files": "Скачивание файлов",
        "Allow/deny agent browser file downloads from specific sites.": "Разрешить или запретить скачивание файлов с выбранных сайтов.",
        "Allowed Domains": "Разрешённые домены",
        "Denied Sites": "Запрещённые сайты",
        "Allowed Sites": "Разрешённые сайты",
        "Organization Allowed Domains (Read-Only)": "Разрешённые домены организации (только чтение)",
        "Browser Context Menu": "Контекстное меню браузера",
        "Custom JavaScript": "Пользовательский JavaScript",
        "Downloads": "Загрузки",
        "Show in folder": "Показать в папке",
        "Cancel download": "Отменить загрузку",
        "Open in external browser": "Открыть во внешнем браузере",
        "Open in External Browser": "Открыть во внешнем браузере",
        "Open in new tab": "Открыть в новой вкладке",
        "Open in New Tab": "Открыть в новой вкладке",
        "Open in Tab": "Открыть во вкладке",
        "Open in Side Panel": "Открыть в боковой панели",
        "Open Link in New Tab": "Открыть ссылку в новой вкладке",
        "Open URL": "Открыть URL",
        "Web Preview": "Веб-просмотр",
        "Embedded web preview": "Встроенный веб-просмотр",
        "Launching the browser...": "Запуск браузера...",
        "No browser pages open": "Нет открытых страниц браузера",
        "Antigravity would like to use the browser.": "Antigravity запрашивает доступ к браузеру.",

        // Settings — Account
        "Account": "Аккаунт",
        "Profile": "Профиль",
        "Manage your plan, credentials, and general preferences.": "Управление тарифом, аккаунтом и общими параметрами.",
        "Email": "Почта",
        "App version": "Версия приложения",
        "Version": "Версия",
        "Enable Telemetry": "Телеметрия",
        "Telemetry": "Телеметрия",
        "When toggled on, Antigravity collects usage data to help Google enhance performance and features.": "При включении Antigravity собирает данные об использовании для улучшения работы.",
        "Marketing Emails": "Рассылка новостей",
        "Receive product updates, tips, and promotions from Google Antigravity via email.": "Получать новости, советы и предложения Google Antigravity по почте.",
        "Google One Referral": "Реферальная программа Google One",
        "Share your referral link with friends": "Поделиться реферальной ссылкой с друзьями",
        "Invite a Friend": "Пригласить друга",
        "Sign in": "Войти",
        "Sign In": "Войти",
        "Sign in again": "Войти снова",
        "Sign out": "Выйти",
        "Sign Out": "Выйти",
        "Signing Out...": "Выход...",
        "Log out": "Выйти",
        "Log Out": "Выйти",
        "Not Signed In": "Вы не вошли",
        "Switch Account": "Сменить аккаунт",
        "Continue with different account": "Войти под другим аккаунтом",
        "Authentication Required": "Требуется авторизация",
        "Access restricted": "Доступ ограничен",
        "Settings Unavailable": "Настройки недоступны",
        "Project ID:": "ID проекта:",
        "Select Project": "Выбрать проект",
        "Project Required": "Требуется проект",
        "License Required": "Требуется лицензия",
        "Manage License": "Управление лицензией",
        "Managed by Enterprise Gateway": "Управляется Enterprise Gateway",
        "Danger Zone": "Опасная зона",
        "Remote Agents Data": "Данные удалённых агентов",
        "Delete All Data": "Удалить все данные",
        "Delete All Remote Agents Data": "Удалить данные удалённых агентов",
        "Delete All Remote Agents Data?": "Удалить все данные удалённых агентов?",
        "Permanently delete your remote conversations, projects, scheduled tasks, connected plugins and settings. Data in the desktop app and your Google account are not affected.": "Безвозвратно удалить удалённые диалоги, проекты, задачи, плагины и настройки. Локальные данные и аккаунт Google не затронуты.",
        "Remote agents are busy": "Удалённые агенты заняты",
        "By using this app, you agree to its": "Используя это приложение, вы принимаете",
        "Legal Help": "Правовая помощь",

        // Customizations, MCP, Plugins, Hooks, Developer
        "Default Customizations": "Стандартная кастомизация",
        "Include default customizations, such as default skills.": "Включить стандартные кастомизации и навыки.",
        "When enabled, the agent will include default customizations, including default skills.": "Если включено, агент использует стандартные кастомизации и навыки.",
        "Customize Global Skills": "Настроить глобальные навыки",
        "Custom Agents": "Пользовательские агенты",
        "Skills": "Навыки",
        "Global Skills": "Глобальные навыки",
        "Workspace Skills": "Навыки проекта",
        "Rules": "Правила",
        "Global Rules": "Глобальные правила",
        "Workspace Rules": "Правила проекта",
        "Workflows": "Сценарии",
        "Plugins": "Плагины",
        "Installed Plugins": "Установленные плагины",
        "Available Plugins": "Доступные плагины",
        "Manage Plugins": "Управление плагинами",
        "No Plugins Available": "Нет доступных плагинов",
        "Build With Google Plugins": "Плагины Google",
        "Browse and enable plugins from the Build With Google catalog.": "Просмотр и подключение плагинов из каталога Google.",
        "Loading plugins...": "Загрузка плагинов...",
        "MCP Servers": "MCP-серверы",
        "Installed MCP Servers": "Установленные MCP-серверы",
        "Add MCP Servers": "Добавить MCP-серверы",
        "Add MCP Server": "Добавить MCP-сервер",
        "Refresh MCP servers": "Обновить MCP-серверы",
        "MCP Servers Disabled": "MCP-серверы отключены",
        "Loading MCP servers...": "Загрузка MCP-серверов...",
        "Authenticate": "Авторизоваться",
        "Paste auth code": "Вставить код",
        "Delete server": "Удалить сервер",
        "Deleting...": "Удаление...",
        "Downloading...": "Загрузка...",
        "Installing": "Установка",
        "Click to enable tool": "Нажмите, чтобы включить инструмент",
        "Click to disable tool": "Нажмите, чтобы отключить инструмент",
        "Blocked by organization policy": "Заблокировано политикой организации",
        "Hooks": "Хуки",
        "Manage Hooks": "Управление хуками",
        "Agent Hooks Configuration": "Настройка хуков агента",
        "Configure hooks that run on agent lifecycle events.": "Настройка хуков для событий жизненного цикла агента.",
        "Add Handler": "Добавить обработчик",
        "Add Hook Card": "Добавить хук",
        "Delete Handler": "Удалить обработчик",
        "Delete Hook": "Удалить хук",
        "Developer": "Разработчик",
        "Developer Tools": "Инструменты разработчика",
        "Developer-only tools. These settings do not affect other users.": "Инструменты разработчика.",
        "Advanced Settings": "Расширенные настройки",
        "Feature Flags": "Флаги функций",
        "Custom Flags": "Пользовательские флаги",
        "Experiments": "Эксперименты",
        "Experimental": "Экспериментальные",
        "Labs": "Эксперименты",
        "Advanced": "Дополнительно",
        "Best of N": "Best-of-N",
        "Environments": "Окружения",

        // Conversation Actions & General UI Buttons
        "History": "История",
        "Files": "Файлы",
        "Agents": "Агенты",
        "Subagents": "Субагенты",
        "Tasks": "Задачи",
        "Background Tasks": "Фоновые задачи",
        "Background tasks and terminals agents left running, across all conversations.": "Фоновые задачи и терминалы во всех диалогах.",
        "Artifacts": "Артефакты",
        "Changes": "Изменения",
        "Diff": "Дифф",
        "Overview": "Обзор",
        "Swarm": "Рой агентов",
        "What would you like to work on?": "Над чем поработаем?",
        "What would you like to work on today?": "Над чем поработаем сегодня?",
        "What should we work on?": "Над чем поработаем?",
        "What would you like to build?": "Что будем создавать?",
        "What would you like to build today?": "Что будем создавать сегодня?",
        "What can I help you with?": "Чем я могу помочь?",
        "What can I help you with today?": "Чем я могу помочь сегодня?",
        "How can I help you today?": "Чем я могу помочь сегодня?",
        "How can I help you?": "Чем я могу помочь?",
        "How can I help?": "Чем я могу помочь?",
        "Where should we pick up?": "На чём мы остановились?",
        "Where would you like to pick up?": "На чём продолжим?",
        "Pick up where you left off": "Продолжить с того же места",
        "Build me a web app": "Создай для меня веб-приложение",
        "Add a Gemini feature to my app": "Добавь функцию Gemini в моё приложение",
        "Bring over my setup from other Agentic Developer Tools": "Перенести настройки из других ИИ-инструментов разработки",
        "Start a new conversation": "Начать новый диалог",
        "Start a conversation": "Начать диалог",
        "Ask anything": "Спросите что угодно",
        "Try asking": "Попробуйте спросить",
        "Suggestions": "Предложения",
        "Suggested": "Рекомендуемое",
        "Templates": "Шаблоны",
        "Rename": "Переименовать",
        "Rename Conversation": "Переименовать диалог",
        "Rename This Conversation": "Переименовать диалог",
        "Edit Conversation Title": "Изменить название диалога",
        "Maximize Pane": "Развернуть панель",
        "Restore Pane": "Восстановить панель",
        "Minimize Pane": "Свернуть панель",
        "Close Pane": "Закрыть панель",
        "Open Side Panel": "Открыть боковую панель",
        "Close Side Panel": "Закрыть боковую панель",
        "Archive Conversation": "Архивировать диалог",
        "Archive This Conversation": "Архивировать диалог",
        "Unarchive": "Извлечь из архива",
        "Pin": "Закрепить",
        "Unpin": "Открепить",
        "Pin / Unpin Conversation": "Закрепить / открепить диалог",
        "Pin Conversation": "Закрепить диалог",
        "Unpin Conversation": "Открепить диалог",
        "Pin This Conversation": "Закрепить диалог",
        "Unpin This Conversation": "Открепить диалог",
        "Delete Conversation": "Удалить диалог",
        "Delete This Conversation": "Удалить диалог",
        "More actions": "Другие действия",
        "More Actions": "Другие действия",
        "Duplicate": "Дублировать",
        "Delete": "Удалить",
        "Remove": "Убрать",
        "Remove from list": "Убрать из списка",
        "Remove from Group": "Убрать из группы",
        "Move to New Group": "В новую группу",
        "Mark All as Read": "Отметить всё прочитанным",
        "Mark Read": "Отметить прочитанным",
        "Mark Unread": "Отметить непрочитанным",
        "Mark This Conversation as Read": "Отметить прочитанным",
        "Mark This Conversation as Unread": "Отметить непрочитанным",
        "Copy Conversation Markdown": "Копировать диалог (Markdown)",
        "Copy Conversation ID": "Копировать ID диалога",
        "Copy Trajectory ID": "Копировать ID траектории",
        "Conversation Name": "Название диалога",
        "Conversation ID": "ID диалога",
        "Workspace Name": "Имя рабочей области",
        "Worktree Name": "Имя Worktree",
        "Project Name": "Название проекта",
        "Split": "Разделить",
        "Split Right": "Разделить вправо",
        "Split Down": "Разделить вниз",
        "Replace with New": "Заменить новым",
        "Remove from Split": "Убрать из разделения",
        "Fork": "Форк",
        "Restore": "Восстановить",
        "Delete Permanently": "Удалить навсегда",
        "View Debug": "Отладка",
        "Find in Conversation": "Поиск в диалоге",
        "Jump to Previous Prompt": "К предыдущему запросу",
        "Jump to Next Prompt": "К следующему запросу",
        "Split Conversation Vertically": "Разделить вертикально",
        "Split Conversation Horizontally": "Разделить горизонтально",
        "Equalize Split Panes": "Выровнять панели",
        "Split Terminal": "Разделить терминал",
        "New Terminal Tab": "Новая вкладка терминала",
        "Close Tab": "Закрыть вкладку",
        "Reopen Closed Tab": "Открыть закрытую вкладку",
        "Focus Input": "Фокус на ввод",
        "Find in Pane": "Найти на панели",
        "Go Back": "Назад",
        "Go Forward": "Вперёд",
        "Select All": "Выделить всё",
        "Export": "Экспорт",
        "Import": "Импорт",
        "Share": "Поделиться",
        "More": "Ещё",
        "More options": "Ещё параметры",
        "Actions": "Действия",
        "Send": "Отправить",
        "Stop": "Стоп",
        "Stop all": "Остановить все",
        "Stop agent": "Остановить агента",
        "Cancel": "Отмена",
        "Cancel Generation": "Остановить генерацию",
        "Planning": "Планирование",
        "Fast": "Быстрый",
        "Turbo": "Турбо",
        "Auto": "Авто",
        "Manual": "Вручную",
        "Custom": "Свой",
        "Default": "По умолчанию",
        "Recommended": "Рекомендуется",
        "Thinking": "Размышление",
        "Thinking...": "Думает...",
        "Working...": "Работает...",
        "Generating...": "Генерирует...",
        "Loading...": "Загрузка...",
        "Loading media...": "Загрузка медиа...",
        "Loading resources...": "Загрузка ресурсов...",
        "Loading token usage...": "Загрузка статистики токенов...",
        "Loading workspace customizations...": "Загрузка кастомизаций...",
        "Connecting to language server...": "Подключение к серверу...",
        "Submitting...": "Отправка...",
        "Connecting...": "Подключение...",
        "Saving...": "Сохранение...",
        "Voice Mode": "Голосовой режим",
        "Voice mode": "Голосовой режим",
        "Live Voice": "Голосовой чат",
        "Live chat": "Голосовой чат",
        "Start Voice mode": "Голосовой режим",
        "End Voice mode": "Завершить голосовой режим",
        "Start Live Chat": "Начать голосовой чат",
        "End Live chat": "Завершить голосовой чат",
        "Voice Speed": "Скорость голоса",
        "Record Audio": "Запись аудио",
        "Stop Recording": "Остановить запись",
        "Stop Recording and Send": "Остановить и отправить",
        "Recording": "Запись...",
        "Send Message": "Отправить сообщение",
        "Queue Message": "В очередь",
        "Voice recording is unavailable while the Chief of Staff mic is on": "Запись аудио недоступна, пока включён голосовой микрофон",
        "Powered by Gemini Live ·": "На базе Gemini Live ·",
        "You can change this in": "Изменить можно в",
        "Start Voice Recording": "Начать запись голоса",
        "Stop Voice Recording": "Остановить запись",
        "Toggle Voice Recording": "Голосовой ввод",
        "Mute Voice Mic": "Выключить микрофон",
        "Mute Voice Speaker": "Выключить звук",

        // Agent Process & Trajectory Steps
        "Working": "Работает",
        "Exploring": "Изучение",
        "Explored": "Изучено",
        "Running": "Выполняется",
        "Running command": "Выполняется команда",
        "Analyzed": "Изучено",
        "Analyzing": "Изучение",
        "Analyzed Task Log": "Изучен журнал задач",
        "Analyzing Task Log": "Изучение журнала задач",
        "Ran": "Выполнено",
        "Edited": "Изменено",
        "Editing": "Изменение",
        "Editing file": "Редактирование файла",
        "Editing files": "Редактирование файлов",
        "Editing artifact": "Редактирование артефакта",
        "Editing artifacts": "Редактирование артефактов",
        "Failed to edit": "Ошибка правки",
        "Searched": "Поиск выполнен",
        "Searching": "Поиск",
        "Executed": "Выполнено",
        "Executing": "Выполнение",
        "Failed to execute": "Ошибка выполнения",
        "Read": "Прочитано",
        "Reading": "Чтение",
        "Failed to read": "Ошибка чтения",
        "Read page": "Страница прочитана",
        "Reading page": "Чтение страницы",
        "Created outline": "Создана структура",
        "Asked": "Задан вопрос",
        "Asking": "Задаёт вопрос",
        "Scrolled": "Прокручено",
        "Rejected": "Отклонено",
        "Canceled": "Отменено",
        "Interrupted": "Прервано",
        "Completed": "Завершено",
        "Invalid tool call": "Некорректный вызов инструмента",
        "Error while editing": "Ошибка при редактировании",
        "Error editing file": "Ошибка редактирования файла",
        "Error while viewing": "Ошибка при просмотре",
        "Error viewing file": "Ошибка просмотра файла",
        "Error while editing notebook": "Ошибка при редактировании блокнота",
        "Error editing notebook": "Ошибка редактирования блокнота",
        "Error while reading notebook": "Ошибка при чтении блокнота",
        "Error reading notebook": "Ошибка чтения блокнота",
        "Unknown file edit": "Неизвестное изменение файла",
        "Permissions": "Разрешения",
        "permissions": "разрешения",
        "Change local permissions": "Изменить локальные разрешения",
        "Change permissions": "Изменить разрешения",
        "Edit permissions": "Изменить разрешения",
        "Manage permissions": "Управление разрешениями",
        "Ask every time": "Спрашивать каждый раз",
        "Ask Every Time": "Спрашивать каждый раз",
        "Ask before running": "Спрашивать перед запуском",
        "Ask for approval": "Запрашивать одобрение",
        "Ask": "Спрашивать",
        "Auto-approve": "Авто-одобрение",
        "Auto Approve": "Авто-одобрение",
        "Auto-run": "Автозапуск",
        "Auto Run": "Автозапуск",
        "Full Access": "Полный доступ",
        "Full access": "Полный доступ",
        "Restricted": "Ограниченный",
        "Strict": "Строгий",
        "Balanced": "Сбалансированный",
        "Permissive": "Свободный",
        "Sandbox": "Песочница",
        "Sandboxed": "В песочнице",
        "Read-only": "Только чтение",
        "Read Only": "Только чтение",
        "Read & Write": "Чтение и запись",
        "Context": "Контекст",
        "Add context": "Добавить контекст",
        "Add Context": "Добавить контекст",
        "Folder": "Папка",
        "Mentions": "Упоминания",
        "Browse": "Обзор",
        "Browse rules": "Просмотр правил",
        "Sign in to Google Drive": "Войти в Google Диск",
        "Log in": "Войти",
        "Log In": "Войти",
        "Attach": "Прикрепить",
        "Attach file": "Прикрепить файл",
        "Attach files": "Прикрепить файлы",
        "Attach image": "Прикрепить изображение",
        "Upload": "Загрузить",
        "Upload Files": "Загрузить файлы",
        "Low": "Низкий",
        "Medium": "Средний",
        "High": "Высокий",
        "Max": "Макс",
        "Minimal": "Минимум",
        "Off": "Выкл",
        "On": "Вкл",
        "Enabled": "Включено",
        "Disabled": "Выключено",
        "Active": "Активно",
        "Inactive": "Неактивно",
        "Available": "Доступно",
        "Unavailable": "Недоступно",
        "Environment": "Окружение",
        "Local": "Локально",
        "Accept": "Принять",
        "Accept Step": "Принять шаг",
        "Accept All": "Принять всё",
        "Reject": "Отклонить",
        "Reject Step": "Отклонить шаг",
        "Reject All": "Отклонить всё",
        "Approve": "Одобрить",
        "Allow": "Разрешить",
        "Allow Once": "Разрешить один раз",
        "Allow once": "Разрешить один раз",
        "Always Allow": "Всегда разрешать",
        "Always allow": "Всегда разрешать",
        "Allow for session": "Разрешить на сессию",
        "Allow for workspace": "Разрешить для проекта",
        "Deny": "Запретить",
        "Always Deny": "Всегда запрещать",
        "Decline": "Отклонить",
        "Proceed": "Продолжить",
        "Continue": "Продолжить",
        "Run": "Запустить",
        "Run command": "Выполнить команду",
        "Retry": "Повторить",
        "Try again": "Повторить",
        "Regenerate": "Повторить ответ",
        "Copy": "Копировать",
        "Copied": "Скопировано",
        "Copied!": "Скопировано!",
        "Copy Link": "Копировать ссылку",
        "Copy Image": "Копировать изображение",
        "Copy Path": "Копировать путь",
        "Cut": "Вырезать",
        "Paste": "Вставить",
        "Edit": "Изменить",
        "Quote": "Цитировать",
        "Quote Selection": "Цитировать выделение",
        "Side Question Selection": "Вопрос по выделению",
        "Comment": "Комментировать",
        "Comment on Selection": "Комментировать выделение",
        "Comments": "Комментарии",
        "Add to Chat": "Добавить в чат",
        "Add to Chat/Quote": "Добавить в чат / цитату",
        "Add inline comment": "Добавить комментарий",
        "Review": "Проверка",
        "For Turn": "За ход",
        "Open Diff": "Открыть дифф",
        "View Split Diff": "Раздельный дифф",
        "View Unified Diff": "Единый дифф",
        "View Inline Diff": "Встроенный дифф",
        "Split Diff": "Раздельный дифф",
        "Unified Diff": "Единый дифф",
        "Hide Whitespace Changes": "Скрыть изменения пробелов",
        "Show Whitespace Changes": "Показать изменения пробелов",
        "Collapse All": "Свернуть все",
        "Expand All": "Развернуть все",
        "No Results": "Нет результатов",
        "No results": "Нет результатов",
        "Match Whole Word": "Слово целиком",
        "Match Case": "Учитывать регистр",
        "Use Regular Expression": "Регулярное выражение",
        "Previous Match": "Предыдущее совпадение",
        "Next Match": "Следующее совпадение",
        "Not included with your current plan.": "Не входит в ваш текущий тариф.",
        "Create": "Создать",
        "Add": "Добавить",
        "Apply": "Применить",
        "Confirm": "Подтвердить",
        "Done": "Готово",
        "Finish": "Завершить",
        "Next": "Далее",
        "Previous": "Назад",
        "Modified": "Изменено",
        "Deleted": "Удалено",
        "Renamed": "Переименовано",
        "New": "Новое",
        "Save": "Сохранить",
        "Save Changes": "Сохранить изменения",
        "Saved": "Сохранено",
        "Discard": "Отменить",
        "Open": "Открыть",
        "Open In": "Открыть в",
        "Change": "Изменить",
        "Reset": "Сбросить",
        "Reset to defaults": "Сбросить по умолчанию",
        "Reset to Defaults": "Сбросить по умолчанию",
        "Clear": "Очистить",
        "Clear all": "Очистить всё",
        "Clear All": "Очистить всё",
        "Refresh": "Обновить",
        "Reload": "Перезагрузить",
        "Restart": "Перезапустить",
        "Back": "Назад",
        "Forward": "Вперёд",
        "Skip": "Пропустить",
        "Got it": "Понятно",
        "Dismiss": "Скрыть",
        "Learn more": "Подробнее",
        "Learn More": "Подробнее",
        "Documentation": "Документация",
        "Help": "Помощь",
        "About": "О приложении",
        "Preview": "Предпросмотр",
        "Options": "Параметры",
        "Details": "Подробности",
        "Status": "Статус",
        "Source:": "Источник:",
        "Title:": "Название:",
        "Prompt": "Промпт",
        "Goal": "Цель",
        "Sources": "Источники",
        "Page contents": "Содержимое страницы",
        "Tool arguments": "Аргументы инструмента",
        "Tool Output": "Вывод инструмента",
        "Full output written to": "Полный вывод записан в",
        "Confirmation required to execute this step": "Требуется подтверждение для выполнения этого шага",
        "Resolving permissions...": "Проверка разрешений...",
        "Artifact updated by agent": "Артефакт обновлён агентом",
        "Files to edit:": "Файлы для изменения:",
        "Found references to": "Найдены ссылки на",
        "User Intent": "Намерение пользователя",
        "Code Change Summary": "Сводка изменений кода",
        "Knowledge Generation": "Генерация знаний",
        "Trajectory Stats": "Статистика траектории",
        "Click to view more": "Нажмите, чтобы раскрыть",
        "Input:": "Вход:",
        "Output:": "Выход:",
        "Cache:": "Кэш:",
        "Terminal": "Терминал",
        "Terminals": "Терминалы",
        "Terminal Commands": "Команды терминала",
        "Terminal Sandbox": "Песочница терминала",
        "Shell Setup Script": "Скрипт инициализации оболочки",
        "Commands Outside Sandbox": "Команды вне песочницы",
        "Tool Permissions": "Разрешения инструментов",
        "File Permissions": "Доступ к файлам",
        "File Read": "Чтение файлов",
        "File Write": "Запись файлов",
        "Network Permissions": "Сетевой доступ",
        "Network Access": "Сетевой доступ",
        "MCP Tools": "Инструменты MCP",
        "Terminal & Tooling Permissions": "Разрешения терминала и инструментов",
        "Audio Input": "Аудиовход",
        "Input Device": "Устройство ввода",
        "Output Device": "Устройство вывода",
        "Audio": "Аудио",
        "Speech": "Речь",
        "Voice & Audio": "Голос и звук",
        "Launch at Login": "Запускать при входе в систему",
        "Startup": "Запуск",
        "Accessibility": "Спецвозможности",
        "Privacy": "Конфиденциальность",
        "Privacy & Security": "Конфиденциальность и безопасность",
        "Security": "Безопасность",
        "Data & Privacy": "Данные и конфиденциальность",
        "Release Notes": "Что нового",
        "Token Usage": "Использование токенов",
        "Context usage": "Использование контекста",
        "Context Window": "Контекстное окно",
        "No token data available.": "Нет данных о токенах.",
        "There are no customizations enabled.": "Нет активных кастомизаций.",
        "Connections": "Подключения",
        "Connectors": "Коннекторы",
        "Integrations": "Интеграции",
        "Remote": "Удалённо",
        "Remote Hosts": "Удалённые хосты",
        "Connect": "Подключить",
        "Disconnect": "Отключить",
        "Connected": "Подключено",
        "Disconnected": "Отключено",
        "Not connected": "Не подключено",
        "Installed": "Установлено",
        "Needs re-auth": "Нужен повторный вход",
        "No sign-in needed": "Вход не требуется",
        "Enable": "Включить",
        "Disable": "Выключить",
        "Install": "Установить",
        "Uninstall": "Удалить",
        "Update": "Обновить",
        "Feedback": "Обратная связь",
        "Feedback Type": "Тип отзыва",
        "Description": "Описание",
        "Steps to Reproduce": "Шаги воспроизведения",
        "Attach a screenshot (optional)": "Прикрепить скриншот (необязательно)",
        "Attach Antigravity server logs": "Прикрепить логи сервера Antigravity",
        "Download Diagnostics": "Скачать диагностику",
        "Diagnostics": "Диагностика",
        "Logs": "Журналы",
        "Open Logs": "Открыть журналы",
        "Bottom": "Снизу",
        "Right": "Справа",
        "Left": "Слева",
        "Center": "По центру",
        "Top": "Сверху",
        "Always": "Всегда",
        "Never": "Никогда",
        "Automatic": "Автоматически",
        "Language": "Язык",
        "Configure workspace-specific permissions, resources, and customizations.": "Настройки разрешений и ресурсов рабочей области.",
        "Controls the actions the agent can take.": "Управление разрешёнными действиями агента.",
        "Allow/deny agent read access to specific files or directories.": "Доступ агента на чтение файлов и папок.",
        "Allow/deny agent write access to specific files or directories.": "Доступ агента на запись файлов и папок.",
        "Allow/deny agent read access to specific URLs or domains.": "Доступ агента к указанным URL и доменам.",
        "Allow/deny specific terminal commands.": "Разрешённые и запрещённые команды терминала.",
        "Allow/deny agent command execution outside the sandbox.": "Выполнение команд агента вне песочницы.",
        "External tools the agent can call via Model Context Protocol.": "Внешние инструменты через протокол MCP.",
        "Configure allowed and denied paths for file reads and writes.": "Настройка разрешённых путей чтения и записи.",
        "Configure allowed and denied URLs for reading.": "Настройка разрешённых URL для чтения.",
        "Configure allowed terminal commands.": "Настройка разрешённых команд терминала.",
        "Configure allowed commands outside the sandbox.": "Настройка команд вне песочницы.",
        "Configure external tools via Model Context Protocol.": "Настройка внешних MCP-инструментов.",
        "Only stored on your machine.": "Хранится только на этом компьютере.",
        "Folders these agents can access.": "Папки, к которым есть доступ у агентов.",
        "Run in your current workspace": "Запустить в текущей рабочей области",
        "Run in a new worktree": "Запустить в новой ветке (worktree)",
        "No matching results": "Ничего не найдено",
        "No matching resources found.": "Подходящие ресурсы не найдены.",
        "No matching flags": "Флаги не найдены",
        "Nothing is running right now": "Сейчас ничего не запущено",
        "No background tasks": "Нет фоновых задач",
        "No subagents": "Нет субагентов",
        "No active terminals": "Нет активных терминалов",
        "Empty directory": "Пустая папка",
        "Empty log": "Журнал пуст",
        "No workspaces open.": "Нет открытых рабочих областей.",
        "No description available.": "Описание отсутствует.",
        "Needs attention": "Требует внимания",
        "Blocked, needs input": "Ожидает ввода",
        "Task not found": "Задача не найдена",
        "Not scheduled": "Не запланировано",
        "Hourly": "Каждый час",
        "Daily": "Ежедневно",
        "Weekdays": "По будням",
        "Weekly": "Еженедельно",
        "Something went wrong!": "Что-то пошло не так!",
        "Not Found": "Не найдено",
        "Not available": "Недоступно",
        "Preview unavailable": "Предпросмотр недоступен",
        "Path copied!": "Путь скопирован!",
        "Get started": "Начать",
        "Quick Start": "Быстрый старт",
        "Tip:": "Совет:",
        "Nothing said yet": "Пока нет сообщений",
        "Today": "Сегодня",
        "Yesterday": "Вчера",
        "Just now": "Только что",
        "This week": "На этой неделе",
        "Last week": "На прошлой неделе",
        "Older": "Ранее",
        "Members": "Участники",
        "Owner": "Владелец",
        "Author": "Автор",
        "Branch": "Ветка",
        "Sent": "Отправлено",
        "Agent": "Агент",
        "Seek": "Перемотка",
        "Standalone": "Автономный",
        "Link Settings": "Настройки ссылок",
        "Listening. Ask anything.": "Слушаю. Спросите что угодно.",
        "Voice speed": "Скорость голоса",
        "Mute mic": "Выключить микрофон",
        "Unmute mic": "Включить микрофон",
        "Bug Report": "Отчёт об ошибке",
        "Feature Request": "Запрос функции",
        "Auth and Billing": "Авторизация и оплата",
        "Remote Control Issue": "Проблема с удалённым управлением",
        "General Feedback": "Общий отзыв",
        "Please describe the issue in detail. The more actionable your feedback, the quicker our team can address your request. Some helpful information includes:": "Опишите проблему подробно. Чем конкретнее отзыв, тем быстрее команда сможет помочь. Полезно указать:",
        "Steps to reproduce the issue": "Шаги для воспроизведения",
        "Expected behavior": "Ожидаемое поведение",
        "Actual behavior": "Фактическое поведение",
        "Any error messages": "Тексты ошибок",
        "Any relevant information": "Любая дополнительная информация",
        "Settings for conversations outside of projects.": "Настройки диалогов вне проектов.",
        "The breakdown below shows token usage from customizations like rules, skills, and MCP. If a budget is exceeded, large rules are demoted to path pointers and large customizations are excluded automatically.": "Ниже показано распределение токенов по кастомизациям (правила, навыки, MCP). При превышении бюджета крупные правила заменяются ссылками, а лишние кастомизации временно исключаются.",
        "Manage project folders and settings.": "Управление папками и настройками проекта.",
        "Manage project folders, agent settings, and permissions.": "Управление папками проекта, настройками агента и разрешениями.",
        "Folders": "Папки",
        "Add Folder": "Добавить папку",
        "No folders added yet.": "Папки ещё не добавлены.",
        "Other Customizations": "Прочие кастомизации",
        "Inherit Global": "Наследовать глобальные",
        "Global": "Глобальный",
        "Also includes": "Также включает",
        "when working in this project.": "при работе в этом проекте.",
        "to ask for content changes for legal reasons.": "чтобы запросить изменение контента по юридическим причинам.",
        "(single edit)": "(одна правка)",
        "Viewing Diff": "Просмотр изменений",
        "Side Question": "Побочный вопрос",
        "Controls permissions for remote conversations.": "Управление разрешениями для удалённых диалогов.",
        "Confirm Undo": "Подтвердить отмену",
        "This undo action will not make any code changes.": "Эта отмена не изменит код.",
        "Confirming this undo action will make the following changes:": "Подтверждение отмены внесёт следующие изменения:",
        "Revert file changes": "Откатить изменения файлов",
        "Undo to this point": "Откатить до этого момента",
        "Extra High": "Максимальный",
        "Good Response": "Хороший ответ",
        "Bad Response": "Плохой ответ",
        "Run Now": "Запустить сейчас",
        "Create with Prompt": "Создать промптом",
        "Scheduled": "Запланировано",
        "Next run": "Следующий запуск",
        "Last run": "Последний запуск",
        "Paused": "На паузе",
        "Featured": "Рекомендуемое",
        "Connect to Google Workspace, including Docs, Sheets, Slides, Drive, Calendar, and Gmail.": "Подключение к Google Workspace: Документы, Таблицы, Презентации, Диск, Календарь и Gmail.",
        "Build with Google": "Разработка с Google",
        "Build on Google's developer platforms, including Android, Chrome, Gemini, and Google Cloud.": "Платформы Google для разработчиков: Android, Chrome, Gemini и Google Cloud.",
        "Design, Creative & Media": "Дизайн, креатив и медиа",
        "Design, creative, and media tools.": "Инструменты для дизайна, творчества и медиа.",
        "Agent skills, databases, and interactive viewers for scientific research.": "Навыки агента, базы данных и визуализаторы для научных исследований.",
        "Productivity & Project Management": "Продуктивность и управление проектами",
        "Plan work, track issues, sign documents, and manage your notes and files.": "Планирование работы, трекинг задач, подписание документов и управление файлами.",
        "Cloud Hosting & Deployment": "Облачный хостинг и деплой",
        "Deploy and host your apps, sites, and their backends.": "Развёртывание и хостинг приложений, сайтов и бэкендов.",
        "Developer Tools": "Инструменты разработчика",
        "APIs, services, and tools to build, test, secure, and run your apps.": "API, сервисы и инструменты для создания, тестирования и запуска приложений.",
        "Business": "Бизнес",
        "Payments, CRM, accounting, data, identity, customer support, marketing, and workflow automation.": "Платежи, CRM, учёт, данные, поддержка клиентов, маркетинг и автоматизация.",
        "More Plugins": "Другие плагины",
        "Explore other marketplace customizations": "Другие расширения из маркетплейса",
        "Google does not control the availability or functionality of third party developer tools. Your data from third party developer tools connected to your Antigravity instance may be shared with Google. Google will protect any such data in accordance with the Google Privacy Policy, found here:": "Google не контролирует доступность и работу сторонних инструментов разработчиков. Данные из подключённых сторонних инструментов могут передаваться в Google и защищаются в соответствии с Политикой конфиденциальности Google:",
        // Search & Input Prompts
        "What should it do?": "Что нужно сделать?",
        "Optional branch or ref used when creating a new Cog workspace (defaults to main if unset).": "Необязательная ветка или ref для нового Cog-воркспейса (по умолчанию main).",

        // Window, Tabs & Navigation
        "Zoom out (-)": "Уменьшить (-)",
        "Zoom in (+)": "Увеличить (+)",
        "Open Image in New Tab": "Открыть изображение в новой вкладке",
        "Close Tabs to the Left": "Закрыть вкладки слева",
        "Close Tabs to the Right": "Закрыть вкладки справа",
        "Zoom": "Масштаб",
        "Reset zoom (0)": "Сбросить масштаб (0)",

        // Git & VCS Panel
        "Sample GDoc": "Пример Google Документа",
        "Copy Image Address": "Копировать адрес изображения",
        "Default Cog repository": "Cog-репозиторий по умолчанию",
        "Default Cog branch / ref": "Ветка/ref Cog по умолчанию",
        "Use full VCS clones for Best of N": "Использовать полные клоны VCS для Best-of-N",
        "Use full Git clones for Best of N": "Использовать полные Git-клоны для Best-of-N",
        "Output": "Вывод",
        "Errors": "Ошибки",
        "Fork in Shared Workspace": "Форк в общей рабочей области",
        "Fork in New Workspace": "Форк в новой рабочей области",
        "Repository": "Репозиторий",
        "New Group": "Новая группа",
        "Text Selection": "Выделенный текст",
        "Connect GitHub": "Подключить GitHub",
        "Pull Requests": "Пулл-реквесты",
        "Include unstaged changes": "Включить неиндексированные изменения",
        "Commit": "Коммит",
        "Amend": "Дополнить коммит (Amend)",
        "Push": "Отправить (Push)",
        "Uncommitted": "Не закоммичено",
        "Connected Google Drive and GitHub resources": "Подключённые ресурсы Google Диска и GitHub",
        "Amend succeeded": "Коммит успешно дополнен",
        "Added (Staged)": "Добавлено (индексировано)",
        "Untracked (Unstaged)": "Неотслеживаемое (неиндексировано)",
        "Recent Files": "Недавние файлы",
        "Coordinators": "Координаторы",
        "Staged Changes": "Индексированные изменения",
        "Branch Changes": "Изменения ветки",
        "Added": "Добавлено",
        "Untracked": "Не отслеживается",
        "GitHub Personal Access Token": "Персональный токен доступа GitHub (PAT)",
        "GitHub Policies": "Политики GitHub",
        "GitHub Permissions": "Разрешения GitHub",
        "Failed to Generate Commit Message": "Не удалось сгенерировать сообщение коммита",
        "Commit succeeded": "Коммит успешно создан",
        "Failed to Commit": "Не удалось закоммитить",
        "Failed to Amend": "Не удалось дополнить коммит",
        "Push succeeded": "Отправка (push) успешна",
        "Failed to Push": "Не удалось отправить (push)",
        "Export as PDF": "Экспортировать в PDF",
        "Open in Notebook View": "Открыть в виде блокнота",
        "Download": "Скачать",
        "Open Blame in Code Search": "Открыть Blame в Code Search",
        "Trajectory Debug View": "Отладка траектории",
        "Open on phone": "Открыть на телефоне",
        "Unstage change": "Убрать из индекса",
        "Stage change": "Индексировать изменение",
        "Discard unstaged changes": "Отменить неиндексированные изменения",
        "Configure GitHub access policies.": "Настроить политики доступа GitHub.",
        "Uploaded project files and in-chat attachments are stored on Google servers and mounted into your cloud sandbox so your agent can read and work with them.": "Загруженные файлы проекта и вложения чата сохраняются на серверах Google и подключаются в облачную песочницу для работы агента.",
        "Files, folders, and repositories you connect are accessible to your agent in this project, including during background or scheduled runs.": "Подключённые файлы, папки и репозитории доступны агенту в этом проекте, в том числе во время фоновых и запланированных запусков.",
        "Match when any modified file path starts with the given depot prefix.": "Сопоставлять, когда путь изменённого файла начинается с указанного префикса depot.",
        "Match when push_def equals or is a child of the given PushDef prefix.": "Сопоставлять, когда push_def совпадает или наследует указанный префикс PushDef.",
        "Manage fine-grained permissions for GitHub.": "Управление детальными разрешениями для GitHub.",

        // Workspaces & Environments
        "Default workspace VCS": "VCS рабочей области по умолчанию",
        "Sync JJ worktrees to head": "Синхронизировать JJ worktrees с HEAD",
        "Override feature environment": "Переопределить окружение функций",
        "Host Environment": "Окружение хоста",
        "Workspace URI query parameter": "Параметр запроса URI рабочей области",
        "CitC workspace type": "Тип воркспейса CitC",
        "Access grants": "Права доступа",
        "Manifest Changes": "Изменения манифеста",
        "CitC Workspace": "Рабочая область CitC",
        "Cog Workspace": "Рабочая область Cog",
        "ABFS Workspace (Alpha)": "Рабочая область ABFS (Alpha)",
        "Worktree": "Worktree",
        "CitC Clone": "Клон CitC",
        "Repo": "Репозиторий",
        "Idle": "Ожидание",
        "Open Folder (Interactive)": "Открыть папку (интерактивно)",
        "Current workspace": "Текущая рабочая область",
        "Archive Workspace": "Архивировать рабочую область",
        "Stored and mounted in your cloud environment": "Сохранено и подключено в вашем облачном окружении",
        "Files and resources in cloud workspaces": "Файлы и ресурсы в облачных рабочих областях",
        "Daily environment time used": "Использовано времени окружения за день",
        "Could not create Cog workspace": "Не удалось создать воркспейс Cog",
        "Workspace setup warning": "Предупреждение настройки рабочей области",
        "More cloud environments": "Другие облачные окружения",
        "Failed to create worktree": "Не удалось создать worktree",
        "Failed to create CitC clone workspace": "Не удалось создать клон воркспейса CitC",
        "Switch Roles": "Сменить роли",
        "VCS used when creating a new workspace, including workspaces generated based off your initial prompt.": "VCS для новых рабочих областей, включая области, созданные по вашему начальному запросу.",
        "When enabled, the values below replace the auto-detected OS, host, and user type used for feature gating.": "Если включено, значения ниже заменяют автоматически определённые ОС, хост и тип пользователя для проверки доступности функций.",
        "Simulate a different host (Electron, desktop or mobile Web, Extension, remote control, or installed PWA).": "Эмулировать другой хост (Electron, браузер, расширение, удалённое управление или PWA).",
        "Select the workspace type that will be used for new conversations started with the New Workspace option.": "Выберите тип рабочей области для новых диалогов, запускаемых с параметром «Новая рабочая область».",
        "Commands and files these agents can use.": "Команды и файлы, доступные этим агентам.",
        "Clone current workspace into a new independent workspace": "Клонировать текущую рабочую область в новую независимую область",

        // Security & Permissions
        "1. Accessibility": "1. Универсальный доступ",
        "2. Screen Recording": "2. Запись экрана",
        "Screen Recording": "Запись экрана",
        "View site information": "Сведения о сайте",
        "Attackers might be able to see the images you're looking at on this site and trick you by modifying them.": "Злоумышленники могут видеть просматриваемые изображения на этом сайте и подменять их.",
        "Controls whether terminal commands require your approval before running.": "Определяет, требуется ли ваше подтверждение перед запуском команд в терминале.",
        "Gemini 4 Carbon now available!": "Gemini 4 Carbon теперь доступна!",
        "Both Carbon and Argon are now included as part of the entire Gemini entitlement, so you can use them for much longer.": "И Carbon, и Argon теперь включены в общий лимит Gemini, поэтому вы сможете использовать их намного дольше.",
        "For your hardest, long-horizon tasks": "Для самых сложных и масштабных задач",
        "Are you sure you want to delete this conversation?": "Вы уверены, что хотите удалить этот диалог?",
        "This action cannot be undone.": "Это действие нельзя отменить.",
        "Runs on this machine": "Запускается на этом компьютере",
        "Open File": "Открыть файл",
        "Search or enter a URL": "Поиск или введите URL",
        "Model cannot be changed while the agent is running": "Нельзя сменить модель, пока агент работает",
        "Permissions cannot be changed while the agent is running": "Нельзя изменить разрешения, пока агент работает",
        "Restart to Update": "Перезапустить для обновления",
        "Restart to Update →": "Перезапустить для обновления →",
        "Restart to Update ->": "Перезапустить для обновления →",
        "Check for Updates": "Проверить обновления",
        "Checking for Updates": "Проверка обновлений",
        "Checking for Updates...": "Проверка обновлений...",
        "Downloading Update": "Загрузка обновления",
        "Downloading Update...": "Загрузка обновления...",
        "Update Available": "Доступно обновление",
        "Update Ready": "Обновление готово",
        "Install Update": "Установить обновление",
        "Installing Update...": "Установка обновления...",
        "Update Failed": "Ошибка обновления",
        "Retry Update": "Повторить обновление",
        "Up to Date": "Актуальная версия",
        "Raw": "Исходник",
        "Switch to RTL text direction": "Переключить направление текста (RTL)",
        "Switch to LTR text direction": "Переключить направление текста (LTR)",
        "View Diff": "Показать отличия",
        "Open in Antigravity IDE": "Открыть в Antigravity IDE",
        "Table options": "Параметры таблицы",
        "Copy as Markdown": "Копировать как Markdown",
        "Maximize Width": "Развернуть по ширине",
        "Stage and commit all changes": "Индексировать и закоммитить все изменения",
        "No commits to push": "Нет коммитов для отправки",
    };

    const EXACT_LOWER_RU = Object.create(null);
    for (const [k, v] of Object.entries(EXACT_RU)) {
        const low = k.toLowerCase();
        if (!(low in EXACT_LOWER_RU)) EXACT_LOWER_RU[low] = v;
    }

    const PLACEHOLDER_RU = [
        [/^Ask anything, @ to mention, \/ for actions$/i, "Спросите что угодно, @ — упоминания, / — команды"],
        [/^Ask anything/i, "Спросите что угодно, @ — упоминания, / — команды"],
        [/^Message subagent/i, "Напишите субагенту, @ — упоминания, / — команды"],
        [/^Message /i, "Написать сообщение..."],
        [/^Search shortcuts/i, "Поиск горячих клавиш..."],
        [/^Search conversations/i, "Поиск по диалогам..."],
        [/^Search for conversations/i, "Поиск по диалогам..."],
        [/^Search projects/i, "Поиск проектов..."],
        [/^Search customizations/i, "Поиск кастомизаций..."],
        [/^Search for commands/i, "Поиск команд..."],
        [/^Search settings/i, "Поиск настроек..."],
        [/^Search MCP servers/i, "Поиск MCP-серверов..."],
        [/^Search connectors/i, "Поиск коннекторов..."],
        [/^Search plugins/i, "Поиск плагинов..."],
        [/^Search branches/i, "Поиск веток..."],
        [/^Search sites/i, "Поиск сайтов..."],
        [/^Search flags/i, "Поиск флагов..."],
        [/^Search filters/i, "Поиск фильтров..."],
        [/^Search triggers/i, "Поиск триггеров..."],
        [/^Search file contents/i, "Поиск по содержимому файлов..."],
        [/^Search$/i, "Поиск"],
        [/^Find$/i, "Найти"],
        [/^Filter files/i, "Фильтр файлов..."],
        [/^Filter rows/i, "Фильтр строк..."],
        [/^Filter resources/i, "Фильтр ресурсов..."],
        [/^Conversation name$/i, "Название диалога"],
        [/^Group name$/i, "Название группы"],
        [/^Enter project name/i, "Введите название проекта..."],
        [/^Enter target/i, "Введите значение..."],
        [/^Tell the agent what to do instead/i, "Укажите агенту, что сделать вместо этого..."],
        [/^Write a comment/i, "Написать комментарий..."],
        [/^Leave a comment/i, "Оставить комментарий..."],
        [/^Enter a URL/i, "Введите URL (например, http://localhost:8080)"],
        [/^Enter tool name or server/i, "Введите имя инструмента или сервера..."],
        [/^Enter device name/i, "Введите имя устройства..."],
        [/^Paste authorization code/i, "Вставьте код авторизации"],
        [/^Enter authorization code/i, "Введите код авторизации..."],
        [/^What should the agent do on each run/i, "Что агент должен делать при каждом запуске?"],
        [/^Prompt to run when triggered/i, "Промпт для запуска по триггеру..."],
        [/^Please list the steps to reproduce/i, "Опишите шаги воспроизведения..."],
        [/^Describe the bug you encountered/i, "Опишите возникшую ошибку..."],
        [/^Untitled$/i, "Без названия"],
        // Search & Input Placeholders
        [/^Turn on a flag you don't have/i, "Включить недоступный флаг"],
        [/^Select or enter a workspace URI/i, "Выберите или введите URI рабочей области"],
        [/^New hook name/i, "Имя нового хука"],
        [/^Paste code/i, "Вставьте код"],
        [/^Type absolute path or navigate folders/i, "Введите абсолютный путь или перейдите по папкам..."],
        [/^\(Optional\) Tell us more or type your reason/i, "(Необязательно) Расскажите подробнее или укажите причину..."],
        [/^What should this coordinator accomplish/i, "Какую цель должен решить этот координатор?"],
        [/^For example: every morning, summarize new bugs/i, "Например: каждое утро собирать сводку назначенных мне багов и ночных изменений."],
        [/^For example: Morning bug summary/i, "Например: Утренняя сводка багов"],
        [/^Target text in PDF/i, "Искомый текст в PDF..."],
    ];

    function pluralRu(n, one, few, many) {
        const num = Math.abs(Number(n)) || 0;
        const m10 = num % 10;
        const m100 = num % 100;
        if (m10 === 1 && m100 !== 11) return one;
        if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
        return many;
    }

    function formatAttachmentCountRu(countStr, kindStr) {
        const n = parseInt(countStr, 10) || 0;
        const k = String(kindStr || "").trim().toLowerCase();
        if (k === "image") return n + " " + pluralRu(n, "вложенное изображение", "вложенных изображения", "вложенных изображений");
        if (k === "file") return n + " " + pluralRu(n, "вложенный файл", "вложенных файла", "вложенных файлов");
        return n + " " + pluralRu(n, "вложение", "вложения", "вложений");
    }

    function translateGreetingTail(tail) {
        if (!tail) return "";
        const t = tail.trim();
        if (!t) return "";
        if (EXACT_RU[t]) return " " + EXACT_RU[t];
        const low = t.toLowerCase();
        if (EXACT_LOWER_RU[low]) return " " + EXACT_LOWER_RU[low];
        return " " + t;
    }

    const REGEX_RU = [
        [/^Are you sure you want to delete the\s+(.+)\?$/i, "Вы уверены, что хотите удалить $1?"],
        [/^This will permanently delete (\d+) active conversations? within it\.$/i, "Это безвозвратно удалит $1 активных диалогов внутри."],
        // Home Screen & Onboarding Greetings (comma optional, preserving user's name + optional trailing question)
        [/^(Good morning|Good afternoon|Good evening|Good night|Welcome back|Welcome|Hello|Hi|Hey|Ready to work),?\s+([^.!?]+)([.!?])\s+(.+)$/i, (_, greet, name, punct, tail) => {
            const gMap = {
                "good morning": "Доброе утро",
                "good afternoon": "Добрый день",
                "good evening": "Добрый вечер",
                "good night": "Доброй ночи",
                "welcome back": "С возвращением",
                "welcome": "Добро пожаловать",
                "hello": "Привет",
                "hi": "Привет",
                "hey": "Привет",
                "ready to work": "Готов к работе",
            };
            const ruGreet = gMap[greet.toLowerCase()] || greet;
            return ruGreet + ", " + name.trim() + punct + translateGreetingTail(tail);
        }],
        [/^Good morning,?\s+(.+?)([!.]?)$/i, (_, n, p) => "Доброе утро, " + n + p],
        [/^Good morning([!.,]?)$/i, (_, p) => "Доброе утро" + p],
        [/^Good afternoon,?\s+(.+?)([!.]?)$/i, (_, n, p) => "Добрый день, " + n + p],
        [/^Good afternoon([!.,]?)$/i, (_, p) => "Добрый день" + p],
        [/^Good evening,?\s+(.+?)([!.]?)$/i, (_, n, p) => "Добрый вечер, " + n + p],
        [/^Good evening([!.,]?)$/i, (_, p) => "Добрый вечер" + p],
        [/^Good night,?\s+(.+?)([!.]?)$/i, (_, n, p) => "Доброй ночи, " + n + p],
        [/^Good night([!.,]?)$/i, (_, p) => "Доброй ночи" + p],
        [/^Welcome back,?\s+(.+?)([!.]?)$/i, (_, n, p) => "С возвращением, " + n + p],
        [/^Welcome back([!.,]?)$/i, (_, p) => "С возвращением" + p],
        [/^Welcome,?\s+(.+?)([!.]?)$/i, (_, n, p) => "Добро пожаловать, " + n + p],
        [/^Hello,?\s+(.+?)([!.]?)$/i, (_, n, p) => "Привет, " + n + p],
        [/^Hi,?\s+(.+?)([!.]?)$/i, (_, n, p) => "Привет, " + n + p],
        [/^Hey,?\s+(.+?)([!.]?)$/i, (_, n, p) => "Привет, " + n + p],
        [/^Ready to work,?\s+(.+?)([!?.]?)$/i, (_, n, p) => "Готов к работе, " + n + p],

        // SSH Host Modal dynamic strings
        [/^SSH config:\s*(.+?)\s*\(default\)$/i, (_, p) => "Конфиг SSH: " + p + " (по умолчанию)"],
        [/^SSH config:\s*(.+)$/i, (_, p) => "Конфиг SSH: " + p],
        [/^(.+?)\s*\(default\)$/i, (_, p) => p + " (по умолчанию)"],
        [/^No hosts in\s+(.+?)\s+yet\.\s*Type one above\.?$/i, (_, p) => "В " + p + " пока нет хостов. Введите адрес выше."],
        [/^No hosts in\s+(.+?)\s+yet\.?$/i, (_, p) => "В " + p + " пока нет хостов."],

        // Onboarding & Settings dynamic sentences
        [/^Customize your experience across the agent, plugins, and product from the settings and marketplace\. We won't show you ads or let advertisers influence what (.+?) says\.$/i, (_, app) => "Настройте агента, плагины и интерфейс в настройках и маркетплейсе. Мы не показываем рекламу и не позволяем рекламодателям влиять на ответы " + app + "."],
        [/^(.+?)'s agents are powerful and will help you get a lot done better and faster than before, but still make sure to verify the actions taken by the agent\.$/i, (_, app) => "Агенты " + app + " помогают делать работу быстрее и лучше, но всегда проверяйте выполняемые ими действия."],
        [/^Help us improve (.+?)\.$/i, (_, app) => "Помогите улучшить " + app + "."],
        [/^Sign up for newsletters, tips and tricks, and other notifications about (.+?)\.$/i, (_, app) => "Подписаться на рассылку, советы и уведомления о " + app + "."],
        [/^Manage (.+?) app settings\.$/i, (_, app) => "Управление параметрами приложения " + app + "."],
        [/^When toggled on, (.+?) collects usage data to help Google enhance performance and features\.$/i, (_, app) => "При включении " + app + " собирает данные об использовании для улучшения работы."],
        [/^When toggled on, (.+?) will use your AI credits to fulfill model requests once you're out of model quota\. .+? will always use your model quota first before using AI credits\.$/i, (_, app) => "При включении " + app + " расходует AI-кредиты после исчерпания квоты моделей. Сначала всегда используется основная квота."],
        [/^How loud (.+?)'s voice is\.$/i, (_, app) => "Громкость голоса " + app + "."],
        [/^Sign in to use (.+?)!$/i, (_, app) => "Войдите, чтобы использовать " + app + "!"],
        [/^Sign in from the (.+?) panel\.$/i, (_, p) => "Войдите через панель " + p + "."],

        // Model availability, Quota, Limits & Usage Popover
        [/^(.+?)\s+is currently available to\s+(.+?)\s*(?:plan\s+)?subscribers\.?$/i, (_, m, t) => {
            const ruPlans = formatPlanListRu(t, true);
            const prefix = ruPlans.includes("и") || ruPlans.includes("или") ? "тарифов " : "тарифа ";
            return m + " сейчас доступна подписчикам " + prefix + ruPlans + ".";
        }],
        [/^(.+?)\s+(?:is now|is|are)\s+available on\s+(?:paid\s+)?(.+?)\s+plans?\.\s*Third-party model access will no longer be available on your current plan starting on\s+(.+?)\.?$/i, (_, m, t, d) => {
            const ruPlans = formatPlanListRu(t, false);
            const ruDate = formatFullDateRu(d).replace(/\.+$/, "");
            const prefix = ruPlans.includes("и") || ruPlans.includes("или") ? "платных тарифах " : "платном тарифе ";
            return m + " доступна на " + prefix + ruPlans + ". Доступ к сторонним моделям на вашем текущем тарифе прекратится с " + ruDate + ".";
        }],
        [/^Use (.+?) for better quality with lower quota usage\.?$/i, (_, m) => "Используйте " + m + " для лучшего качества при меньшем расходе квоты."],
        [/^For paid (.+?) plans,\s*(.+?) quota is separate\.\s*Higher .+? quota \(included as part of the larger (.+?) quota bucket\) is available on (.+?) plans\.$/i, (_, p1, m, b, p2) => "На платных тарифах " + p1 + " квота " + m + " отдельная. Повышенная квота " + m + " (в составе общей квоты " + b + ") доступна на тарифах " + p2 + "."],
        [/^Models within this group:\s*(.+)$/i, (_, list) => "Модели в этой группе: " + list],
        [/^(.+?)\s+is available on\s+(.+?)\s+plans?\.$/i, (_, m, t) => m + " доступна на тарифах " + t + "."],
        [/^(.+?)\s+will be removed from Antigravity on\s+(.+?)\.?$/i, (_, m, d) => m + " будет удалена из Antigravity " + d + "."],
        [/^(.+?)\.?\s*Leaving on\s+([A-Za-z]+)\s+(\d{1,2})\.?$/i, (_, prefix, month, day) => {
            const ruMonth = formatMonthRu(month);
            const cleanPrefix = prefix.trim().replace(/\.$/, "");
            const ruPrefix = EXACT_RU[cleanPrefix] || cleanPrefix;
            return (ruPrefix ? ruPrefix + ". " : "") + "Будет отключена " + day + " " + ruMonth + ".";
        }],
        [/^Leaving on\s+([A-Za-z]+)\s+(\d{1,2})\.?$/i, (_, month, day) => {
            const ruMonth = formatMonthRu(month);
            return "Будет отключена " + day + " " + ruMonth + ".";
        }],
        [/^You can upgrade to a (.+?) plan to receive higher rate limits\.$/i, (_, plan) => "Вы можете перейти на тариф " + plan + " для увеличения лимитов."],
        [/^Your Plan:\s*(.+)$/i, (_, p) => "Ваш тариф: " + p],
        [/^Available AI Credits:\s*(.+)$/i, (_, c) => "Доступно AI-кредитов: " + c],
        [/^You have used some of your weekly limit, it will fully refresh in\s+(.+?)\.?$/i, (_, t) => "Часть недельного лимита использована, обновление через " + formatDurationRu(t) + "."],
        [/^You have used some of your (?:5-hour|five[- ]hour) limit, it will fully refresh in\s+(.+?)\.?$/i, (_, t) => "Часть 5-часового лимита использована, обновление через " + formatDurationRu(t) + "."],
        [/^You have used some of your daily limit, it will fully refresh in\s+(.+?)\.?$/i, (_, t) => "Часть дневного лимита использована, обновление через " + formatDurationRu(t) + "."],
        [/^You have used (?:all|100%) of your (.+?) limit, it will fully refresh in\s+(.+?)\.?$/i, (_, w, t) => "Лимит (" + w + ") исчерпан, обновление через " + formatDurationRu(t) + "."],
        [/^Weekly limit,\s*resets in\s+(.+)$/i, (_, t) => "Недельный лимит, сброс через " + formatDurationRu(t)],
        [/^Daily limit,\s*resets in\s+(.+)$/i, (_, t) => "Дневной лимит, сброс через " + formatDurationRu(t)],
        [/^(\d+[smhd])\s+limit,\s*resets in\s+(.+)$/i, (_, w, t) => "Лимит за " + formatDurationRu(w) + ", сброс через " + formatDurationRu(t)],
        [/^(\d+[smhd])\s+limit$/i, (_, w) => "Лимит за " + formatDurationRu(w)],
        [/^Resets in\s+(.+)$/i, (_, t) => "Сброс через " + formatDurationRu(t)],
        [/^(\d+)%\s+left$/i, (_, n) => n + "% осталось"],
        [/^Your quota for (.+?) will reset on (.+?)\. Switch to another available model to continue\.$/i, (_, m, d) => "Квота для " + m + " обновится " + d + ". Переключитесь на другую доступную модель."],
        [/^Your quota for (.+?) has been reached\. Switch to another available model to continue\.$/i, (_, m) => "Квота для " + m + " исчерпана. Переключитесь на другую доступную модель."],
        [/^You need (.+?) AI Credits to send messages\. To continue using (.+?) now, purchase more AI Credits\.$/i, (_, n, m) => "Для отправки сообщений требуется " + n + " AI-кредитов. Чтобы продолжить с " + m + ", пополните баланс."],
        [/^(.+?)\s+Weekly Limit$/i, (_, m) => "Недельный лимит " + m],
        [/^(.+?)\s+Five Hour Limit$/i, (_, m) => "5-часовой лимит " + m],

        // Permissions & Shortcuts dynamic strings
        [/^Select Sidebar Item (\d+)$/i, (_, n) => "Выбрать пункт панели " + n],
        [/^(.+?)\s+needs? the terminal sandbox, which isn't available on this host\.$/i, (_, p) => p + " требует песочницу терминала, недоступную на этом компьютере."],
        [/^Inherits your Global Permissions when working (.+?)\.$/i, (_, where) => "Наследует глобальные разрешения при работе (" + where + ")."],
        [/^Your (.+?) setting$/i, (_, scope) => "Настройка: " + scope],
        [/^Low contrast ratio \((.+?)\)\. Text may be hard to read\.$/i, (_, r) => "Низкая контрастность (" + r + "). Текст может плохо читаться."],
        [/^(\d+)\s+tools?\s+enabled$/i, (_, n) => "Включено инструментов: " + n],
        [/^Reset (\d+) overrides?$/i, (_, n) => "Сбросить переопределения (" + n + ")"],
        [/^Marked (\d+) conversations? as read$/i, (_, n) => "Отмечено прочитанными: " + n],
        [/^([\d\s\u00a0\u202f.,]+)\s*\/\s*([\d\s\u00a0\u202f.,]+)\s+tokens\s*\(([^)]+)\)$/i, (_, used, total, pct) => used + " / " + total + " токенов (" + pct + ")"],
        [/^\/\s*([\d\s\u00a0\u202f.,]+)\s+tokens\s*\(([^)]+)\)$/i, (_, total, pct) => "/ " + total + " токенов (" + pct + ")"],
        [/^tokens\s*\(([^)]+)\)$/i, (_, pct) => "токенов (" + pct + ")"],
        [/^Plugin:\s*(.+)$/i, (_, p) => "Плагин: " + p],
        [/^Send feedback as\s+(.+)$/i, (_, email) => "Отправить отзыв от имени " + email],
        [/^Cancel\s*\(([^)]+)\)$/i, (_, k) => "Отмена (" + k + ")"],
        [/^Comment\s*\(([^)]+)\)$/i, (_, k) => "Комментарий (" + k + ")"],
        [/^Available on\s+(paid\s+)?(.+?)\s+plans?\.\s*Not included with your current plan\.?$/i, (_, paid, plans) => "Доступно на " + (paid ? "платных тарифах " : "тарифах ") + formatPlanListRu(plans, false) + ". Не входит в ваш текущий тариф."],
        [/^Available on\s+(paid\s+)?(.+?)\s+plans?\.?$/i, (_, paid, plans) => "Доступно на " + (paid ? "платных тарифах " : "тарифах ") + formatPlanListRu(plans, false) + "."],
        [/^Match Whole Word(?:\s*\(([^)]+)\))?$/i, (_, key) => "Слово целиком" + (key ? " (" + key + ")" : "")],
        [/^Match Case(?:\s*\(([^)]+)\))?$/i, (_, key) => "Учитывать регистр" + (key ? " (" + key + ")" : "")],
        [/^Use Regular Expression(?:\s*\(([^)]+)\))?$/i, (_, key) => "Регулярное выражение" + (key ? " (" + key + ")" : "")],
        [/^Updated\s+(\d+:\d+(?::\d+)?|just now|\d+\s*(?:[smhd]|sec|min|hr|day|mo|yr|second|minute|hour|day|week|month|year)s?(?:\s+ago)?)$/i, (_, t) => /^just now$/i.test(t) ? "Обновлено только что" : "Обновлено " + formatDurationRu(t)],
        [/^Restart to Update(?:\s*(?:->|→))?$/i, (m) => m.includes("→") ? "Перезапустить для обновления →" : "Перезапустить для обновления"],
        [/^Previous Match(?:\s*\(([^)]+)\))?$/i, (_, key) => "Предыдущее совпадение" + (key ? " (" + key + ")" : "")],
        [/^Next Match(?:\s*\(([^)]+)\))?$/i, (_, key) => "Следующее совпадение" + (key ? " (" + key + ")" : "")],
        [/^Close(?:\s*\(([^)]+)\))?$/i, (_, key) => "Закрыть" + (key ? " (" + key + ")" : "")],
        [/^(\d+)\s+of\s+(\d+)$/i, (_, a, b) => a + " из " + b],
        [/^\+(\d+)\s+more\s+lines?$/i, (_, n) => "+" + n + " ещё строк"],
        [/^\(\s*(\d+)\s+(?:(image|file|media|video|audio)\s+)?attachments?\s*\)$/i, (_, n, kind) => "(" + formatAttachmentCountRu(n, kind) + ")"],
        [/^(\d+)\s+(?:(image|file|media|video|audio)\s+)?attachments?$/i, (_, n, kind) => formatAttachmentCountRu(n, kind)],
        [/^(\+?\s*)See (\d+) more$/i, (_, p, n) => p + "Показать ещё " + n],
        [/^Mondays at (.+)$/i, (_, t) => "По понедельникам в " + t],
        [/^Tuesdays at (.+)$/i, (_, t) => "По вторникам в " + t],
        [/^Wednesdays at (.+)$/i, (_, t) => "По средам в " + t],
        [/^Thursdays at (.+)$/i, (_, t) => "По четвергам в " + t],
        [/^Fridays at (.+)$/i, (_, t) => "По пятницам в " + t],
        [/^Saturdays at (.+)$/i, (_, t) => "По субботам в " + t],
        [/^Sundays at (.+)$/i, (_, t) => "По воскресеньям в " + t],
        [/^Daily at (.+)$/i, (_, t) => "Ежедневно в " + t],
        [/^Tomorrow (.+)$/i, (_, t) => "Завтра " + t],
        [/^Today (.+)$/i, (_, t) => "Сегодня " + t],
        [/^Show (\d+) breakdowns?$/i, (_, n) => "Показать детализацию (" + n + ")"],
        [/^Hide (\d+) breakdowns?$/i, (_, n) => "Скрыть детализацию (" + n + ")"],

        // Voice / Gemini Live & Context Menu dynamic strings
        [/^Choose (.+?)'s Voice$/i, (_, app) => "Выбор голоса " + app],
        [/^Voice Speed,\s*(.+)$/i, (_, sp) => "Скорость голоса: " + sp],
        [/^Mute mic(?:\s*\(([^)]+)\))?$/i, (_, key) => "Выключить микрофон" + (key ? " (" + key + ")" : "")],
        [/^Unmute mic(?:\s*\(([^)]+)\))?$/i, (_, key) => "Включить микрофон" + (key ? " (" + key + ")" : "")],
        [/^Mute (Antigravity|Jetski)(?:\s*\(([^)]+)\))?$/i, (_, app, key) => "Выключить звук " + app + (key ? " (" + key + ")" : "")],
        [/^Unmute (Antigravity|Jetski)(?:\s*\(([^)]+)\))?$/i, (_, app, key) => "Включить звук " + app + (key ? " (" + key + ")" : "")],
        [/^Send Message (.+)$/i, (_, key) => "Отправить (" + key + ")"],
        [/^Pin Entire (.+)$/i, (_, target) => "Закрепить весь " + target],
        [/^Unpin (.+)$/i, (_, target) => "Открепить " + target],

        // Agent Process Step Group Summaries ("Explored files, ran commands, edited files", etc.)
        [/^(?:Explored(?:\s+(?:files?|artifacts?))?|Ran\s+commands?|Edited\s+(?:files?|artifacts?))(?:,\s*(?:ran\s+commands?|edited\s+(?:files?|artifacts?)))*$/i, (full) => {
            const mapPart = (p, isFirst) => {
                const low = p.trim().toLowerCase();
                let res = p;
                if (low === "explored") res = "изучено";
                else if (low === "explored file") res = "изучен файл";
                else if (low === "explored files") res = "изучены файлы";
                else if (low === "explored artifact") res = "изучен артефакт";
                else if (low === "explored artifacts") res = "изучены артефакты";
                else if (low === "ran command") res = "выполнена команда";
                else if (low === "ran commands") res = "выполнены команды";
                else if (low === "edited file") res = "изменён файл";
                else if (low === "edited files") res = "изменены файлы";
                else if (low === "edited artifact") res = "изменён артефакт";
                else if (low === "edited artifacts") res = "изменены артефакты";
                return isFirst ? res.charAt(0).toUpperCase() + res.slice(1) : res;
            };
            return full.split(/,\s*/).map((p, idx) => mapPart(p, idx === 0)).join(", ");
        }],
        [/^Ran\s+(.+)$/, (_, rest) => "Выполнено: " + rest],
        [/^Running\s+(.+)$/, (_, rest) => "Выполняется: " + rest],
        [/^Searching\s+(.+)$/, (_, rest) => "Поиск: " + rest],
        [/^Error while\s+(.+)$/i, (_, rest) => "Ошибка: " + rest],
        [/^Show (\d+) more$/i, (_, n) => "Показать ещё " + n],

        // Slash-command descriptions in / menu
        [/^Ask a quick question without interrupting.+$/i, "Задать быстрый вопрос, не прерывая основной диалог."],
        [/^Run until the specified goal is complete.+$/i, "Выполнять задачу до полного достижения цели."],
        [/^Compact the conversation now.+$/i, "Сжать историю диалога для освобождения контекста."],
        [/^Run an instruction on a recurring.+$/i, "Запускать инструкцию по расписанию или таймеру."],
        [/^Invoke a browser agent for web tasks\.?$/i, "Запустить браузерного агента для веб-задач."],
        [/^Plan carefully before executing a task\.?$/i, "Тщательно спланировать шаги перед выполнением."],
        [/^Interview me to align on a plan\.?$/i, "Провести интервью для согласования плана."],
        [/^Invoke a team of agents to autonomous.+$/i, "Запустить команду автономных агентов."],
        [/^Reflect on recent successes or correcti.+$/i, "Запомнить исправления и успешные решения."],
        [/^Invoke the Boost multi-agent orchestrat.+$/i, "Запустить мультиагентный режим Boost."],
        [/^Sign in to (.+)$/i, (_, svc) => "Войти в " + svc],

        // Dynamic counts, timestamps, versions & durations
        [/^Version\s+(.+)$/, (_, v) => "Версия " + v],
        [/^Updated\s+(just\s+now|<\s*1\s*m(?:\s+ago)?|\d+\s*(?:mo|months?|w|weeks?|d|days?|h|hrs?|hours?|m|mins?|minutes?|s|secs?|seconds?)(?:(?:\s+|,\s*)\d+\s*(?:mo|months?|w|weeks?|d|days?|h|hrs?|hours?|m|mins?|minutes?|s|secs?|seconds?))*(?:\s+ago)?)$/, (_, t) => "Обновлено " + formatDurationRu(t)],
        [/^Last updated\s+(just\s+now|<\s*1\s*m(?:\s+ago)?|\d+\s*(?:mo|months?|w|weeks?|d|days?|h|hrs?|hours?|m|mins?|minutes?|s|secs?|seconds?)(?:(?:\s+|,\s*)\d+\s*(?:mo|months?|w|weeks?|d|days?|h|hrs?|hours?|m|mins?|minutes?|s|secs?|seconds?))*(?:\s+ago)?)$/i, (_, t) => "Обновлено " + formatDurationRu(t)],
        [/^Created\s+(just\s+now|<\s*1\s*m(?:\s+ago)?|\d+\s*(?:mo|months?|w|weeks?|d|days?|h|hrs?|hours?|m|mins?|minutes?|s|secs?|seconds?)(?:(?:\s+|,\s*)\d+\s*(?:mo|months?|w|weeks?|d|days?|h|hrs?|hours?|m|mins?|minutes?|s|secs?|seconds?))*(?:\s+ago)?)$/, (_, t) => "Создано " + formatDurationRu(t)],
        [/^Edited\s+(just\s+now|<\s*1\s*m(?:\s+ago)?|\d+\s*(?:mo|months?|w|weeks?|d|days?|h|hrs?|hours?|m|mins?|minutes?|s|secs?|seconds?)(?:(?:\s+|,\s*)\d+\s*(?:mo|months?|w|weeks?|d|days?|h|hrs?|hours?|m|mins?|minutes?|s|secs?|seconds?))*(?:\s+ago)?)$/, (_, t) => "Изменено " + formatDurationRu(t)],
        [/^Started\s+(just\s+now|<\s*1\s*m(?:\s+ago)?|\d+\s*(?:mo|months?|w|weeks?|d|days?|h|hrs?|hours?|m|mins?|minutes?|s|secs?|seconds?)(?:(?:\s+|,\s*)\d+\s*(?:mo|months?|w|weeks?|d|days?|h|hrs?|hours?|m|mins?|minutes?|s|secs?|seconds?))*(?:\s+ago)?)$/, (_, t) => "Запущено " + formatDurationRu(t)],
        [/^Thought for (.+)$/, (_, t) => "Думал " + formatDurationRu(t)],
        [/^Thinking for (.+)$/, (_, t) => "Думает " + formatDurationRu(t)],
        [/^Worked for (.+)$/, (_, t) => "Работал " + formatDurationRu(t)],
        [/^(\d+)\s+files?\s+changed$/, (_, n) => "Изменено файлов: " + n],
        [/^(\d+)\s+seconds?\s+ago$/, (_, n) => n + " сек назад"],
        [/^(\d+)\s+minutes?\s+ago$/, (_, n) => n + " мин назад"],
        [/^(\d+)\s+hours?\s+ago$/, (_, n) => n + " ч назад"],
        [/^(\d+)\s+days?\s+ago$/, (_, n) => n + " дн назад"],
        [/^(\d+)\s+weeks?\s+ago$/, (_, n) => n + " нед назад"],
        [/^(\d+)\s+months?\s+ago$/, (_, n) => n + " мес назад"],
        [/^(\d+)s$/, (_, n) => n + "с"],
        [/^(\d+)m$/, (_, n) => n + "м"],
        [/^(\d+)d$/, (_, n) => n + "д"],
        [/^(\d+)h$/, (_, n) => n + "ч"],
        [/^(\d+)w$/, (_, n) => n + "нед"],
        [/^(\d+)mo$/, (_, n) => n + "мес"],
        [/^(\d+)\s+conversations?$/, (_, n) => "Диалогов: " + n],
        [/^(\d+)\s+tasks?$/, (_, n) => "Задач: " + n],
        [/^(\d+)\s+selected$/, (_, n) => "Выбрано: " + n],
        [/^(\d+)\s+tokens?$/, (_, n) => n + " токенов"],
        [/^(\d+)\s+steps?$/, (_, n) => "Шагов: " + n],
        [/^(\d+)\s+tools?$/, (_, n) => "Инструментов: " + n],
        [/^(\d+)\s+results?$/, (_, n) => "Результатов: " + n],
        [/^Model:\s*(.+)$/, (_, m) => "Модель: " + m],
        [/^Permissions:\s*(.+)$/i, (_, p) => "Разрешения: " + p],
        [/^Volume:\s*(.+)$/i, (_, v) => "Громкость: " + v],
        [/^Project ID:\s*(.+)$/i, (_, id) => "ID проекта: " + id],
    ];

    const SKIP_TEXT_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "PRE", "CODE", "KBD", "SAMP", "SVG", "PATH", "CIRCLE", "RECT", "LINE", "POLYGON", "POLYLINE", "CANVAS", "TEXTAREA", "INPUT", "VIDEO", "AUDIO", "IMG", "BR", "HR"]);
    const SKIP_ATTR_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "PRE", "CODE", "SVG", "PATH", "CIRCLE", "RECT", "LINE", "POLYGON", "POLYLINE", "CANVAS", "VIDEO", "AUDIO", "BR", "HR"]);
    const SKIP_IDS = new Set(["agy-extras-shadow-host", "agy-wp-shadow-host", "agy-sidebar-extras", "agy-ctx-ring"]);
    const SLASH_CMD_NAMES = new Set(["btw", "goal", "compact", "schedule", "browser", "plan", "grill-me", "teamwork", "learn", "boost"]);
    const ATTR_SELECTOR = "[placeholder], [data-placeholder], [title], [aria-label]";
    const TRACKED_ATTRS = ["placeholder", "data-placeholder", "title", "aria-label"];

    const origTextMap = new WeakMap();
    const lastRuTextMap = new WeakMap();
    const origAttrMap = new WeakMap();
    const lastRuAttrMap = new WeakMap();

    function detectInitialLang() {
        try {
            const wp = JSON.parse(localStorage.getItem("agy_wp_v11") || "{}");
            if (wp && (wp.lang === "en" || wp.lang === "ru")) return wp.lang;
        } catch {}
        try {
            const ex = JSON.parse(localStorage.getItem("agy_extras_v4") || "{}");
            if (ex && (ex.lang === "en" || ex.lang === "ru")) return ex.lang;
        } catch {}
        return "ru";
    }

    let currentLang = detectInitialLang();
    let observer = null;
    let isMutating = false;

    function hasAncestorMatching(el, pred) {
        let cur = el;
        while (cur && cur.nodeType === 1) {
            if (pred(cur)) return true;
            cur = cur.parentElement;
        }
        return false;
    }

    function isBranchOrFileContext(node) {
        const el = node && (node.nodeType === 1 ? node : node.parentElement);
        if (!el) return false;
        return hasAncestorMatching(el, (cur) => {
            const tid = (typeof cur.getAttribute === "function" ? cur.getAttribute("data-testid") : "") || "";
            const cls = typeof cur.className === "string" ? cur.className : "";
            const role = (typeof cur.getAttribute === "function" ? cur.getAttribute("role") : "") || "";
            if (
                (typeof cur.hasAttribute === "function" && (cur.hasAttribute("data-branch") || cur.hasAttribute("data-branch-name") || cur.hasAttribute("data-file-path") || cur.hasAttribute("data-file-uri"))) ||
                /(?:branch|git|file-tree|file-list|changed-files|source-control|worktree)/i.test(tid) ||
                /(?:branch|git-ref|file-tree|file-list)/i.test(cls)
            ) {
                return true;
            }
            if ((role === "option" || role === "treeitem") && /(?:branch|file|ref|git)/i.test(tid + " " + cls)) {
                return true;
            }
            return false;
        });
    }

    function shouldSkipElement(el, forAttr = false) {
        if (!el || el.nodeType !== 1) return true;
        if (forAttr ? SKIP_ATTR_TAGS.has(el.tagName) : SKIP_TEXT_TAGS.has(el.tagName)) return true;
        if (el.id && SKIP_IDS.has(el.id)) return true;
        if (!forAttr && el.isContentEditable) return true;

        // 1. Always skip code lines, diff lines, syntax tokens, terminals, and editors
        if (el.closest("pre, code, kbd, samp, .monaco-editor, .cm-editor, .monaco-diff-editor, .code-line, .line-content, [data-testid='code-gutter-diff'], [data-testid='diff-gutter-strip'], .xterm, .terminal, .agy-user-bubble, [data-agy-no-i18n]")) {
            return true;
        }

        // 2. Diff viewer and code block containers: allow toolbar/search UI & hunk expanders, skip actual code/diff text
        if (el.closest(".file-viewer-root, .code-block, .diff-view-mode-detail, [data-file-uri], [data-diff-type], .bottom-terminal-panel")) {
            if (!el.closest("button, [role='button'], [role='menuitem'], [role='tab'], [role='dialog'], [role='tooltip'], [role='search'], [role='status']")) {
                const rawHint = forAttr ? "" : String(el.textContent || "").trim();
                const allowDiffUiLabel = /^(?:\+\d+\s+more\s+lines?|No Results|\d+\s+of\s+\d+)$/i.test(rawHint);
                if (!allowDiffUiLabel) return true;
            }
        }

        // 3. User project header, conversation rows, file trees, and non-tree file/branch lists: protect titles/paths/branches
        if (!forAttr && (
            el.closest('[data-testid="project-header"], [data-testid="conversation-row-sidebar"], [data-testid="conversation-row-history"], [data-testid="tab-file-tree-sidebar"] [role="treeitem"], [data-testid="tab-file-tree-sidebar"] [role="listitem"], [data-testid="tab-file-tree-sidebar"] [role="row"], [data-testid="branch-list"], [data-testid="file-list"], [data-file-path], [data-branch-name]') ||
            hasAncestorMatching(el, (cur) => {
                const tid = (typeof cur.getAttribute === "function" ? cur.getAttribute("data-testid") : "") || "";
                const cls = typeof cur.className === "string" ? cur.className : "";
                return /(?:^|[-_])(?:branch-list|file-list|changed-files-list)(?:$|[-_])|tab-file-tree-sidebar/i.test(tid) || /\b(?:branch-list|file-list)\b/i.test(cls);
            })
        )) {
            if (!el.closest('[role="menu"], [role="menuitem"], [role="tooltip"], [role="dialog"]')) return true;
        }

        // 4. Markdown body in assistant response: protect prose / code from accidental word mutations
        if (el.closest("[data-main-content-body]")) {
            if (el.closest(".prose, [class*='markdown'], [data-testid*='markdown']")) {
                if (!el.closest("button, [role='button'], [role='menuitem'], [role='tab'], [role='dialog']")) return true;
            }
        }
        return false;
    }

    function preserveOuterSpaces(raw, translatedCore) {
        let start = 0;
        let end = raw.length;
        while (start < end && /\s/.test(raw[start])) start++;
        while (end > start && /\s/.test(raw[end - 1])) end--;
        return raw.slice(0, start) + translatedCore + raw.slice(end);
    }

    function translateText(raw, node) {
        if (!raw) return null;
        const trimmed = raw.trim();
        if (!trimmed || trimmed.length > 480) return null;
        const norm = trimmed
            .replace(/[\u2018\u2019]/g, "'")
            .replace(/[\u201C\u201D]/g, '"')
            .replace(/\u2026/g, "...")
            .replace(/\s+/g, " ");

        // Keep literal lowercase slash-command names untranslated (e.g. /plan, /compact, /browser, /goal)
        if (SLASH_CMD_NAMES.has(norm)) return null;

        // Context-aware split React text fragments (preserves sibling DOM nodes for React reconciliation)
        if (norm === "says." && node && node.parentElement) {
            const pTxt = node.parentElement.textContent || "";
            if (pTxt.includes("рекламодател") || pTxt.includes("advertisers")) {
                return ".";
            }
            return null;
        }
        if (norm === "documentation" && node && node.parentElement) {
            const pTxt = (node.parentElement.parentElement || node.parentElement).textContent || "";
            if (pTxt.includes("Business") || pTxt.includes("consumption")) {
                return preserveOuterSpaces(raw, "документации");
            }
        }
        if (norm === "Use" && node && node.parentElement && node.parentElement.closest && node.parentElement.closest('[data-testid="voice-picker"]')) {
            return preserveOuterSpaces(raw, "Выбрать");
        }
        if (norm === "Terms of Service" && node && node.parentElement && node.parentElement.tagName === "A") {
            const aTxt = node.parentElement.textContent || "";
            if (aTxt.startsWith("Google ")) {
                return preserveOuterSpaces(raw, "— Условия использования");
            }
        }
        if (norm === "Enter" && node && node.parentElement) {
            const pTxt = node.parentElement.textContent || "";
            if (pTxt.includes("SSH config") || pTxt.includes("конфигурации SSH")) {
                return preserveOuterSpaces(raw, "Введите");
            }
        }
        if (norm === "No hosts in" && node && node.parentElement) {
            const pTxt = node.parentElement.textContent || "";
            if (pTxt.includes("Type one above") || pTxt.includes("пока нет хостов")) {
                return preserveOuterSpaces(raw, "В");
            }
        }

        if (EXACT_RU[norm]) {
            if ((norm === "Branch" || norm === "Status") && isBranchOrFileContext(node)) return null;
            return preserveOuterSpaces(raw, EXACT_RU[norm]);
        }
        const low = norm.toLowerCase();
        if (EXACT_LOWER_RU[low]) {
            if ((low === "branch" || low === "status") && isBranchOrFileContext(node)) return null;
            return preserveOuterSpaces(raw, EXACT_LOWER_RU[low]);
        }
        // Mixed user text + trailing English attachment count suffix e.g. "... (4 image attachments)"
        const trailingAttach = /^(.+?)\s*\(\s*(\d+)\s+(?:(image|file|media|video|audio)\s+)?attachments?\s*\)$/i.exec(norm);
        if (trailingAttach) {
            return preserveOuterSpaces(raw, trailingAttach[1] + " (" + formatAttachmentCountRu(trailingAttach[2], trailingAttach[3]) + ")");
        }
        // Fast-path: skip ~100 regexes for pure digits/punctuation or already-Cyrillic text
        if (!/[A-Za-z]/.test(norm) || /[\u0400-\u04FF]/.test(norm)) return null;
        for (let i = 0; i < REGEX_RU.length; i++) {
            const pair = REGEX_RU[i];
            if (pair[0].test(norm)) {
                return preserveOuterSpaces(raw, norm.replace(pair[0], pair[1]));
            }
        }
        return null;
    }

    function translateAttr(attrName, val) {
        if (!val || typeof val !== "string") return null;
        const t = val.trim();
        if (!t || t.length > 480) return null;
        if (attrName === "placeholder" || attrName === "data-placeholder") {
            for (let i = 0; i < PLACEHOLDER_RU.length; i++) {
                if (PLACEHOLDER_RU[i][0].test(t)) return PLACEHOLDER_RU[i][1];
            }
            return EXACT_RU[t] || EXACT_LOWER_RU[t.toLowerCase()] || translateText(t, null);
        }
        return translateText(t, null);
    }

    function applyToTextNode(node, isRu) {
        const parent = node.parentElement;
        if (!parent || shouldSkipElement(parent, false)) return;
        const cur = node.nodeValue || "";
        if (isRu) {
            if (!cur.trim()) return;
            if (lastRuTextMap.get(node) === cur) return;
            const tr = translateText(cur, node);
            if (tr && tr !== cur) {
                origTextMap.set(node, cur);
                lastRuTextMap.set(node, tr);
                node.nodeValue = tr;
            } else if (origTextMap.has(node)) {
                origTextMap.delete(node);
                lastRuTextMap.delete(node);
            }
        } else if (origTextMap.has(node)) {
            const orig = origTextMap.get(node);
            const expectedRu = lastRuTextMap.get(node);
            if (cur === expectedRu && cur !== orig) {
                node.nodeValue = orig;
            }
            origTextMap.delete(node);
            lastRuTextMap.delete(node);
        }
    }

    function applyAttrsToElement(el, isRu) {
        if (shouldSkipElement(el, true)) return;
        let saved = origAttrMap.get(el);
        let applied = lastRuAttrMap.get(el);
        for (let i = 0; i < TRACKED_ATTRS.length; i++) {
            const attr = TRACKED_ATTRS[i];
            if (!el.hasAttribute(attr)) continue;
            const cur = el.getAttribute(attr) || "";
            if (isRu) {
                if (applied && applied[attr] === cur) continue;
                const tr = translateAttr(attr, cur);
                if (tr && tr !== cur) {
                    if (!saved) { saved = {}; origAttrMap.set(el, saved); }
                    if (!applied) { applied = {}; lastRuAttrMap.set(el, applied); }
                    saved[attr] = cur;
                    applied[attr] = tr;
                    el.setAttribute(attr, tr);
                } else if (saved && attr in saved) {
                    delete saved[attr];
                    if (applied) delete applied[attr];
                }
            } else if (saved && attr in saved) {
                if (!applied || cur === applied[attr]) {
                    el.setAttribute(attr, saved[attr]);
                }
                delete saved[attr];
                if (applied) delete applied[attr];
            }
        }
        if (!isRu) {
            if (saved && Object.keys(saved).length === 0) origAttrMap.delete(el);
            if (applied && Object.keys(applied).length === 0) lastRuAttrMap.delete(el);
        }
    }

    function walkAndApply(root, isRu) {
        if (!root || (root.nodeType !== 1 && root.nodeType !== 3)) return;
        if (root.nodeType === 3) {
            applyToTextNode(root, isRu);
            return;
        }
        if (shouldSkipElement(root, true)) return;

        if (root.matches && root.matches(ATTR_SELECTOR)) {
            applyAttrsToElement(root, isRu);
        }
        const isDocRoot = root === document.body || root === document.documentElement;
        if (!isDocRoot && (!root.children || root.children.length === 0)) {
            if (!shouldSkipElement(root, false) && root.childNodes && root.childNodes.length) {
                for (let i = 0; i < root.childNodes.length; i++) {
                    const cn = root.childNodes[i];
                    if (cn && cn.nodeType === 3) applyToTextNode(cn, isRu);
                }
            }
            return;
        }
        if (root.querySelectorAll) {
            const list = root.querySelectorAll(ATTR_SELECTOR);
            for (let i = 0; i < list.length; i++) {
                applyAttrsToElement(list[i], isRu);
            }
        }

        if (!shouldSkipElement(root, false)) {
            const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
            let node;
            while ((node = walker.nextNode())) {
                applyToTextNode(node, isRu);
            }
        }
    }

    function applyToSubtree(root) {
        if (!root) return;
        const isRu = currentLang === "ru";
        isMutating = true;
        try {
            walkAndApply(root, isRu);
        } finally {
            if (observer) {
                try { observer.takeRecords(); } catch {}
            }
            isMutating = false;
        }
    }

    function startObserver() {
        const target = document.documentElement || document.body;
        if (observer || !target) return;
        observer = new MutationObserver((mutations) => {
            if (isMutating || currentLang !== "ru") return;
            isMutating = true;
            try {
                for (let i = 0; i < mutations.length; i++) {
                    const m = mutations[i];
                    if (m.type === "characterData") {
                        if (m.target && m.target.nodeType === 3) {
                            applyToTextNode(m.target, true);
                        }
                        continue;
                    }
                    if (m.type === "attributes") {
                        if (m.target && m.target.nodeType === 1) {
                            applyAttrsToElement(m.target, true);
                        }
                        continue;
                    }
                    if (m.type === "childList") {
                        for (let j = 0; j < m.addedNodes.length; j++) {
                            const n = m.addedNodes[j];
                            if (n.nodeType === 3) {
                                applyToTextNode(n, true);
                            } else if (n.nodeType === 1) {
                                walkAndApply(n, true);
                            }
                        }
                    }
                }
            } finally {
                try { observer.takeRecords(); } catch {}
                isMutating = false;
            }
        });
        observer.observe(target, {
            childList: true,
            subtree: true,
            characterData: true,
            attributes: true,
            attributeFilter: TRACKED_ATTRS,
        });
    }

    window.__agyI18n = {
        getLang() { return currentLang; },
        setLang(lang) {
            const next = lang === "en" ? "en" : "ru";
            const changed = next !== currentLang;
            currentLang = next;
            if (changed) {
                applyToSubtree(document.body || document.documentElement);
            }
            if (currentLang === "ru") {
                startObserver();
            } else if (observer) {
                try { observer.disconnect(); } catch {}
                observer = null;
            }
            if (changed) {
                window.dispatchEvent(new CustomEvent("agy-lang-changed", { detail: { lang: next } }));
            }
        },
        refresh() {
            applyToSubtree(document.body || document.documentElement);
        },
        _translateTextForTest(raw) {
            return translateText(raw, null);
        },
        _translateAttrForTest(attr, raw) {
            return translateAttr(attr, raw);
        },
        _shouldSkipElementForTest(el, forAttr = false) {
            return shouldSkipElement(el, forAttr);
        },
        _isObserverActiveForTest() {
            return Boolean(observer);
        },
    };

    // Translate entire document.body (including Radix/Floating-UI portals outside #root) immediately
    if (currentLang === "ru") {
        applyToSubtree(document.body || document.documentElement);
        startObserver();
    }
}

function buildI18nClientJs() {
    return `(${agyI18nBootstrap.toString()})();`;
}

module.exports = {
    buildI18nClientJs,
};
