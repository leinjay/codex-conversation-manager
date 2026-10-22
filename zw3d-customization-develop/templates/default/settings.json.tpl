{
  "clangd.path": {{CLANGD_PATH_JSON}},
  "clangd.arguments": ["--background-index", "--clang-tidy", "--header-insertion=never", {{QUERY_DRIVER_ARGUMENT_JSON}}],
  "clangd.checkUpdates": false,
  "C_Cpp.intelliSenseEngine": "disabled",
  "C_Cpp.default.compileCommands": "${workspaceFolder}/compile_commands.json",
  "files.associations": { "*.tcmd": "xml" }
}
