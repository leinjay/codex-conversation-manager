# ZW3D 二次开发

在 VS Code 左侧活动栏中初始化、编译、部署、运行和调试 Linux 中望 3D 插件。
初始模板从 `/home/winnie/project/apiDemo` 的 CMake 和目录约定抽取，改为简单的 C++ 问候命令；
不依赖该参考工程的绝对路径，不复制其编译产物、本地工具链或长方体业务。

## 安装与体验

```sh
cd zw3d-customization-develop
npm ci
npm test
npm run package
code --install-extension ./zw3d-customization-develop-0.1.17.vsix
```

重新加载 VS Code 窗口后点击最左侧 **ZW3D** 图标。活动栏图标以中望立体 Z 的意象重绘为 24×24 单色线条，跟随活动栏的主题着色。
工作台按“当前项目 → 当前文件与关联 UI → Release 构建 → Debug 构建 → 代码跳转”排列。分区标题至少 16px、操作标题至少 14px、说明至少 12px，
并随 VS Code 的界面字号增大。Release 和 Debug 各自使用独立卡片，标题显示相对构建目录和 CMake 参数图标，按钮样式不变。构建按钮在宽侧栏并排、300px 及以下纵向排列；工具入口就近使用图标：项目标题右侧为项目配置、重新配置与合并检测，最下方“代码跳转”标题同时显示数据库目录，其卡片包含自动更新选项、说明及相邻的 clangd 配置图标，输出日志使用工作台标题栏入口。整体纵向留白已收紧，分区顺序和按钮排列保持不变。
长路径最多显示两行，悬停可查看完整路径；较矮窗口可纵向滚动查看全部操作。
蓝色高亮跟随最近点击的操作，命令面板触发的操作也会同步高亮；不会固定突出“编译并运行”。
扩展依赖 `ms-vscode.cpptools`（GDB 调试）和 `llvm-vs-code-extensions.vscode-clangd`（C/C++ 语言服务），
安装 VSIX 时 VS Code 会解析这些依赖。
CMake Tools 可选，扩展自己的按钮直接调用 CMake，不要求它参与配置。

开发扩展时可在 VS Code 单独打开本目录，按 F5 启动扩展开发宿主。
需要 Linux、本机 ZW3D SDK/运行环境、CMake ≥3.16、可用的 g++/make/Git（Git ≥2.28）；调试另外需要 GDB。
扩展不会安装或修改系统/用户级工具链，也不执行 sudo。npm 依赖只保存在本目录。

## 从零创建项目

从命令面板执行 **ZW3D: 初始化项目**（或使用工作台标题栏入口），在表单中选择：

1. 已有的存放文件夹和项目名称，最终目录为 `存放文件夹/项目名称`。现有同名目录会被拒绝，不会覆盖。
2. 动态库名称，默认跟随项目名称；使用不含 `lib` 前缀和 `.so` 后缀的名称。
3. 自动检测出的 CMake、g++、ZW3D 位置，以及可选 GDB 路径。所有路径可手动修改或浏览选择。
4. 可选 Git 远程地址。留空仅执行 `git init -b main`；填写则添加 origin、暂存、首次提交并推送 main。

项目名称和库名均使用英文字母开头的字母、数字和下划线，以生成有效的 C++ 函数名。
工具路径下方同时显示对应版本，手动输入或浏览更换路径后自动更新；无法读取时显示原因。
确认后才写文件。创建完成后点击 **在新窗口打开项目**。

```text
HelloZW3D/
├── .zw3d/project.json         # 工具链、构建、部署、运行参数
├── .vscode/settings.json     # compile_commands.json 智能提示
├── .vscode/extensions.json   # clangd 与 C/C++ 扩展推荐
├── .clangd                   # 项目级 clangd 配置
├── compile_commands.json     # 首次配置/编译后链接到 build_clangd 中的数据库
├── CMakeLists.txt
├── src/main.cpp              # HelloZW3DInit/Exit、~HelloZW3D 命令
├── cmake/                    # 可选 toolchain
├── resources/forms/          # 可选原生 .ui
├── resources/commands/       # 可选 .tcmd
├── tests/
└── README.md
```

远程仓库应已存在且当前身份可写。扩展使用已有 Git 身份和认证，不设置用户级 `user.name/user.email`。
身份缺失、鉴权、分支冲突或网络失败会显示 Git 警告，并保留生成的文件、本地仓库及已完成的提交。
在项目中配置仓库级身份并重试即可，例如：

```sh
git config user.name 'Your Name'
git config user.email 'you@example.com'
git add .
git commit -m 'Initialize ZW3D plugin project' # 已有首次提交则跳过
git push -u origin main
```

不会强制推送。HTTP 交互式口令输入被禁用；请先配置好凭据管理器或 SSH。

## 接入已有工程，以及按钮为什么是灰色

打开工程时，扩展会**自动检查 CMake 和 C/C++ 源码中的中望 SDK 特征**。
识别为中望动态库工程后，自动生成根目录的 `.zw3d/project.json`，立即启用构建、运行和调试，
无需提前创建配置或手动接入。已有配置保持原样，包括需要手动修复的无效配置。
`template.json` / `CMakeLists.txt.tpl` 只用于创建新工程，编辑模板不会自动接入当前文件夹。

对 apiDemo 等已有 CMake 工程：

1. 使用“文件 → 打开文件夹”打开工程根目录（与 `CMakeLists.txt` 同级）。
2. 扩展自动识别并初始化为中望二开项目，显示初始化提示，按钮立即启用。
3. 点击 **项目配置** 查看或调整生成的工具链、库名和部署位置。

识别要求存在 CMake 的 `SHARED` / `MODULE` 动态库目标，同时满足以下任一 SDK 特征：
源码实际包含 `zwapi_*.h` / `VxApi.h`，CMake 引用 `libZW3D*.so` / `ZW3D.lib` 等 SDK 库，
或通过中望变量设置 `api/inc` SDK 头文件路径。仅项目名称含 ZW3D 或注释提到 SDK 不足以触发初始化。
检测范围为根目录和常见的 src/source/include/cmake 等代码目录，不扫描构建、依赖和 vendor 目录。

打开/新增工作区文件夹、修改 CMake、保存 C/C++ 文件或修改开发环境设置后会重新检测。
也可点击侧栏 **检测项目**，或运行 **ZW3D: 检测并初始化当前项目**。
开发工具或 SDK 缺失时，侧栏会显示原因，配置好路径后重新检测即可。
自动初始化默认开启，可通过 `zw3d.autoInitializeProjects` 关闭；关闭后仍可手动执行检测。

未自动识别的复杂工程可通过 **接入现有项目** 确认库名后生成配置。
没有有效配置且未完成初始化时，构建和调试按钮仍禁用，并显示相应原因。

接入依次查找 `build_debug`、`build_release`、旧 `build` 中的 CMake 缓存，读取工具、SDK、toolchain 和构建类型，保留已有源码、CMake 和 Git。
没有缓存时默认使用 Debug 与 `build_debug`；若缓存来自其他项目目录，使用独立的 `build-zw3d`。
静态解析的库名需要确认，复杂 CMake 工程请在配置中调整；产物应位于 `buildDirectory/plugin/<库名>.so`。
默认 `apilibs` 仍为 SDK 的 `files/apilibs`。同名 `.tcmd` 可识别为 `!模板名` 命令提示，
其他命令可通过配置的 `commandHint` 手动指定。
apiDemo 的库名为 `OriginBox`，测试命令为 **`!OriginBox`**。

手动添加或修改项目配置后，侧栏会自动刷新；必要时执行“开发人员：重新加载窗口”。

## 重新配置项目

当前项目卡片右上角的 **↻** 按钮（悬停显示“重新配置项目”），或命令 **ZW3D: 重新配置项目**，
可以重建当前项目的 `.zw3d` 文件夹。点击后选择：

- **重新配置项目**：推荐。重新检测工具与 SDK，生成项目配置，运行 CMake 配置、更新编译数据库，刷新侧栏并重启 clangd。
- **重新配置并重载当前窗口**：先完成上述配置，成功后执行 VS Code 的 Reload Window。

正常修改项目配置无需重载整个窗口；刷新侧栏及重启语言服务即可读取新配置。
窗口重载适合希望同时重新启动所有扩展的情况，只在本次重新配置成功后执行。

该操作会清除 `.zw3d` 内旧的手动配置和附加文件，重新从 CMake 工程、**当前构建目录**的缓存和工具设置推断配置。
例如 args/environment 会重置，不保留旧的启动参数和环境覆盖。
源码、CMakeLists.txt、构建目录和现有 `.clangd` / VS Code 显式设置不会被删除。
编译数据库由扩展管理时，重建后继续管理原链接。
操作只重新配置 CMake，不完整编译或启动 ZW3D。

扩展会先准备和验证新配置，临时保留旧目录；CMake 或设置失败、取消操作时恢复旧 `.zw3d`，成功后删除临时副本。
重新配置过程中与构建/自动检测串行；请先结束当前 C++ 调试或关闭本扩展启动的 ZW3D。
不允许对指向其他位置的 `.zw3d` 符号链接执行重建。

## 编译、重新生成和运行

**编译** 自动保存已有磁盘文件，执行 CMake 配置及增量构建。
**重新生成** 再次配置，并通过 `cmake --build … --clean-first` 清理目标后完整编译，不删除源码或整个项目。
Release、Debug 两个分区各有 **编译 / 编译并运行 / 重新生成**：

| 分区 | 构建目录（相对项目根目录） | 插件产物 |
| --- | --- | --- |
| Release 构建 | `build_release` | `build_release/plugin/<库名>.so` |
| Debug 构建 | `build_debug` | `build_debug/plugin/<库名>.so` |

两套 CMake 缓存、目标文件及资源包独立。Release 默认优化且不带调试信息，Debug 默认保留调试信息。
点击分区中的操作会同步 `.zw3d/project.json` 的 `buildType` / `buildDirectory`；
命令面板中的通用编译、运行和重新生成跟随当前类型（旧 RelWithDebInfo 配置转为 Debug）。旧构建目录保留。
代码跳转独立使用 `build_clangd` 中的 Debug 编译数据库，切换 Release / Debug 不改动它。
点击分区标题最右侧的参数图标，可以分别为 Release / Debug 设置一个附加 CMake 参数；例如 `-DMY_OPTION=ON`。参数作为单个字符串传给对应配置命令，留空会清除该类型的参数，配置保存在 `.zw3d/project.json` 的 `cmakeArgsByProfile`。
日志在输出面板 **ZW3D 二次开发**；通知或侧栏支持取消构建，取消会终止该次构建的进程组。

**编译并运行** 和 **编译并调试** 均使用增量编译，按钮说明已明确标注；需要清理后完整编译时先点击 **重新生成**。
**编译并运行** 依次构建、复制 `.so` 和可选同名 `.zrc` 至 `apilibs`，然后启动 ZW3D。
默认部署到 `<ZW3D files>/apilibs`。目录不存在时创建；没有写权限时在项目配置中更换为 ZW3D 可搜索的用户 apilibs。
复制使用临时文件加重命名，避免直接截断被进程映射的动态库，不触碰其他库。
更新插件后请关闭旧 ZW3D 实例；已经运行的宿主不会自动重新加载新库。

生成的 `src/main.cpp` 导出 `<库名>Init(int, void*)` / `<库名>Exit()`，并注册以项目名称命名的命令。
在中望命令栏输入 `~HelloZW3D` 可看到问候消息。初始化失败返回 SDK 错误码；退出时注销命令。
后续可在该命令函数中添加建模逻辑。

## 编译并调试

1. 在 `src/main.cpp` 的命令函数 `cvxMsgDisp(...)` 行设置断点；也可在 Init 函数中设置断点。
2. 从命令面板执行 **ZW3D: 编译并调试**（始终使用 `Debug` 和 `build_debug`）。扩展构建并部署，然后使用 `cppdbg` 直接由 GDB 启动实际的 `files/zw3d` 程序。
3. ZW3D 加载插件时 Init 断点生效；命令函数断点则在输入 `~项目名称` 后生效。
4. 命中后 VS Code 定位到源码，在 **运行和调试** 中显示调用堆栈、局部变量和监视，支持单步。

共享库加载之前，断点可能显示未绑定；配置已启用 pending breakpoint 和共享库符号搜索。
该命令会切换到 Debug 构建并部署对应插件；侧栏的“编译并运行”正常启动宿主，不启动 GDB。
调试的启动程序是 ELF 可执行文件，不是 `.so` 或 `zw3drun.sh`。
运行环境按本机官方 `zw3drun.sh` 的规则配置 `LD_LIBRARY_PATH`、`LD_PRELOAD`、缩放和 InterOp 变量，
只传递给新进程，不修改系统、用户 shell 或 GDB 自身的全局环境。

本扩展启动的普通实例尚未退出，或当前有 C++ 调试会话时，会要求先关闭/停止后再启动。
从其他入口启动的实例不由扩展管理；应用的单实例行为可能将请求交给旧实例，调试前应自行关闭。
扩展不会结束用户原有 ZW3D 进程，普通运行的应用也不会因 VS Code 重载而被关闭。

## clangd 与 compile_commands.json

编译数据库的标准文件名为 **`compile_commands.json`**，这里按此接入所说的 `command.json`。
新项目模板生成 `.clangd`、`.vscode/settings.json`、`.vscode/extensions.json`，
CMake 默认启用 `CMAKE_EXPORT_COMPILE_COMMANDS`。

- 点击 **配置 clangd** 或运行 **ZW3D: 配置 clangd 与编译数据库**，仅执行 CMake 配置并生成数据库。
- 项目根目录的 `compile_commands.json` 固定链接到 `build_clangd/compile_commands.json`，供 clangd 和 C/C++ 扩展查找。
- `build_clangd` 只执行 CMake 配置，固定使用 Debug，并复用项目工具链、SDK 与 `cmakeArgs`；不在该目录编译、部署或运行插件。
- 正常构建仅在数据库缺失或工具/配置参数变化时初始化或更新它；切换 Release / Debug 不重新配置它。
- “配置 clangd”可手动刷新；勾选自动更新后，只有确认新增源码参与插件目标才自动刷新 `build_clangd`。
- `.clangd` 从根目录读取数据库；扩展管理的旧链接在独立数据库配置成功后迁移，保留用户自建文件或链接。
- clangd 开启后台索引和 clang-tidy，关闭自动插入头文件；`--query-driver` 只列出本项目使用的具体 GCC/Clang 驱动路径，
  用于发现 C/C++ 标准库和 sysroot，包括编译器包装器。
- 新项目关闭 C/C++ 扩展的 IntelliSense，保留其 GDB 调试功能，避免两套补全/诊断重复。

`.clangd` 中 `CompilationDatabase` 和 query-driver 的作用参见
[clangd 项目配置](https://clangd.llvm.org/config#compilationdatabase)、
[系统头文件与编译器查询](https://clangd.llvm.org/guides/system-headers#query-driver)。

优先使用 `zw3d.clangdPath` 或 PATH 中已有的 clangd。扩展只安装 VS Code 的 clangd 扩展，不下载或永久安装后端工具。
本机已复用 `/home/winnie/software/clangd/user-bin/clangd`；其他机器可将已有后端路径填入 `zw3d.clangdPath`。

已识别的现有项目会补充缺少的 clangd 文件和工作区设置，保留手写 `.clangd`、已有根编译数据库、
现有扩展推荐和显式设置。工作区设置通过 VS Code 编辑，保留 JSONC 注释及无关字段。
如果手写 `clangd.arguments` 或 `clangd.path`，扩展尊重这些设置；更换编译器后请检查其中的 query-driver 白名单。
根数据库链接、clangd 缓存和内部链接状态默认加入项目 `.gitignore`。
Makefiles/Ninja 生成器支持 CMake 导出数据库；其他生成器可能需要自行提供数据库。
首次打开新项目尚无数据库时，先配置或编译一次；必要时执行 **clangd: Restart language server**。

“代码跳转”卡片提供 **新增源码文件时自动更新编译数据库** 勾选项，对应当前项目文件夹设置
`zw3d.autoRefreshCompileCommands`，默认关闭，保存在 `.vscode/settings.json` 中，重新配置 `.zw3d` 后仍保留。

- 开启后，新增 C/C++ 编译单元时去抖检查；使用临时构建目录配置 CMake，并读取
  [CMake File API 的目标信息](https://cmake.org/cmake/help/v3.31/manual/cmake-file-api.7.html)，确认源码属于当前 `.so` 目标或其构建依赖。
- **确认参与插件构建后**，才重新配置 `build_clangd`，更新 `compile_commands.json` 及受管理的根目录链接。
  不自动修改 CMake 源码列表，不编译、不部署、不启动中望，也不需要重载窗口。
- 模板的 `src/*.cpp` / `src/*.cxx` glob 会纳入相应新源码；apiDemo 这类显式列举源码的工程，
  新建文件不会自行加入目标，需要在 `add_library` / `target_sources` 等处加入后保存 CMake。
  当前窗口中等待纳入目标的新文件会在后续 CMake 修改时重新检查。
- 未使用的源码、独立测试目标、头文件，以及Release / Debug / clangd 目录中的生成源码不会触发正式数据库更新；
  已在数据库中的源码无需重复更新。忽略隐藏目录、node_modules 和 CMakeFiles。
- 临时检查保留当前缓存中的工具链及条件选项，结束后删除临时目录；检查有 60 秒超时并支持取消。
  CMake 配置失败、目标不明确或不支持目标信息时保持正式数据库，日志显示原因，可手动点击 **配置 clangd**。
  临时检查会执行项目的 CMake 配置脚本；正式配置本身失败时按 CMake 的常规行为保留诊断信息。
  多文件创建会合并检查，与手动构建串行；只检查开启选项后观察到的新文件。

## 当前文件、关联 UI 与 Qt Designer

“当前项目”卡片底部显示 **可能提供的命令**，汇总本项目全部已保存 `.tcmd` 模板的 `!名称`，
以及 C/C++ 源码/头文件中注册的 `~名称`，去重后按 `!`、`~` 分组排序；不依赖当前编辑文件、关联 UI 或 `.zw3d` 配置。
打开项目/重载窗口时扫描，保存源码或资源文件后自动更新；外部新增、修改、删除相关文件也会触发去抖刷新。
未保存的源码修改不会改变这份项目汇总，删除或改名的注册命令会在保存后移除，不将旧 commandHint 当成扫描结果。
可识别字符串参数及简单字符串变量，排除注释、仅发送而未定义的命令、已识别的模板/Form 回调和 test/tests/example/sample 目录。
结果是静态推断，复杂宏、条件编译和运行时注册可能需要手动核对；扫描范围受限时卡片会注明。

项目卡片仅显示项目名称、构建类型及可能提供的命令，不再重复显示项目路径和产物路径。项目分区标题右侧依次提供配置、重新配置和“检测项目与开发环境”图标；点击检测会先扫描项目再检测工具环境。初始化项目保留在命令面板和工作台标题栏，编辑模板保留在命令面板。

“当前文件”与“当前项目”是同级分区，标题放在各自卡片之外。当前文件卡片依次列出：**当前文件/文件夹、文件路径、可能关联 UI、可能提供的动态库与命令**。关联 UI 文件与 Designer 按钮紧邻排列，窄侧栏自动换行；关联 UI 和插件信息标题至少 14px，内容置于标题下一行，库名与命令以标签展示。
切换编辑文件后自动更新；输出面板等非本地文件视图不会替换上一次代码文件上下文。
也可在资源管理器右键文件或文件夹，选择 **ZW3D: 查看关联 UI**，明确指定要检查的目录。
工作区内存在多个 CMake 工程时，优先使用当前文件所在的最近上级 CMake/中望项目；无需提前生成 `.zw3d` 即可查看 UI。
工作区外的文件只显示路径，不关联到其他工程。

关联推断综合以下证据加权排序：当前 `.ui` 文件、当前 `.tcmd` 模板、源码中命令/Form API 的直接引用、
模板回调、相同文件名/Form 标识，以及目录位置。多个候选时点击 **在 Qt Designer 打开** 会先弹出排序列表，
显示候选的相对路径与关联依据；默认首项为最可能关联的 UI。仅同目录/同工程候选属于弱关联，不能证明运行时绑定。
源码字符串变量（如 `form_name` / `show_command`）的简单赋值也参与静态推断；复杂运行时拼接需要手动选择。
未保存的已打开源码/资源内容参与推断；启动外部编辑器前保存目标 UI，避免覆盖未保存修改。

对于原生 Tcmd Form，例如 `FilletBox`，按以下约定保持一致：

| 位置 | 对应名称 |
| --- | --- |
| 中望命令栏 | `!FilletBox`（`!` 后的名称） |
| 命令模板文件 | `FilletBox.tcmd`（不带后缀） |
| 模板元素 | `<template name="FilletBox">` |
| UI 文件 | `FilletBox.ui`（不带后缀） |
| 顶层 Form | `<widget class="ZsCc::Form" name="FilletBox">` |

扩展会检查可见的模板/UI 名称是否一致，并在卡片及候选列表提示差异，不自动改名。
此规则针对 **Tcmd Form**；独立 Form 可以没有 `.tcmd` 和 `!` 命令，通过源码的 `~注册命令` 打开。
动态库名称也可以与 Form 名不同，优先显示项目配置中的真实 `<libraryName>.so`；没有配置时静态分析 CMake 的动态库目标、OUTPUT_NAME 和 PREFIX。
命令提示区分 `!模板名` 与 `~注册函数名`，排除已识别的模板/Form 回调；不把二者拼成 `~!名称`，也不执行推断出的命令。
复杂宏、生成表达式和运行时加载可能影响结果，因此该行标注“可能提供”。

环境检测增加 **Qt Designer 路径与版本**。通过 `zw3d.designerPath` 可指定已有可执行文件或启动脚本；
留空检测 PATH 和常见 Qt 安装目录，本机复用 `/home/winnie/software/qt5/designer`（带中望自定义控件）。
未发现时，点击打开按钮可以选择已有 Designer，不下载或安装工具。
Designer 5.9 没有命令行版本输出，检测使用同安装目录的 `qmake -query QT_VERSION`，明确标注 Qt 版本；
找不到唯一配套 qmake 时显示“版本未知”，检测不会打开 Designer 的帮助对话框。
打开 UI 时直接传递绝对路径给启动器，支持空格，不经 shell；Qt 库与控件加载沿用用户现有启动脚本。
Designer 由用户关闭，VS Code 重载后仍可继续编辑；界面改动后在 VS Code 中编译资源再运行插件。

## 路径检测和配置

工具优先使用 VS Code 设置 `zw3d.cmakePath`、`zw3d.cxxPath`、`zw3d.gdbPath`，否则从 PATH 查找；
CMake 也尝试 `cmake3`。保留编译器包装器的原路径，避免解引用符号链接后破坏工具链。
ZW3D 优先使用 `zw3d.installRoot`，否则检查 `ZW3D_ROOT`、`~/software/zw3d` 和
`~/software`、`/opt/apps`、`/opt`、`/usr/local` 下名称包含 zw3d 的安装目录。
支持安装根目录或直接填写 `files`。有多套安装时请手动选择所需版本。

点击 **编辑当前项目配置** 修改 `.zw3d/project.json`，带 JSON Schema 补全和校验。
表单保存的工具位置优先于之后变化的 VS Code 默认设置；“检测环境”优先检查当前项目配置，
没有项目时检查默认环境。CMake、g++、GDB、ZW3D 和 Qt Designer 的路径及版本仅写入输出日志，通过工作台顶部日志入口查看。侧栏不再显示环境详情卡片或启动区命令提示。
CLI 工具通过 `--version` 读取，单个查询最多等待 3 秒；ZW3D 从安装包的 `info` 元数据读取，检测不会启动中望 GUI。
版本为即时读取结果，不写入项目配置；升级工具或换路径后重新检测即可。
多根工作区可以用侧栏的“切换”选择当前项目。

| 字段 | 用途 |
| --- | --- |
| `cmakePath` / `cxxPath` / `gdbPath` | 本机工具位置；GDB 可空，调试时再从 PATH 检测 |
| `zw3dRoot` | SDK 和依赖库所在安装目录 |
| `buildDirectory` | 当前构建目录；分区操作设置为 `build_release` / `build_debug`，新项目默认后者 |
| `buildType` | 当前构建类型；分区操作设置为 `Release` / `Debug`，兼容读取旧 `RelWithDebInfo` 配置 |
| `libraryName` | .so 名称，必须同步修改源码中的 Init/Exit 前缀 |
| `executable` | 实际宿主程序，默认 `files/zw3d` |
| `apilibs` | 部署目的目录；自定义目录必须是宿主搜索的插件目录 |
| `args` / `environment` | 进程启动参数数组及环境变量覆盖 |
| `commandHint` | 侧栏显示的命令，例如 `!OriginBox`；空字符串隐藏具体命令 |
| `cmakeArgs` | 额外配置参数数组，例如 toolchain 文件 |
| `cmakeArgsByProfile` | 可选的 Release / Debug 单个 CMake 参数，等同于标题旁参数图标的设置 |

默认设置统一读取根目录数据库，构建目录变化后无需调整语言服务路径；手写设置则需自行同步。
切换编译器、生成器或 sysroot 时使用新的构建目录，避免 CMake 缓存冲突。
符合条件的已有工程自动生成配置；其他工程可通过“接入现有项目”或按配置格式手动接入。

## 模板和开发文档

点击 **编辑模板** 会首次将内置模板复制到 VS Code 的本扩展数据目录，设置 `zw3d.templateDirectory`，
并打开 `template.json` 与 `CMakeLists.txt.tpl`。随后创建的项目使用该副本；已有工程不受影响。
也可以将 `zw3d.templateDirectory` 指向自己的模板目录，留空恢复内置模板。
扩展维护的默认模板副本会补充缺失的 clangd 模板项；未修改的旧设置/CMake 模板升级到新版，手工修改过的内容保留。
其他自定义模板目录由用户维护。

- [模板约定与 apiDemo 对照](docs/templates.md)
- [实现结构和验证步骤](docs/development.md)
- [更新记录](CHANGELOG.md)

SDK 加载约定参照本机 `api/ZW3D API introduction_Chs.pdf` 第二章；
GDB 配置字段参照 [VS Code C/C++ 调试官方文档](https://code.visualstudio.com/docs/cpp/launch-json-reference)。
