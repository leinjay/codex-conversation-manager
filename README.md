# VS Code Extensions

Collection of VS Code extensions maintained in this repository.

## Extensions

| Extension | Description |
| --- | --- |
| [Codex Conversation Manager](codex-conversation-manager/README.md) | Browse local Codex conversations and Codex Cloud tasks, and manage saved accounts. |
| [ZW3D 二次开发](zw3d-customization-develop/README.md) | 初始化、编译、部署、运行和 GDB 调试 Linux 中望 3D 插件。 |

## Build Codex Conversation Manager

```sh
cd codex-conversation-manager
npm install
npm run compile
npm run package
```

Each extension keeps its own source, dependencies, build scripts, and package metadata in its directory. See the extension's README for installation and verification instructions.
