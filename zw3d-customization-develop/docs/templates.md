# 模板约定

内置目录为 `templates/default`。`template.json` 抽象项目的目录与文件映射：

```json
{
  "directories": ["src", "cmake", "resources/forms", "resources/commands", "tests"],
  "files": {
    "CMakeLists.txt": "CMakeLists.txt.tpl",
    "src/main.cpp": "main.cpp.tpl",
    "include/{{PROJECT_NAME}}.h": "header.tpl"
  }
}
```

`directories` 相对生成项目；`files` 的键为生成路径，值为相对模板目录的 UTF-8 文件路径。
目录、目标路径和文本内容均支持占位符：

| 占位符 | 内容 |
| --- | --- |
| `{{PROJECT_NAME}}` | 项目名称 / 初始命令名称 |
| `{{LIBRARY_NAME}}` | 库名 / Init、Exit 函数前缀 |
| `{{ZW3D_ROOT_CMAKE}}` | 为 CMake 双引号字符串转义后的 ZW3D 路径 |
| `{{CXX_PATH_CMAKE}}` | 为 CMake 双引号字符串转义后的编译器路径 |
| `{{CLANGD_PATH_JSON}}` | JSON 字符串形式的 clangd 后端路径（包含引号） |
| `{{QUERY_DRIVER_ARGUMENT_JSON}}` | JSON 字符串形式的 --query-driver 参数（包含引号） |

CMake 原有 `${...}` 语法不参与替换。未知占位符、输出路径越界、源模板符号链接指向模板外部、
重复输出路径，以及写入 `.git` 或 `.zw3d/project.json` 会被拒绝。
模板必须生成 `CMakeLists.txt` 和 `src/main.cpp`。
`.zw3d/project.json` 始终由扩展根据表单生成，不放在用户模板中。

先读取并渲染所有模板，再独占创建目标目录。写文件失败时回滚本次新建的目录。
已有同名目录无论是否为空均不覆盖。Git 阶段失败不回滚已生成的工程。
模板只影响新项目，不会覆盖已有项目的手动修改。

## clangd 模板

- `clangd.tpl` → `.clangd`，CompilationDatabase 为项目根目录。
- `settings.json.tpl` → `.vscode/settings.json`，指定 clangd 后端、索引/诊断参数与编译器查询白名单，
  并关闭 C/C++ IntelliSense、保留其编译数据库路径和调试功能。
- `extensions.json.tpl` → `.vscode/extensions.json`，推荐 clangd 与 C/C++ 扩展。
- `CMakeLists.txt.tpl` 默认启用数据库导出；扩展配置/编译后在根目录创建指向 build_clangd/compile_commands.json 的链接。

不在模板中放假的空数据库或硬编码绝对 include 列表；实际 SDK、宏、sysroot 来自 CMake 的真实编译命令。
扩展自己的全局存储默认模板副本支持补充新增模板项，并只升级未修改的旧设置/CMake 模板。
手工定制的设置、其他模板目录以及已有项目中的手写文件保留。

## 从 apiDemo 抽取的部分

| apiDemo | 默认模板 |
| --- | --- |
| Linux CMake 工程、SDK 检查 | 保留；语言由 C 改为 C++17 |
| 链接 libZW3D.so、hidden visibility | 保留；Init/Exit 显式 C linkage + default visibility |
| 无 lib 前缀、build/plugin 输出 | 保留 plugin 子目录；Release/Debug 分别输出到 build_release/plugin、build_debug/plugin |
| RPATH 和 Linux 链接选项 | 保留 |
| zrc 编译 .ui / .tcmd | 保留为可选流水线，有原生资源文件时启用 |
| 安装到 apilibs | 保留；默认 cmake install 目的地在当前构建目录的 install |
| src、cmake、resources/forms、resources/commands、tests | 保留为目录模板 |
| OriginBox 业务和表单 | 替换为一个问候命令，不复制该业务 |
| 本机 local-sysroot.cmake、.deps、build | 不复制；可通过 cmakeArgs 指定自己的 toolchain |

添加资源只会启用编译打包。资源包的 ZwResourceFileRegister / Unregister 和表单回调需要自行加入源码。
运行/调试部署时复制同名 .so 和存在的同名 .zrc；模板应保持 `buildDirectory/plugin/<libraryName>` 输出约定。
自定义其他资源格式时相应扩展 CMake 和部署逻辑。

## Form 关联与外部编辑

工作台按当前文件/目录静态匹配模板资源，默认模板无需新增字段。
原生 Tcmd Form 的 `!命令名`、`.tcmd` 文件名、`template name`、`.ui` 文件名与顶层 `ZsCc::Form name` 应保持同一名称。
名称差异会提示，但扩展不修改用户文件；独立 Form 无需创建 `.tcmd`，通过注册的 `~命令` 打开。
库名沿用 libraryName，可与 Form 名不同。关联 UI 可直接交给已有 Qt Designer 编辑，路径通过 `zw3d.designerPath` 设置，
不会将本机 Designer 路径写入通用模板，也不会自动安装 Qt 工具或中望控件插件。

工作台按 Release / Debug 两种类型独立构建，新项目默认 `build_debug`。点击对应操作同步当前项目配置；代码跳转独立使用 build_clangd 的 Debug 数据库，根目录链接保持稳定。
