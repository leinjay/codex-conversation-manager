# ZW3D Customization Develop

- 本目录是独立的 Linux ZW3D 二次开发 VS Code 扩展。
- 使用 TypeScript 和 VS Code API；运行时不引入第三方 npm 依赖。
- 在本目录运行 `npm ci`、`npm test`、`npm run package`。
- 修改模板时同步维护 README.md、docs/templates.md 和相关生成/构建测试。
- 不安装系统级或用户级工具链；测试依赖只能放在项目或临时目录中。
- 不提交 node_modules、dist、测试产物和 VSIX。
