# Codex Conversation Manager

VS Code extension for Windows and Linux that browses local Codex conversations and Codex Cloud tasks alongside the Codex extension.

## Features

- Adds **Codex 对话管理器** to the Codex view container used by the installed Codex extension. It supports the current `codexSecondaryViewContainer` and the older `codexViewContainer`. If neither is available, the command and status-bar fallback open the manager in a webview panel.
- Shows the username from the current account's service-provided login email immediately after **Codex 对话管理器** in the view title, including when collapsed: `kongranwei@gmail.com` becomes `kongranwei`, without an account prefix. Account details and the account picker retain the full email. It updates with manual or five-minute account-usage refreshes and stays visible when quota data is unavailable. Loading, missing identifiers, unavailable accounts, and account-read failures are shown explicitly.
- Reads local history, summaries, names, status, working directories, account state, quota windows, and token activity through the Codex App Server over local stdio JSONL.
- Lists Codex Cloud tasks through `codex cloud list --json`, reloading the first page when the Cloud source is selected and preserving returned cursors and environment, summary, status, and URL fields. Cloud-only counts exclude local records; if the CLI returns no tasks, the manager explains which account/source to check.
- De-duplicates repeated records with the same thread ID within a source, including repeats returned on the same page; distinct threads with the same title remain separate.
- Filters by source and project/environment, searches titles and project names/paths, sorts by start/update/activity time, and loads metadata pages as needed. Project search opens matching choices as you type and defaults to the current workspace when a matching project is available. The project filter is disabled and ignored in cloud-only mode, while its previous selection is retained for local or combined views. Windows project paths merge case-only variants while POSIX paths retain case-sensitive identity.
- Opens local threads using their App Server thread ID and the `codex://threads/<thread-id>` URI. Cloud tasks only use a URL returned by the CLI.
- The compact view title uses **5h left** and **wk left** with percentages, reset clocks, and a final session-list refresh clock: `Codex 对话管理器 · kongranwei · 5h left 82%（00:00+1d） · wk left 38%（09:05+7d） · [15:00]`. Clocks use local 24-hour time; reset times omit the date and reset label, use no suffix today, and add `+1d` tomorrow or `+Nd` for later calendar days (`-Nd` for past days). Cached title text is recomputed every minute without extra network requests. Missing refresh time shows `[--:--]`. The native title API accepts plain text only, so the requested white-for-today/gray-for-older refresh clock coloring remains unsupported. The refresh action is in the expanded view toolbar and is available through the Command Palette. The current VS Code view API does not render view-title actions in the collapsed view row; the session-list timestamp remains in the title, but the refresh icon is not shown there. The session list refreshes at startup, on demand, after session changes, and every 15 minutes; the title timestamp updates when a refresh completes. The right side of the VS Code status bar shows the same remaining percentages with Chinese labels; its tooltip lists each quota window and full reset time, and clicking it opens account usage details. Account usage refreshes at startup, on demand, and every five minutes.
- The **账户用量** page labels the primary and weekly windows **5小时剩余** and **周剩余**, while retaining used percentages, exact reset times, and countdowns that update every minute. Its progress bars use blue for remaining quota and gray for used quota. Daily token activity can switch between a chronological line chart and the existing data list; chart dates and timestamp-based labels use Beijing time (`Asia/Shanghai`). The page also shows the available reset count returned by the Codex service and each available reset credit's expiration time in the local timezone; missing per-credit expiry data is labeled **服务未提供**.
- Windows local sessions can be opened in the ChatGPT desktop app or in the Codex VS Code extension's `/local/<thread-id>` route. Linux local sessions open through the Codex VS Code extension. Cloud tasks continue to use their returned URL.
- Every local conversation card has a searchable question dropdown that loads all user questions on demand. The Windows ChatGPT desktop and VS Code Codex buttons open the full conversation; on Linux, the VS Code Codex button is the available local-session route. They do not jump to a selected question. The details page keeps a paged transcript without repeating the question list.
- Supports local rename and confirmed permanent deletion through App Server methods. If another Codex client holds an active writer lock, deletion is safely rejected with steps to finish and close that session before refreshing and retrying.
- Uses the current-platform App Server CLI bundled with the installed ChatGPT/Codex VS Code extension by default (including `bin/linux-x86_64/codex` on Linux), with PATH fallback and a machine-scoped path override. It verifies App Server support and does not touch the IDE extension's development-only CLI setting.

## Saved accounts

Use the account icon beside the manager's refresh icon, or the compact account line below its heading. This entry is available on every tab and opens a searchable native menu. Choose **保存当前账户** to keep the current login, **添加其他账户…** to authorize another account once in the official browser flow, or an email to switch. Adding an account leaves the current login intact; login can be cancelled. Removing a saved copy preserves the active login and conversation history.

All saved accounts appear directly below this entry, together with the current account even when it has not been saved. Each row shows the full email and a compact quota summary such as `5h Left 48% (21:15) · Wk Left 75% (09:43+6d)`. The current CLI account has an arrow and larger white text; other accounts are gray. Rows wrap in narrow sidebars. Clicking another account asks for confirmation before switching and reloading. The marker identifies the CLI account; the existing Codex IDE confirmation status remains separate.

The list refreshes at startup, manually, and every five minutes. Current-account usage is reused; other saved accounts are queried through dedicated App Server processes in isolated temporary homes. Refreshed credentials are preserved in SecretStorage even if a later quota request fails, and the active login is not replaced. Background reads share the account operation lock; a requested account operation takes priority after the current isolated read and cleanup finish. Quota data remains in memory, hover text shows its last update, and reset-day suffixes update every minute from cached data. Missing, failed, loading, and expired-authorization states are explicit.

Switching validates the selected account, preserves renewed credentials, applies the official login cache, and reloads the current VS Code window. Finish running Codex tasks first; other clients sharing that Codex Home also need to reload. After reload the CLI account is checked again. The Codex extension does not expose its in-memory account to other extensions, so the UI says **CLI 已核验，Codex 待确认** until you use **核对 Codex 实际账户…**, enter the email actually shown in the Codex profile menu, and it matches the selected account and CLI. A CLI check alone is never labeled an automatic IDE verification.

Saved copies use VS Code SecretStorage; only account metadata is stored as ordinary local extension data. Temporary authorization files are restricted to the local user and cleaned up after the dedicated App Server process exits, with bounded retries for Windows file locks. Local process-exit or cleanup failures are reported separately from network and expired-login errors, preserving saved credentials and leaving the active login unchanged. This version supports ChatGPT file-based login on local Windows/Linux. Keyring/ephemeral storage, API keys or external auth environment variables, and WSL/remote IDE environments are not switched automatically. Invalid authorization or an unavailable network leaves the current account in place and offers reauthorization/retry. The extension does not change the official credential-store setting.

If saved emails remain but their encrypted copies cannot be read, the list reports **加密副本未读取**, rather than treating the login as expired. VS Code can fall back to memory-only secret storage when Linux keyring encryption is unavailable; a successful save/read in one window does not prove persistence across restart. Unlock the keyring and **fully exit all VS Code processes**, then restart; reloading a window is insufficient. On Secret Service desktops, VS Code's runtime arguments (`~/.vscode/argv.json` for the default installation) can select `"password-store": "gnome-libsecret"`; this is a host setup step, not a Codex credential-store change. See [VS Code keyring configuration](https://code.visualstudio.com/docs/configure/settings-sync#_recommended-configure-the-keyring-to-use-with-vs-code). Save the currently logged-in account again to rebuild its copy without browser authorization. Missing copies of other accounts must be added again only if they remain unavailable after restoring secure storage. All credential writes are read back before claiming success; this checks the current session only. Switching to the already active account and post-reload verification can also recover its copy after checking both email and account ID.

## Requirements

- VS Code
- The OpenAI Codex extension (`openai.chatgpt`)
- The OpenAI Codex extension's bundled CLI, a Codex CLI available on `PATH`, or a selected executable from **Sponge: 配置 Codex CLI 路径**

The account-management feature reads and restores the official file login cache locally only for user-requested saved-account operations and post-switch checks; encrypted copies stay in SecretStorage. It never reads passwords or cookies, sends credentials to the webview, or uploads credentials to a developer server. Conversation and quota data continue through the official CLI/App Server in the local extension host. Codex Cloud data is requested from the official CLI only while the cloud source is loaded.

## Build and install

    npm install
    npm run compile
    npm run package
    code --install-extension ./codex-conversation-manager-0.2.31.vsix --force

Open the Codex view container and choose **Codex 对话管理器**. If the Codex container cannot be detected, run **Sponge: 打开 Codex 对话管理器** from the Command Palette.

The CLI discovery check verifies bundled-extension, PATH, and explicit-override precedence. The live CLI smoke check requires an available Codex CLI and a signed-in Codex account:

    npm run check:webview
    npm run check:accounts
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
