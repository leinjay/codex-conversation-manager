# {{PROJECT_NAME}}

由 ZW3D 二次开发扩展创建的 Linux C++ 插件，基于 apiDemo 的 CMake/SDK 加载约定。

1. 在 VS Code 打开本目录，点击最左侧 ZW3D 图标。
2. 在 Release 或 Debug 分区点击“编译”；产物分别为 `build_release/plugin/{{LIBRARY_NAME}}.so`、`build_debug/plugin/{{LIBRARY_NAME}}.so`。
3. 点击“编译并运行”会部署至 ZW3D 的 apilibs 并启动应用。
4. 在 ZW3D 命令栏输入 `~{{PROJECT_NAME}}`，输出问候消息。
5. 在 `src/main.cpp` 的命令函数或 `{{LIBRARY_NAME}}Init` 中设置断点，从命令面板执行“ZW3D: 编译并调试”（使用 Debug 构建）。
   命中断点后可在 VS Code 查看调用堆栈、局部变量及单步执行；共享库加载前断点可能暂时未绑定。

`.zw3d/project.json` 保存本机 CMake、g++、GDB、ZW3D 路径、构建和运行设置。
迁移机器后使用“编辑当前项目配置”修改这些路径。默认 Debug 构建保留调试符号。
重命名动态库时同时修改源码中 Init/Exit 的名称；其前缀必须与 .so 文件名一致。

`.clangd` 和 `.vscode/settings.json` 已配置 clangd。点击“配置 clangd”或“编译”，
会在独立的 `build_clangd` 目录生成 `compile_commands.json` 并在根目录创建同名链接，供 clangd 读取 SDK、宏与编译选项。
语言服务固定使用 Debug 配置，不随 Release / Debug 切换；build_clangd 仅配置，不编译插件。
已有手写 .clangd / 数据库 / 设置会保留。
编译数据库和索引缓存无需提交。VS Code 的 clangd 后端路径及 GCC query-driver 白名单见工作区设置。
C/C++ 扩展的 IntelliSense 默认关闭，其 GDB 调试功能仍可使用。

命令行构建（机器默认值已写入 CMakeLists.txt）：

```sh
cmake -S . -B build_debug -DCMAKE_BUILD_TYPE=Debug
cmake --build build_debug --parallel
cmake --install build_debug
```

默认安装目录为 `build_debug/install/apilibs`；扩展的运行/调试按钮会直接复制到配置中的 `apilibs`。
更新后请关闭旧 ZW3D 实例再启动，以便加载新库。部署通过临时文件加原子重命名替换库。

`resources/forms`、`resources/commands` 预留原生 .ui/.tcmd 资源。
添加这些文件后 CMake 自动调用 ZW3D 自带的 zrc，扩展部署时会同时复制同名 .zrc。
资源的注册、命令回调仍需在自己的 C++ 初始化/退出函数中实现，可参照 apiDemo。
