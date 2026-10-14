# AGENTS.md

## Project guidance

- `AGENT.md` is the product requirements document. Keep it as the source of feature and acceptance requirements.
- This file records implementation decisions and the project's maintenance history; do not replace the requirements in `AGENT.md` with summaries here.
- For every future change to source code, configuration, dependencies, build scripts, or packaged behavior, append a dated entry under **Change log** in the same work session. Include the affected areas, the behavior changed, checks actually run and their results, and whether a VSIX was installed. Record failed or skipped checks accurately.
- When a change affects product requirements, update `AGENT.md` as well as recording the implementation here.

## Change log

### 2026-10-12 — 0.2.24: Show the expiration of each reset credit

- Updated `src/dataService.ts` and `src/types.ts` to normalize the expiry timestamp for each reset credit whose service status is `available`. Epoch-second and ISO timestamps use the existing timestamp normalization; missing expiry fields remain unavailable instead of being inferred from the aggregate count.
- Updated `src/view.ts` to list every available reset credit and its expiration time in the machine's local timezone under “重置次数”. When the service returns a count but no per-credit details, the page says that expiry details were not provided; zero available credits get a separate empty state.
- Added `scripts/check-reset-credits.cjs` and `npm run check:reset-credits` for normalization/filtering coverage. Expanded the webview check for per-credit rows and missing-data states, and the live CLI smoke output for returned credit/expiry counts. Updated FR-04 and acceptance criterion 6 in `AGENT.md`, the README, and bumped `package.json` / `package-lock.json` to 0.2.24.
- Verification passed: `npm.cmd run compile`, `node scripts/check-webview-script.cjs`, `node scripts/check-session-manager.cjs`, `node scripts/check-quota-status-and-links.cjs`, `node scripts/check-reset-credits.cjs`, `node scripts/check-cli-discovery.cjs`, and `npm.cmd run smoke:cli`. The live smoke used the ChatGPT-bundled CLI, initialized App Server, read local transcript data, returned zero Cloud tasks, read one quota window and 3 available reset credits with 3 expiry timestamps, and confirmed workspace `error.log` unchanged. `npm.cmd run package` succeeded with VSCE's missing-LICENSE warning.
- Installed `codex-conversation-manager-0.2.24.vsix` through VS Code CLI and confirmed `sponge.codex-conversation-manager@0.2.24`. The account-usage UI was not visually exercised; reload an already open VS Code window to activate the new version.

### 2026-09-29 — 0.2.23: Use Beijing dates in the daily token chart

- Updated `src/view.ts` so daily token chart ordering, axis labels, point tooltips, and chart accessibility text use Beijing time (`Asia/Shanghai`). Timestamps with explicit time zones convert to the Beijing calendar date; date-only or timezone-free values preserve their service-provided calendar date. The account-usage note identifies the chart timezone.
- Added `scripts/check-webview-script.cjs` coverage for the timezone setting, the UTC-to-Beijing midnight boundary, ordering, axis labels, and point tooltips. Updated FR-04 and acceptance criterion 6 in `AGENT.md`, documented the chart timezone in `README.md`, and bumped `package.json` / `package-lock.json` to 0.2.23.
- Verification passed: `npm.cmd run compile`, `npm.cmd run check:webview`, `npm.cmd run check:sessions`, `npm.cmd run check:quota-status-and-links`, `npm.cmd run check:cli-discovery`, and `npm.cmd run smoke:cli`. Initial webview-check runs failed because the embedded script's template literal consumed regex backslashes and the assertion expected ASCII parentheses; the date patterns were changed to digit classes, the assertion was corrected, and the final run passed. The live smoke used the ChatGPT-bundled CLI, initialized App Server, read local list/transcript data, returned zero Cloud tasks, read available quota data with 2 reset credits, and confirmed workspace `error.log` unchanged. `npm.cmd run package` succeeded with VSCE's missing-LICENSE warning.
- Installed `codex-conversation-manager-0.2.23.vsix` through VS Code CLI and confirmed `sponge.codex-conversation-manager@0.2.23`. The UI was not visually exercised; reload an already open VS Code window to activate the new version.

### 2026-09-29 — 0.2.22: De-duplicate repeated session IDs

- Investigated local App Server results for `D:\code\transformers`: the first page returned 8 rows representing 4 thread IDs, with one ID repeated 5 times. Fixed `SessionManager.addUnique()` to add each accepted key to the in-page set as it appends, so duplicate IDs are removed within a page as well as across pages. Distinct threads with the same title remain visible.
- Added a regression case in `scripts/check-session-manager.cjs` for same-page duplicate IDs under `D:\code\transformers`, while retaining a same-title record with a different ID. Updated FR-02 and acceptance criterion 3 in `AGENT.md`, documented de-duplication in `README.md`, and bumped `package.json` / `package-lock.json` to 0.2.22.
- Verification passed: `npm.cmd run compile`, `npm.cmd run check:webview`, `npm.cmd run check:sessions`, `npm.cmd run check:quota-status-and-links`, `npm.cmd run check:cli-discovery`, and `npm.cmd run smoke:cli`. The live smoke used the ChatGPT-bundled CLI, initialized App Server, read local list/transcript data, returned zero Cloud tasks, read available quota data and 2 reset credits, and confirmed workspace `error.log` unchanged. `npm.cmd run package` succeeded with VSCE's missing-LICENSE warning.
- Installed `codex-conversation-manager-0.2.22.vsix` through VS Code CLI and confirmed `sponge.codex-conversation-manager@0.2.22`. The UI was not visually exercised; reload an already open VS Code window to activate the newly installed version.

### 2026-09-29 — 0.2.21: Refresh the session list every 15 minutes

- Added a 15-minute session-list refresh timer in `src/autoRefresh.ts` and `src/extension.ts`. Completed refreshes continue through `SessionManager`'s change notification into the manager title timestamp. Concurrent list refresh requests share the same in-flight request, and a failed scheduled refresh is logged without stopping later intervals. Account usage keeps its separate five-minute schedule. Updated `.vscodeignore` to exclude root log files from packages after the VS Code CLI generated a workspace `debug.log` during installation.
- Updated `scripts/check-session-manager.cjs` to verify the 15-minute interval, non-overlapping timer behavior, retry after refresh failure, timestamp propagation after scheduled refresh, and concurrent refresh coalescing. Updated `AGENT.md`, `README.md`, and package version to 0.2.21.
- Verification passed: `npm.cmd run compile`, `npm.cmd run check:webview`, `npm.cmd run check:sessions`, `npm.cmd run check:quota-status-and-links`, and `npm.cmd run check:cli-discovery`. The CLI smoke initialized the ChatGPT-bundled App Server and read the local thread list/transcript, then failed at `codex cloud list` because the CLI is not signed in; quota smoke assertions and the final `error.log` integrity assertion were therefore not reached. The first invocation through `npm` was blocked by the PowerShell execution policy; rerunning through `npm.cmd` passed. `npm.cmd run package` succeeded with VSCE's existing missing-LICENSE warning. The first package build after installation included the CLI-generated `debug.log`; `.vscodeignore` was updated and the final package was rebuilt without workspace log files.
- Installed `codex-conversation-manager-0.2.21.vsix` through VS Code CLI after the default sandbox blocked the user-profile write; the authorized install completed and `code --list-extensions --show-versions` confirmed `sponge.codex-conversation-manager@0.2.21`. The UI was not visually exercised; reload an already open VS Code window to activate the newly installed version.

### 2026-09-29 — 0.2.20: Add a daily token line chart view

- Updated `src/view.ts` so the daily token section defaults to an accessible SVG line chart with a “折线图 / 数据列表” toggle. The chart sorts by date, plots the latest 30 days, exposes each valid point's date and token count on hover, and leaves gaps where the service omitted values. Updated `scripts/check-webview-script.cjs` to cover chronology, the 30-day limit, missing-value gaps, empty data, and escaped labels. Updated the FR-04 requirements in `AGENT.md`, documented the toggle in `README.md`, and bumped `package.json` / `package-lock.json` to 0.2.20.
- Verification passed: `npm run compile`, `node scripts/check-webview-script.cjs`, `node scripts/check-session-manager.cjs`, `node scripts/check-quota-status-and-links.cjs`, `node scripts/check-cli-discovery.cjs`, and `npm run smoke:cli`. The first two webview-check runs failed because new assertions expected different source formatting and empty-state wording; the assertions were corrected and the final run passed. The live smoke initialized the ChatGPT-bundled App Server, read local transcript and quota data, returned zero Cloud tasks, and left the workspace `error.log` unchanged.
- `npm run package` succeeded (VSCE warned that the project has no LICENSE file). Installed `codex-conversation-manager-0.2.20.vsix` through VS Code CLI and confirmed `sponge.codex-conversation-manager@0.2.20`. The account-usage UI was not visually exercised.

### 2026-09-29 — 0.2.19: Show remaining quota in blue

- Updated `src/view.ts` so the “5小时剩余” and “周剩余” progress bars use blue for remaining quota and gray for used quota. The displayed used percentages, reset times, and countdowns remain available. Updated the acceptance criteria in `AGENT.md`, documented the colors and installation command in `README.md`, added webview regression assertions, and bumped `package.json` / `package-lock.json` to 0.2.19.
- Verification passed: `npm run compile`, `node scripts/check-webview-script.cjs`, `node scripts/check-session-manager.cjs`, `node scripts/check-quota-status-and-links.cjs`, `node scripts/check-cli-discovery.cjs`, and `npm run smoke:cli`. The live smoke initialized the ChatGPT-bundled App Server, read local transcript and quota data, returned zero Cloud tasks, and left the workspace `error.log` unchanged.
- `npm run package` succeeded (VSCE warned that the project has no LICENSE file). Installed `codex-conversation-manager-0.2.19.vsix` through VS Code CLI and confirmed `sponge.codex-conversation-manager@0.2.19`. The account-usage UI was not visually exercised.

### 2026-09-28 — 0.2.18: Refresh cloud tasks when selecting Cloud

- Updated `src/sessionManager.ts` to discard the cached first Cloud page and request it again when switching into the Cloud source. The manager now reports the loaded count for the selected source instead of combining Cloud counts with local records. Updated `src/view.ts` with a Cloud-specific empty state that points to the CLI account/task source when no search matches and no CLI error occurred.
- Added regression coverage in `scripts/check-session-manager.cjs` for a Cloud task created after startup and for excluding local records from the Cloud-only count; updated `scripts/check-webview-script.cjs` to verify the Cloud empty-state guidance. Updated `AGENT.md`, `README.md`, and package version `0.2.18`.
- Verification passed: `npm run compile`, `node scripts/check-webview-script.cjs`, `node scripts/check-session-manager.cjs`, `node scripts/check-quota-status-and-links.cjs`, `node scripts/check-cli-discovery.cjs`, and `node scripts/smoke-cli-shim.cjs`. The live smoke initialized the ChatGPT-bundled App Server and read local transcript/quota data, but the signed-in Cloud list currently returned zero tasks; it reported the workspace `error.log` unchanged. The session-manager regression supplied a task after startup and confirmed it appears when Cloud is selected.
- `npm run package` succeeded (VSCE warned that the project has no LICENSE file). Installed `codex-conversation-manager-0.2.18.vsix` through VS Code CLI and confirmed `sponge.codex-conversation-manager@0.2.18`. The manager UI was not visually exercised.

### 2026-09-28 — 0.2.17: Explain active-writer conflicts during deletion

- Updated `src/dataService.ts` to translate Codex App Server's `already has an active writer` deletion error into Chinese guidance identifying the locked thread and explaining how to finish and close the session in ChatGPT Windows, VS Code Codex, or Codex CLI, then refresh and retry. Other errors remain unchanged; the manager does not bypass writer locks or modify session files.
- Updated `scripts/check-session-manager.cjs` to cover the conflict-specific guidance and confirm a rejected deletion leaves the local record visible. Updated FR-06 and its acceptance criterion in `AGENT.md`, the README, and package version `0.2.17`.
- Verification passed: `npm run compile`, `node scripts/check-webview-script.cjs`, `node scripts/check-session-manager.cjs`, `node scripts/check-quota-status-and-links.cjs`, `node scripts/check-cli-discovery.cjs`, and `node scripts/smoke-cli-shim.cjs`. The live smoke used the ChatGPT-bundled CLI, initialized App Server, read local and Cloud lists and transcript/quota data, and reported the workspace `error.log` unchanged.
- `npm run package` succeeded (VSCE warned that the project has no LICENSE file). Installed `codex-conversation-manager-0.2.17.vsix` through VS Code CLI and confirmed `sponge.codex-conversation-manager@0.2.17`. The manager UI was not visually exercised, and the user's active thread was not deleted during testing.

### 2026-09-28 — 0.2.16: Remove ineffective global header-action default

- Removed `configurationDefaults.workbench.view.alwaysShowHeaderActions = true`. Inspection confirmed the installed 0.2.15 package contains this default and the user's VS Code settings do not explicitly override it, yet collapsed view rows still omit title actions. The setting controls hover/focus visibility for view-header actions; it does not make a collapsed row render them. Removing it avoids changing all views without solving the requested collapsed-bar button.
- Updated `AGENT.md` and `README.md` to record the current host limitation and keep the collapsed-bar refresh icon as an unresolved requirement. Updated the title-action regression check and package version to 0.2.16.
- Verification passed: `npm run compile`, `node scripts/check-webview-script.cjs`, `node scripts/check-session-manager.cjs`, `node scripts/check-quota-status-and-links.cjs`, and `node scripts/check-cli-discovery.cjs`. The CLI smoke was not rerun because the 0.2.15 smoke reported that Codex CLI was not signed in.
- `npm run package` succeeded (VSCE warned that the project has no LICENSE file). Installed `codex-conversation-manager-0.2.16.vsix` through VS Code CLI and confirmed `sponge.codex-conversation-manager@0.2.16`. The folded view was not visually exercised.

### 2026-09-28 — 0.2.15: Keep refresh action visible on a collapsed manager

- Added `configurationDefaults.workbench.view.alwaysShowHeaderActions = true` so the existing refresh action remains visible when the Codex manager view is collapsed. Explicit user settings take precedence. This default also keeps title actions visible in other views, because VS Code exposes this behavior as a workbench-wide setting rather than an extension-specific view option.
- Updated `AGENT.md`, `README.md`, the manifest regression check, and package version `0.2.15`.
- Verification passed: `npm run compile`, `node scripts/check-webview-script.cjs`, `node scripts/check-session-manager.cjs`, `node scripts/check-quota-status-and-links.cjs`, and `node scripts/check-cli-discovery.cjs`. `node scripts/smoke-cli-shim.cjs` did not pass because the available Codex CLI reported that it is not signed in; no login was attempted.
- `npm run package` succeeded (VSCE warned that the project has no LICENSE file). Installed `codex-conversation-manager-0.2.15.vsix` through VS Code CLI and confirmed `sponge.codex-conversation-manager@0.2.15`. The UI was not visually exercised; a window reload may be needed for the contributed default setting to take effect.

### 2026-09-28 — 0.2.14: Keep refresh time visible beside the collapsed manager toolbar

- Changed `src/view.ts` and `src/quotaStatusBar.ts` to append the latest session-list refresh time to the manager view title itself, immediately before the title-bar refresh action. The native refresh action remains in the right-side navigation group, so the timestamp and refresh control remain available with the view collapsed. Updated the title-format regression check, `AGENT.md`, `README.md`, and `package.json` / `package-lock.json` to 0.2.14.
- Verification passed: `npm run compile`, `npm run check:webview`, `npm run check:sessions`, `npm run check:quota-status-and-links`, `npm run check:cli-discovery`, and `npm run smoke:cli`. The smoke used the ChatGPT-bundled CLI, initialized App Server, returned local/cloud and quota data, and reported the workspace `error.log` unchanged.
- `npm run package` succeeded (VSCE warned that the project has no LICENSE file). Installed `codex-conversation-manager-0.2.14.vsix` through VS Code CLI and confirmed `sponge.codex-conversation-manager@0.2.14` in the installed extension list. The collapsed view was not visually exercised.

### 2026-09-28 — 0.2.13: Remove question jump action and show refresh time

- Removed the per-card “定位所选问题” button and its request, transcript scroll, and highlight path from `src/view.ts` and `src/extension.ts`. Searchable question selection remains; ChatGPT Windows and VS Code Codex actions open the whole thread.
- Added `listRefreshedAt` to `ManagerSnapshot`, set it after initial or manual session-list loads in `src/sessionManager.ts`, and show the local date/time in the Codex manager view description. Kept the title-bar refresh icon and placed it first in the navigation action group so it remains available while collapsed. Account usage continues its five-minute automatic refresh.
- Updated `AGENT.md`, `README.md`, package version `0.2.13`, and webview/session/title regression checks.
- Verification passed: `npm run compile`, `npm run check:webview`, `npm run check:sessions`, `npm run check:quota-status-and-links`, `npm run check:cli-discovery`, and `npm run smoke:cli`. The smoke used the ChatGPT-bundled CLI, initialized App Server, returned local/cloud and quota data, and reported the workspace `error.log` unchanged.
- `npm run package` succeeded (VSCE warned that the project has no LICENSE file). Installed `codex-conversation-manager-0.2.13.vsix` through VS Code CLI and confirmed `sponge.codex-conversation-manager@0.2.13`. The view was not visually exercised.

### 2026-09-28 — 0.2.12: Precisely locate selected questions in the manager

- Updated `src/view.ts` with a per-card “定位所选问题” action that stays disabled until a question is selected. The action requests the local transcript, opens the manager's conversation reader at the selected user message, shows its surrounding ten-turn page, centers it in view, highlights it, and restores focus to the card action when the reader closes. The external ChatGPT Windows and VS Code Codex buttons continue opening the whole thread.
- Updated `src/extension.ts` to validate the selected local question index and return it with the session details. Updated `scripts/check-webview-script.cjs` to verify selection enables the action and the exact target page/message is rendered, centered, and highlighted.
- Updated `AGENT.md`, `README.md`, and package version `0.2.12` in `package.json` and `package-lock.json`.
- Verification passed: `npm run compile`, `npm run check:webview`, `npm run check:sessions`, `npm run check:quota-status-and-links`, `npm run check:cli-discovery`, and `npm run smoke:cli`. The smoke used the ChatGPT-bundled CLI, initialized App Server, returned local transcript/question data and quota data, and reported the workspace `error.log` unchanged.
- `npm run package` succeeded (VSCE warned that the project has no LICENSE file). Installed `codex-conversation-manager-0.2.12.vsix` through VS Code CLI and confirmed `sponge.codex-conversation-manager@0.2.12`. Visual interaction with the VS Code Codex extension was not exercised because the computer-use skill prohibits automating Codex extensions inside Windows apps.

### 2026-09-28 — 0.2.11: Move question search to conversation cards

- Added `SessionManager.listQuestions()` to read every local user message on demand and return only the question text and turn timestamp for the selected session. `src/extension.ts` serves these results to the matching card; Cloud sessions continue to show that the full question list is unavailable.
- Updated `src/view.ts` with an accessible, searchable question dropdown on each local session card. Selecting an item shows which question is selected; the existing ChatGPT Windows and VS Code Codex buttons still open the whole session. The question directory and message-jump controls were removed from the details view, which retains its paged transcript.
- Updated `AGENT.md`, `README.md`, `scripts/check-webview-script.cjs`, `scripts/check-session-manager.cjs`, and `scripts/smoke-cli-shim.cjs`; bumped `package.json` and `package-lock.json` to 0.2.11.
- Verification passed: `npm run compile`, `npm run check:webview`, `npm run check:sessions`, `npm run check:quota-status-and-links`, `npm run check:cli-discovery`, and `npm run smoke:cli`. The live smoke used the ChatGPT-bundled CLI, initialized App Server, read a local question list, and reported the workspace `error.log` unchanged.
- `npm run package` succeeded (VSCE warned that the project has no LICENSE file). Installed `codex-conversation-manager-0.2.11.vsix` through VS Code CLI and confirmed `sponge.codex-conversation-manager@0.2.11`. Visual interaction with the VS Code Codex extension was not exercised because the computer-use skill prohibits automating Codex extensions inside Windows apps.

### 2026-09-28 — 0.2.10: Ignore project filtering in cloud-only mode

- Updated `src/sessionManager.ts` so a saved project/environment filter is ignored while the source is set to Cloud. The selection remains intact and is restored for combined/local views; project changes are ignored during cloud-only mode.
- Updated `src/view.ts` to disable the project/environment search control in cloud-only mode, close and clear its dropdown, and explain that the saved selection returns when switching back to “全部” or “本地”.
- Updated `AGENT.md`, `README.md`, and package version `0.2.10`. Added regression checks for cloud results with a retained local project filter and for the disabled project picker in `scripts/check-session-manager.cjs` and `scripts/check-webview-script.cjs`.
- Verification passed: `npm run check:webview`, `npm run check:sessions`, `npm run check:quota-status-and-links`, `npm run check:cli-discovery`, and `npm run smoke:cli`. The live smoke used the ChatGPT-bundled CLI and left the workspace `error.log` unchanged.
- `npm run package` succeeded (VSCE warned that the project has no LICENSE file). Installed `codex-conversation-manager-0.2.10.vsix` through VS Code CLI and confirmed `sponge.codex-conversation-manager@0.2.10`. The view was not interactively exercised.

### 2026-09-28 — 0.2.9: Search questions and navigate local conversation history

- Updated `src/dataService.ts` and `src/sessionManager.ts` to request local thread turns only when opening details and normalize them to ordered user messages plus visible Codex replies. Tool output, reasoning items, attachment payloads, and non-visible assistant phases are excluded; text and attachment placeholders remain searchable.
- Updated `src/view.ts` with a searchable question directory, highlighted matches, keyboard navigation, focus return, and a split conversation reader. Selecting a question jumps to and highlights its message; the reader pages ten turns at a time for long conversations. Cloud details continue to show only supported summary fields.
- Updated `AGENT.md`, `README.md`, and package version `0.2.9`. Added regression coverage for question search/highlighting, transcript normalization, tool/reasoning exclusion, and live App Server detail reads in `scripts/check-webview-script.cjs`, `scripts/check-session-manager.cjs`, and `scripts/smoke-cli-shim.cjs`.
- Verification passed: `npm run check:webview`, `npm run check:sessions`, `npm run check:quota-status-and-links`, `npm run check:cli-discovery`, and `npm run smoke:cli`. The smoke used the ChatGPT-bundled CLI, confirmed App Server `thread/read` returned a turn and user question, and did not change the workspace `error.log`. The webview check initially exposed a template-literal regex escape issue; it was corrected and the final run passed. An earlier test-harness run also needed the HTML escaper injected into its isolated function scope; that harness was corrected.
- `npm run package` succeeded (VSCE warned that the project has no LICENSE file). Installed `codex-conversation-manager-0.2.9.vsix` through VS Code CLI and confirmed `sponge.codex-conversation-manager@0.2.9`. The installed manager UI was not interactively exercised.

### 2026-09-28 — 0.2.8: Show quota reset times in manager title

- Updated `src/quotaStatusBar.ts` so the Codex conversation manager view title shows each window's remaining percentage and corresponding reset date/time. Missing quota or reset data remains explicit; the compact status-bar item still shows both remaining percentages, with per-window reset times in its tooltip.
- Removed the detect, configure, verify, and clear CLI actions from the manager's `view/title` menu in `package.json`; kept the refresh action. The CLI management commands and buttons remain available in the Command Palette and “CLI / 环境” page.
- Updated `AGENT.md`, `README.md`, quota/menu checks, and bumped `package.json` / `package-lock.json` to 0.2.8.
- Verification passed: `npm run check:quota-status-and-links`, `npm run check:webview`, `npm run check:cli-discovery`, and `npm run smoke:cli`. The live smoke initialized the ChatGPT-bundled App Server and produced manager title text with both reset dates/times.
- `npm run package` succeeded (VSCE warned that the project has no LICENSE file). Installed `codex-conversation-manager-0.2.8.vsix` through VS Code CLI and confirmed `sponge.codex-conversation-manager@0.2.8` in the installed extension list. The VS Code view was not visually exercised.

### 2026-09-28 — 0.2.7: Default to the workspace project and show live search results

- `src/extension.ts` now identifies the active editor's workspace folder (falling back to the first workspace folder) and passes it to `SessionManager`. `src/sessionManager.ts` selects the matching project on startup when it appears in local conversation metadata, scanning older local pages within the existing page-scan limit. If no match exists it leaves the project filter clear; WSL/remote workspaces do not apply a host-mismatched default path.
- Replaced the project `<select>` with an accessible combobox/listbox in `src/view.ts`. Focusing or typing immediately opens matching project choices; choosing a result applies the project filter, Escape closes the list, and Arrow Down moves focus to the choices.
- Updated `AGENT.md`, `README.md`, project-manager/webview checks, and bumped `package.json` / `package-lock.json` to 0.2.7. Added checks for current-workspace defaults, deep-page discovery, fallback when no project matches, and live dropdown result rendering.
- Verification passed: `npm run check:webview`, `npm run check:sessions`, `npm run check:quota-status-and-links`, `npm run check:cli-discovery`, and `npm run smoke:cli`. Initial webview-check runs failed because assertions looked for HTML roles in the script block and then used an incorrectly escaped path regex; the assertions were corrected to inspect rendered HTML and string content, and the final run passed. The live smoke initialized the ChatGPT-bundled App Server successfully.
- `npm run package` succeeded (VSCE warned that the project has no LICENSE file). Installed `codex-conversation-manager-0.2.7.vsix` through VS Code CLI and confirmed `sponge.codex-conversation-manager@0.2.7` in the installed extension list. VS Code UI rendering was not visually exercised.

### 2026-09-28 — 0.2.6: Search projects and merge Windows path variants

- Added a project/environment search box in `src/view.ts`; typing filters the selectable options case-insensitively without changing the active project filter. The Command Palette project picker uses the same normalized project list.
- Updated `src/sessionManager.ts` to merge Windows drive and UNC paths by case-insensitive identity, display drive letters in uppercase, and apply the same identity when filtering records. POSIX paths and non-path labels retain exact identity, so case-sensitive POSIX paths remain distinct.
- Updated `AGENT.md`, `README.md`, project/webview checks, and bumped `package.json` / `package-lock.json` to 0.2.6.
- Verification passed: `npm run check:webview`, `npm run check:sessions`, `npm run check:quota-status-and-links`, `npm run check:cli-discovery`, and `npm run smoke:cli`. The session-manager check initially failed because its expected project-list ordering did not match locale sorting; the assertion was corrected to verify membership and deduplication, and the rerun passed. The live CLI smoke used the ChatGPT-bundled CLI and confirmed App Server operation.
- `npm run package` succeeded (VSCE warned that the project has no LICENSE file). Installed `codex-conversation-manager-0.2.6.vsix` through VS Code CLI and confirmed `sponge.codex-conversation-manager@0.2.6` in the installed extension list. VS Code UI rendering was not visually exercised.

### 2026-09-28 — 0.2.5: Show reset credits and explicit quota labels

- Updated `src/quotaStatusBar.ts` so the manager title and right-aligned status item use the full “5小时剩余” and “周剩余” labels, including when a percentage is unavailable.
- Confirmed the local ChatGPT-bundled App Server returns `rateLimitResetCredits.availableCount` (2 in the live check, with two `codexRateLimits` credits in `available` state). Normalized this service field in `src/dataService.ts` / `src/types.ts` and added a “可用重置次数” value to the account-usage page; missing, invalid, or negative counts display “服务未提供”.
- Updated `AGENT.md` FR-04 and acceptance criteria, `README.md`, webview/status-bar checks, and the CLI smoke output. Bumped `package.json` and `package-lock.json` to 0.2.5.
- Verification passed: `npm run check:webview`, `npm run check:quota-status-and-links`, `npm run check:sessions`, `npm run check:cli-discovery`, and `npm run smoke:cli`. The live smoke used the ChatGPT-bundled CLI, initialized App Server, returned quota and reset-count data, and left the workspace `error.log` unchanged.
- `npm run package` succeeded (VSCE warned that the project has no LICENSE file). Installed `codex-conversation-manager-0.2.5.vsix` through VS Code CLI and confirmed `sponge.codex-conversation-manager@0.2.5` in the installed extension list. The VS Code view was not visually exercised.

### 2026-09-28 — 0.2.4: Label remaining quota in account usage

- Updated `src/view.ts` so the primary and secondary account-usage windows are labeled “5小时剩余” and “周剩余” and show remaining percentages derived from the service's used percentages. The used percentages remain visible, and progress bars still represent usage. Existing reset timestamps and minute-updated countdowns remain alongside each window.
- Updated `AGENT.md`, `README.md`, and `scripts/check-webview-script.cjs`; bumped `package.json` and `package-lock.json` to 0.2.4.
- Verification passed: `npm run check:webview` (script syntax, countdown formatting, labels, and remaining-percentage calculation) and `npm run check:quota-status-and-links` (including TypeScript compilation).
- `npm run package` succeeded (VSCE warned that the project has no LICENSE file). Installed `codex-conversation-manager-0.2.4.vsix` through VS Code CLI and confirmed version 0.2.4 in the extension list. The account-usage page was not visually exercised in this run.

### 2026-09-28 — 0.2.3: Show quota reset times and countdowns

- Updated the account-usage renderer in `src/view.ts` to show each quota window's exact reset time plus a remaining-time countdown. The countdown refreshes every minute, handles expired reset timestamps explicitly, and shows “服务未提供” when the App Server omits `resetsAt`.
- Updated `AGENT.md` FR-04 and its acceptance criteria, and documented the reset countdown in `README.md`. The current service data includes reset timestamps but no cumulative/remaining reset-count field, so the UI does not invent a count.
- Verification passed: `npm run check:webview` (webview syntax and countdown formatting cases) and `npm run check:quota-status-and-links` (including TypeScript compilation).
- `npm run package` succeeded (VSCE warned that the project has no LICENSE file). Installed `codex-conversation-manager-0.2.3.vsix` through VS Code CLI and confirmed version 0.2.3 in the extension list. The account-usage page was not visually exercised in this run.

### 2026-09-28 — 0.2.2: Fix collapsed quota visibility and Codex IDE routing

- Changed `src/view.ts` to update `WebviewView.title` itself, so the collapsed manager heading includes both the five-hour and weekly quota values. `src/quotaStatusBar.ts` now shows both windows in the title and right-aligned status item, computes the lowest remaining value separately for primary and secondary windows, and keeps missing values explicit. The status-item tooltip still lists every window and reset time.
- Changed `src/links.ts` to route local sessions through `vscode://<extension-id>/local/<thread-id>` and report an error when the thread ID is not a UUID. Verified against the installed `openai.chatgpt` 26.5917.62051 package: its URI handler forwards `uri.path` to the webview router, whose local conversation route is `/local/:conversationId`. This replaces the unsupported `/threads/<thread-id>` path that caused an empty Codex view.
- Updated `AGENT.md`, `README.md`, quota/link checks, and the live CLI smoke check; bumped `package.json` and `package-lock.json` to 0.2.2.
- Verification passed: `npm run check:quota-status-and-links`, `npm run check:webview`, `npm run check:sessions`, `npm run check:cli-discovery`, and `npm run smoke:cli`. The live smoke initialized the bundled App Server, read local and Cloud sources, returned both quota windows, and left the workspace `error.log` unchanged.
- `npm run package` succeeded (VSCE warned that the project has no LICENSE file). Installed `codex-conversation-manager-0.2.2.vsix` through VS Code CLI and confirmed version 0.2.2 in the extension list. The view and real session navigation were not visually exercised in this run.

### 2026-09-28 — 0.2.1: Show quota beside the manager title

- Updated `src/view.ts` to show the live quota state in the Codex conversation manager view title description. The text remains visible when the view is collapsed; loading, unavailable, and error states are explicit. The right-aligned status-bar item remains as a persistent fallback and usage-page entry point.
- Updated `src/quotaStatusBar.ts` and `scripts/check-quota-status-and-links.cjs` to format and verify the view-title text alongside the existing status-bar label and tooltip.
- Updated `AGENT.md` and `README.md` to document both indicator locations, and bumped `package.json` / `package-lock.json` to 0.2.1.
- Verification passed: `npm run check:quota-status-and-links` and `npm run check:webview`. `npm run package` succeeded; VSCE reported that no LICENSE file is present.
- Installed `codex-conversation-manager-0.2.1.vsix` through VS Code CLI and confirmed `sponge.codex-conversation-manager@0.2.1` in the installed extension list. The actual VS Code view was not visually exercised in this run.

### 2026-09-28 — 0.2.0: Quota status-bar indicator and VS Code thread navigation

- Updated `AGENT.md` requirements FR-05 and FR-10 and `README.md` to cover opening local sessions in the Codex VS Code extension and keeping quota remaining visible when the manager view is collapsed.
- Added `src/quotaStatusBar.ts`: the right-aligned status item shows the lowest remaining percentage across available quota windows, lists each window and reset time in its tooltip, opens the usage page when clicked, and refreshes on startup/manual refresh and every five minutes. Missing percentages remain unknown instead of showing 0%.
- Added `src/links.ts` and local-session actions in the list and details modal to route the actual thread ID through the installed `openai.chatgpt` extension URI handler. Cloud sessions do not use the local IDE route.
- Added `scripts/check-quota-status-and-links.cjs`; expanded the live CLI smoke check to read actual quota data without printing account identifiers, and to dispose the App Server after use. The first quota smoke printed valid data but stayed alive because the service was not disposed; cleanup was added and the rerun exited normally.
- Bumped `package.json` and `package-lock.json` to 0.2.0.
- Verification passed: `npm run check:quota-status-and-links`, `npm run check:webview`, `npm run check:sessions`, `npm run check:cli-discovery`, and `npm run smoke:cli`. The live smoke check returned one local thread, a valid quota window, a 75% lowest remaining indicator at test time, and no workspace `error.log` changes.
- Packaged `codex-conversation-manager-0.2.0.vsix`, installed it through VS Code CLI, and confirmed `sponge.codex-conversation-manager@0.2.0` in the installed extension list.
- The installed VS Code UI was not interactively exercised: automated checks cover quota rendering data and IDE URI construction, but not the final visual placement or route navigation in the webview.

### 2026-09-28 — 0.1.1: Default to the ChatGPT/Codex bundled App Server CLI

- `src/cli.ts` now discovers `codex.exe` from the installed `openai.chatgpt` VS Code extension through the VS Code extension API. With no explicit `sponge.codexCliPath`, resolution order is the bundled CLI first, then `PATH`; an explicit user path remains the override.
- `src/types.ts`, `src/extension.ts`, and `src/view.ts` report the selected source and show the bundled CLI as the default. The CLI screen and missing-CLI guidance explain the available discovery paths.
- Added `scripts/check-cli-discovery.cjs` and the `check:cli-discovery` command for bundled/override/PATH precedence. Updated the CLI smoke script to exercise the bundled executable and the `.cmd` shim path.
- Updated `README.md`, `package.json`, and `package-lock.json` for version 0.1.1 and its default discovery behavior.
- Verification passed: `npm run check:cli-discovery`, `npm run check:webview`, `npm run check:sessions`, and `npm run smoke:cli`. The smoke run initialized App Server, returned one local thread, parsed the Cloud page (zero tasks returned), and confirmed the workspace `error.log` was unchanged. The smoke run was repeated against the Codex extension version listed as installed by VS Code (`26.5917.62051`).
- Packaged `codex-conversation-manager-0.1.1.vsix`, installed it with VS Code CLI, and confirmed `sponge.codex-conversation-manager@0.1.1` in the installed extension list.

### 2026-09-28 — 0.1.0: Initial implementation

- Implemented the Windows-first VS Code conversation manager described by `AGENT.md`: local conversations via Codex App Server, Cloud task listing via the Codex CLI, source/project filters, search, sorting, paging, details, local rename/deletion, account usage, CLI configuration/verification, and opening conversations through supported links.
- Registered the manager in the Codex extension's view container with a visible fallback when that container cannot be located. Added CLI, App Server, data service, session management, webview, and smoke/check scripts.
- Verification passed: TypeScript compilation, webview syntax, session-manager checks, and the CLI/App Server smoke test. Packaged and installed version 0.1.0 through VS Code CLI.
