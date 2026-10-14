# Codex Conversation Manager

VS Code extension for Windows and Linux that browses local Codex conversations and Codex Cloud tasks alongside the Codex extension.

## Features

- Adds **Codex 对话管理器** to the Codex view container used by the installed Codex extension. It supports the current `codexSecondaryViewContainer` and the older `codexViewContainer`. If neither is available, the command and status-bar fallback open the manager in a webview panel.
- Reads local history, summaries, names, status, working directories, account state, quota windows, and token activity through the Codex App Server over local stdio JSONL.
- Lists Codex Cloud tasks through `codex cloud list --json`, reloading the first page when the Cloud source is selected and preserving returned cursors and environment, summary, status, and URL fields. Cloud-only counts exclude local records; if the CLI returns no tasks, the manager explains which account/source to check.
- De-duplicates repeated records with the same thread ID within a source, including repeats returned on the same page; distinct threads with the same title remain separate.
- Filters by source and project/environment, searches titles and project names/paths, sorts by start/update/activity time, and loads metadata pages as needed. Project search opens matching choices as you type and defaults to the current workspace when a matching project is available. The project filter is disabled and ignored in cloud-only mode, while its previous selection is retained for local or combined views. Windows project paths merge case-only variants while POSIX paths retain case-sensitive identity.
- Opens local threads using their App Server thread ID and the `codex://threads/<thread-id>` URI. Cloud tasks only use a URL returned by the CLI.
- Shows **5小时剩余** and **周剩余** with their percentages and reset times, plus the last session-list refresh time at the end of the **Codex 对话管理器** view title. The refresh action is in the expanded view toolbar and is available through the Command Palette. The current VS Code view API does not render view-title actions in the collapsed view row; the session-list timestamp remains in the title, but the refresh icon is not shown there. The session list refreshes at startup, on demand, after session changes, and every 15 minutes; the title timestamp updates when a refresh completes. The right side of the VS Code status bar shows the same remaining percentages; its tooltip lists each quota window and reset time, and clicking it opens account usage details. Account usage refreshes at startup, on demand, and every five minutes.
- The **账户用量** page labels the primary and weekly windows **5小时剩余** and **周剩余**, while retaining used percentages, exact reset times, and countdowns that update every minute. Its progress bars use blue for remaining quota and gray for used quota. Daily token activity can switch between a chronological line chart and the existing data list; chart dates and timestamp-based labels use Beijing time (`Asia/Shanghai`). The page also shows the available reset count returned by the Codex service and each available reset credit's expiration time in the local timezone; missing per-credit expiry data is labeled **服务未提供**.
- Windows local sessions can be opened in the ChatGPT desktop app or in the Codex VS Code extension's `/local/<thread-id>` route. Linux local sessions open through the Codex VS Code extension. Cloud tasks continue to use their returned URL.
- Every local conversation card has a searchable question dropdown that loads all user questions on demand. The Windows ChatGPT desktop and VS Code Codex buttons open the full conversation; on Linux, the VS Code Codex button is the available local-session route. They do not jump to a selected question. The details page keeps a paged transcript without repeating the question list.
- Supports local rename and confirmed permanent deletion through App Server methods. If another Codex client holds an active writer lock, deletion is safely rejected with steps to finish and close that session before refreshing and retrying.
- Uses the current-platform App Server CLI bundled with the installed ChatGPT/Codex VS Code extension by default (including `bin/linux-x86_64/codex` on Linux), with PATH fallback and a machine-scoped path override. It verifies App Server support and does not touch the IDE extension's development-only CLI setting.

## Requirements

- VS Code
- The OpenAI Codex extension (`openai.chatgpt`)
- The OpenAI Codex extension's bundled CLI, a Codex CLI available on `PATH`, or a selected executable from **Sponge: 配置 Codex CLI 路径**

The extension does not read OAuth credential files, passwords, or cookies. Local conversation and account data stay in the local extension host. Codex Cloud data is requested from the official CLI only while the cloud source is loaded.

## Build and install

    npm install
    npm run compile
    npm run package
    code --install-extension ./codex-conversation-manager-0.2.25.vsix --force

Open the Codex view container and choose **Codex 对话管理器**. If the Codex container cannot be detected, run **Sponge: 打开 Codex 对话管理器** from the Command Palette.

The CLI discovery check verifies bundled-extension, PATH, and explicit-override precedence. The live CLI smoke check requires an available Codex CLI and a signed-in Codex account:

    npm run check:webview
    npm run check:quota-status-and-links
    npm run check:reset-credits
    npm run check:cli-discovery
    npm run smoke:cli

## Data limits

- Cloud data is limited to the fields and page size provided by `codex cloud list --json`. The CLI currently returns up to 20 tasks per page. Cloud transcript details, rename, and delete are not exposed unless an official supported CLI capability is added and verified.
- A cloud task with no returned URL cannot be opened. The extension never turns a cloud ID into a local Codex URI.
- The local detail page loads turns only when opened and pages the conversation ten turns at a time to keep long sessions responsive. The UI omits reasoning and tool execution items. If the App Server does not return a completed-turn timestamp, the UI says “未提供” and shows the last update separately.
- Codex App Server is experimental. The CLI path verifier initializes the App Server and reports compatibility failures without changing the selected path.
- A remote/WSL workspace may have a different working directory from the local UI extension host. The manager reports the host and Codex Home used by its App Server.
- Quota windows and token activity are separate. Missing service data is shown as unavailable, never as zero usage.
