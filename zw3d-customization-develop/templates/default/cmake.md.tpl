# CMake 扩展

在此放置可选 toolchain 或辅助 .cmake 文件。在 `.zw3d/project.json` 的
`cmakeArgs` 中设置 `-DCMAKE_TOOLCHAIN_FILE=/absolute/path/to/toolchain.cmake`。
工具链改变后应使用新的 `buildDirectory`，避免复用旧的编译器缓存。
