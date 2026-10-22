# 开发与验证

`src/extension.ts` 负责 VS Code 命令、工作区选择、进度、Webview 和 debug.startDebugging。
`src/core.ts` 负责工具检测、模板、项目配置、CMake 参数、原子部署和宿主环境；不依赖 VS Code API，便于独立测试。
`src/core.ts` 的 withBuildProfile/selectBuildProfile 将 Release/Debug 映射为 build_release/build_debug；选择构建时更新项目配置，部署使用对应构建 Project，语言服务通过 clangdProject 固定使用 build_clangd / Debug。命令面板 GDB 调试固定使用 Debug。
`src/process.ts` 使用 spawn 的参数数组执行程序，构建取消时结束本次进程组。
`src/importProject.ts` 读取已有 CMake 工程和缓存，只新增项目识别配置。
`src/resetProject.ts` 在重新配置操作中重建 .zw3d：先根据当前构建目录和工具设置生成新配置，
再将旧目录临时移动到同级唯一目录，生成新目录并执行 CMake/语言服务设置。
失败或取消恢复旧目录和受管理的数据库链接，成功删除临时副本；拒绝符号链接目录。
它保留数据库链接的所有权信息，但不保留旧项目参数、环境覆盖或 .zw3d 中的用户附加文件。
扩展操作先等待在途的自动检测结束，重建期间阻止新的自动初始化；完成后刷新侧栏和重启 clangd，
只有用户选择“重新配置并重载当前窗口”且操作成功时才执行 workbench.action.reloadWindow。
`src/clangd.ts` 管理根编译数据库链接、缺失的项目配置和编译器查询白名单。
`src/compileCommands.ts` 在临时目录中请求 CMake File API codemodel-v2，按实际 .so 产物定位唯一插件目标，
遍历该目标及其构建依赖的编译单元，避免将无关文件或独立测试误判为插件源码。
临时配置复制非内部类型的缓存选项并重定向构建目录路径，保留条件源码/工具链；不复制内部缓存路径。
已导出源码不重复检查，失败/取消时清理临时目录，不更新正式数据库；临时配置超时 60 秒。
extension.ts 在文件夹级 autoRefreshCompileCommands 开关开启时监听新增编译单元及 CMake 变更，
1000ms 去抖，等待既有自动检测结束，通过统一 operation 锁与构建串行。
只有确认参与插件目标的新增源码才重新配置 build_clangd、同步数据库及语言设置。
未纳入目标的文件在当前窗口保留等待后续 CMake 编辑，每个项目最多 512 个；关闭勾选清空等待队列。
不扫描启动前已存在的源码，也不自动修改用户 CMake。UI 勾选写入 WorkspaceFolder 设置，刷新状态回显。
链接所有权记录在被忽略的 .zw3d/clangd-state.json 中，只更新扩展创建且仍指向已记录目标的链接；
用户替换为普通文件或其他链接后停止管理。独立数据库配置成功后迁移旧链接；新配置完成前保留可用的旧链接。
configureClangdDatabase 在 build_clangd 仅执行配置、不编译，记录工具和参数签名；普通构建仅在缺少数据库或签名变化时初始化，类型切换不会改写数据库。手动配置、项目重置及确认新增源码参与目标后强制刷新。
`src/templateUpgrade.ts` 为全局存储中的默认模板副本补充 clangd 文件映射，只替换确定未修改的旧模板。
现有工作区语言服务设置由 VS Code Configuration API 添加，避免重写 JSONC；用户显式值优先。
`src/projectDetection.ts` 静态识别中望动态库工程，并在配置缺失时自动接入。
检测不执行 CMake 或项目代码；扫描至多 256 个文件、2000 个目录项、约 4 MiB 文本，
跳过超过 256 KiB 的文件、符号链接、隐藏目录、构建和第三方依赖目录。
通过动态库目标和 SDK 特征组合判断，过滤注释中的示例代码；扫描深度最多 5 层。
扩展在含 CMakeLists.txt 的工作区自动激活，启动和相关变更后去抖检测；手动检测与自动检测串行。
无效的已有配置保持原样；并行初始化通过独占创建避免覆盖。信任和 Linux 平台检查在自动写入前进行。
`media/view.js` / `style.css` 提供主题自适应工作台和表单；Webview 限定本地资源并使用 CSP/nonce，路径与错误按文本显示。Release/Debug 标题的 CMake 参数入口各保存一个单字符串配置并作为独立 argv 参数加入相应配置命令；纵向间距可调节而不改变分区和按钮排列。
工作台使用语义 h2 分区标题和内嵌 SVG 操作图标；字号由 --zw-heading-size / --zw-action-size / --zw-caption-size 统一控制，
最低分别为 16/14/12px，并遵循更大的 VS Code 界面字号。300px 以下构建卡片单列；取消底部工具区，项目操作使用分区标题右侧的图标，Release/Debug 构建各使用独立卡片，标题右侧标注 build_release/build_debug，分别提供编译、编译并运行、重新生成，最下方“代码跳转”卡片容纳编译数据库勾选与 clangd 入口，日志共用 view/title 的 showOutput 命令入口。
最近操作由扩展宿主维护，通过状态消息同步到 Webview 的 is-selected 和 aria-pressed，点击后立即更新。
`src/toolVersions.ts` 对 CLI 工具执行 --version（3 秒超时），对 ZW3D 读取安装元数据；版本不写入 project.json。
`src/uiAssociation.ts` 有界扫描当前活动文件所在最近上级 CMake/中望项目，读取 UI 的顶层 Form/class/functionName、
Tcmd 模板和 custom/init 回调，识别源码中命令/Form API 的字符串或简单常量变量引用；按语义证据与目录距离综合排序。
输出 !模板名、~注册函数名，排除已识别的模板/Form 回调，名称不一致显示告警，弱关联明确标注证据不足。
库名优先 project.json，否则静态分析 CMake 的动态库目标/OUTPUT_NAME/PREFIX；不运行 CMake 来猜测 UI。
扫描上限为 512 个文件、5000 个目录项、8 MiB、单文件 512 KiB、目录深度 8，跳过隐藏/构建/依赖目录和符号链接。
extension.ts 缓存扫描结果，资源变动失效，250ms 去抖；活动文档未保存内容覆盖磁盘副本，异步序号过滤过期上下文。
资源管理器 inspectUiContext 命令可指定文件夹；输出面板等非 file 文档不替换上一次本地文件上下文。
同模块的 inferProjectCommands 汇总项目内全部 Tcmd 模板与 C/C++ 注册定义，复用模板/回调解析，
过滤已识别的模板/Form 回调和测试/示例目录，去重排序，不依赖 active file、UI 或 commandHint。
extension.ts 单独维护当前项目命令扫描结果，打开侧栏或切换项目时读取磁盘，保存源码/资源及文件系统相关变更后 300ms 去抖重扫。
此列表不使用未保存编辑缓冲区，也不复用 UI 关联缓存；异步序号和项目根路径检查丢弃过期结果。
已初始化与未识别项目卡片均渲染 project-commands，不要求先接入工程。
`src/designer.ts` 检测已有 Designer/启动脚本，并读取配套 qmake 的 Qt 版本（Designer 5.9 不支持 --version）。
版本检测不启动 GUI；打开操作传递绝对路径数组、不经 shell，复用启动器的 Qt/中望自定义控件环境，不安装工具。
多候选通过 QuickPick 按关联度选择，打开前保存目标 UI；Designer 生命周期由用户管理，窗口重载不终止。
表单路径变动后去抖查询版本，使用请求序号忽略过期结果，避免旧版本覆盖新路径。

## 常规检查

在扩展目录中：

```sh
npm ci
npm test
npm run package
```

测试覆盖生成项目、不同项目/库名、带空格路径、模板定制与越界拒绝、现有目录保护、
构建/重生成参数、调试配置、环境隔离、so/zrc 原子替换、参数不经 shell、取消、Git 本地初始化和裸远程推送，
以及自动识别、普通工程/注释/第三方文件排除、重复检测、并发初始化和配置保护，
clangd 模板升级、数据库链接所有权、构建目录切换及真实驱动路径解析，
真实 CMake 的 glob/显式源码和依赖目标归属、独立测试排除、缓存条件选项、临时检查失败与取消清理，
重新配置时全目录重建、当前构建缓存读取、失败/取消回滚和符号链接保护。
Git 测试只设置临时仓库的身份，不修改全局配置。

## 本机 SDK 和 GDB 集成检查

```sh
npm run test:sdk
npm run test:vscode
```

`test:sdk` 要求本机真实 SDK、CMake、g++、make、GDB、nm、readelf。
可用 `ZW3D_ROOT` 指定安装。它在被忽略的 `.test-artifacts` 中执行：

1. 用真实 SDK 生成、编译和重新生成 C++ 动态库，检查导出符号和 `.debug_info`。
   本机有 clangd 时读取根编译数据库并执行 --check，验证 SDK/标准库头文件、宏和编译参数，要求 0 errors。
2. 部署到测试目录，校验内容；如果找到 `ZW3D_REFERENCE`（默认本机 apiDemo），复制其资源测试真实 zrc。
3. 使用真实 SDK 头文件构建一个模拟 SDK 和模拟宿主，验证初始化、命令调用、退出和 GDB pending 断点。
4. 将 GDB 的源码与调用栈输出保存到测试目录，输出 `latest-mock.json` 供下一步使用。

`test:vscode` 使用已安装的 VS Code 和 Microsoft C/C++ 扩展运行真实扩展宿主。
测试使用独立的临时 VS Code 用户数据，暂时移除测试工程的配置，验证打开工程后自动初始化；
退出时恢复原配置。通过本机 Chromium DevTools 验证侧栏与表单，
实际点击自动更新勾选项，验证无关源码不改动数据库、手动纳入 CMake 后更新、glob 新源码自动更新、取消勾选后不再更新；
填写项目/库名并实际提交生成项目、检查 Git 仓库，然后在上述模拟工程调用 `zw3d.debug`，
从调试适配器读取真实 stopped/stackTrace/scopes，断言定位到 main.cpp 且栈中有宿主调用。
需要 DISPLAY；无桌面时可使用已有的 `xvfb-run -a npm run test:vscode`。
通过 `VSCODE_EXTENSIONS_DIR` 可指定已有扩展目录，`VSCODE_EXECUTABLE` 可指定 VS Code Electron 程序。
测试使用短暂的本机 DevTools 端口，进程退出后关闭；不下载或永久安装其他工具。
侧栏与表单截图保存为 `.test-artifacts/dashboard.png` 和 `create-form.png`，
调试栈保存在 `vscode-debug-result.json`，宿主日志保存在 `vscode-console.log`，均不提交。

模拟宿主验证调试链路，不替代真实 ZW3D 的许可证、GUI 和插件自动加载验证。
真实 GUI 验收：关闭已有 ZW3D，在生成项目的命令函数中下断点，点击编译并调试，
待宿主启动后输入 `~项目名`，确认命中源码并查看堆栈；停止调试后再验证普通运行。
真实 ZW3D 的启动环境依据安装随附的 `zw3drun.sh`，版本变化时需要对照更新。

## 当前范围

- Linux ZW3D 的 GCC/CMake `.so` 工作流；未实现 Windows DLL 工具链。
- 单一工作区操作串行，避免构建和部署交叉；支持多根工作区选择。
- 不自动附加到用户之前启动的 ZW3D，不强制关闭或热卸载其他进程。
- 模板资源默认关闭，添加 .ui/.tcmd 后开启 zrc；不自动生成复杂 Form 业务。
- 本机配置以绝对工具路径保存，迁移后需调整；已有工程接入需提供配置和相同输出约定。

## 本次验证记录（截至 2026-10-22）

- TypeScript 编译及 28 项自动化测试通过，包含已有 C 工程接入、自动检测初始化、配置保护、工具版本、clangd、项目重新配置、新增源码目标归属、UI 关联、Designer 与项目命令汇总。
- CMake 4.4.4、g++ 15.2.0、ZW3D 2026 SDK：生成项目的默认配置直接构建，以及扩展配置/增量编译/重生成均通过。
- 使用真实 zrc 编译 apiDemo 原生资源，校验 .so 导出、调试信息及 .so/.zrc 部署通过。
- GDB 16.3 在模拟宿主动态加载 .so 后命中 Init 和命令函数，并定位源码与宿主调用栈。
- VS Code 1.141.1 + Microsoft C/C++ 1.34.4：真实 Webview 侧栏、表单生成、Git 初始化、
  一键调试、源码断点、stackTrace 和 scopes 检查通过。
- npm 依赖审计无已知漏洞；扩展运行时不依赖第三方 npm 包。
- 真实 ZW3D GUI 内的许可证、自动加载和交互命令仍需人工验收。
- 0.1.1 已为本机 apiDemo 添加配置，沿用原 CMake 3.31.10 与 local-sysroot，实际构建通过。
- 0.1.2 通过真实 VS Code 验证打开无配置的中望工程后自动初始化；也验证关闭自动初始化后可手动检测，并启用构建/调试。
- 0.1.3 通过已有的 VS Code 界面与调试检查；人工检查深色/浅色主题、240px/420px 宽度，
  标题 16px、操作标题 14px、说明 12px，未发现横向溢出；截图与布局测量保存在忽略的 .test-artifacts 中。
- 0.1.4 验证操作高亮在构建后保留、点击其他操作时切换；环境面板显示实际路径/版本，
  表单手动改为无效路径后提示原因，恢复路径后重新显示正确版本；GDB 断点和堆栈检查通过。
- 0.1.5 使用 clangd 23.1.0 对真实 SDK C++ 初始插件及 apiDemo 的 OriginBox.c 执行 --check，均为 0 errors。
  已验证 VS Code 配置 clangd / 编译数据库操作和 GDB 断点堆栈链路；未新增系统或用户级后端安装。
- 0.1.6 在临时 VS Code 窗口实际点击卡片重新配置按钮，验证两种重载选项、默认不重载、
  .zw3d 中旧附加文件清理、编译数据库刷新和源码保留；之后的 GDB 断点/堆栈检查通过。
  整窗重载选项接入内置 Reload Window 命令；集成检查使用默认不重载分支。
- 0.1.7 在真实 VS Code 中验证增量编译标注、按项目保存的勾选项、未纳入目标的源码保持正式数据库内容与时间戳，
  编辑 CMake 后自动纳入、glob 新源码自动更新，以及关闭选项后停止更新；原有项目重置、表单、GDB 断点/堆栈链路通过。
- 0.1.8 验证活动文件与资源管理器目录上下文、关联 UI 卡片、候选排序、选择不同候选后实际传递对应 UI 路径、动态库与 !/~ 提示。
  本机 apiDemo/Tcmd 与 apiDemoForm/独立 Form 均可推断；检测到 Qt Designer 配套 Qt 5.9.7。
  使用临时配置目录与 UI 副本实际启动已有 Designer，确认自定义控件加载后进程保持运行；offscreen 模式有 OpenGL/QQuickWidget 平台提示。
  VS Code 集成测试使用记录参数的临时启动器，避免操作用户已有 Designer 窗口；原有 GDB 源码断点和堆栈检查通过。
- 0.1.9 在真实 VS Code 中验证打开项目即显示已有注册命令、保存源码后替换命令、未保存内容不进入项目汇总，
  同时确认无 project.json 时命令仍显示在未识别项目卡片内；UI 关联、自动数据库更新、项目重置及 GDB 调试链路通过。
