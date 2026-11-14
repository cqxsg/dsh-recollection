import assert from 'node:assert/strict';

const testVersion = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)-compat\.(?:0|[1-9]\d*)$/;
export const isDshPeer = name => name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-');

export function assertCompatibilityVersion(version) {
  assert.ok(typeof version === 'string' && testVersion.test(version), 'Use a local test version such as 0.1.1-compat.1.');
}

/** Change only installation metadata in the staged package, never the development baseline. */
export function createCompatibilityManifest(source, version) {
  assertCompatibilityVersion(version);
  const pkg = structuredClone(source);
  pkg.version = version;
  pkg.private = true;
  pkg.engines.dsh = '*';
  for (const name of Object.keys(pkg.peerDependencies)) if (isDshPeer(name)) pkg.peerDependencies[name] = '*';
  return pkg;
}

export function compatibilityReadme(pkg) {
  return `# DSH Recollection 本地兼容性测试包

版本：${pkg.version}。仅供本地测试，尚未完成不同 DSH 版本的安装与运行验收。

- DSH 安装版本门槛已解除：\`engines.dsh\` 和 DSH peers 均为 \`*\`。这不表示所有宿主版本均已验证或兼容。
- 开发构建基线为 DSH ${pkg.devDependencies['@deepseek-ai/dsh']}；构建基线不是实际加载的宿主版本。
- 要求 Windows x64、Node.js ${pkg.engines.node}，保留非 DSH 共享依赖声明和所有运行时能力检查。
- 包含预构建 Host、Client、worker 和许可材料；安装时无需 Rust 或项目源码。
- 包标记为 \`private: true\`，用于阻止 npm 发布；可通过本地 tarball 安装。

## 安装

先将包的 SHA-256 与交付目录中的 \`SHA256SUMS\` 比较；\`build-manifest.json\` 记录构建来源和包内容。
使用目标 DSH 版本对应的启动器及独立测试 home/profile。正常退出目标 DSH 后，选择适用的一条安装命令，并替换实际文件路径：

\`\`\`powershell
dsh plugin --profile desktop add "C:\\path\\to\\dsh-recollection-${pkg.version}.tgz"
# Web 测试环境使用：
dsh plugin --profile web add "C:\\path\\to\\dsh-recollection-${pkg.version}.tgz"
\`\`\`

Desktop 也可在插件管理器中选择此本地文件安装。安装后重新启动目标 DSH，核对插件版本、宿主版本与实际依赖解析路径。
无需为本测试包配置版本豁免。分别记录安装/加载、回想功能和持久恢复的结果；元数据检查通过不能代替这些运行检查。

## 数据与卸载

随包配置将新 spill 保存至目标 \`DSH_HOME/spills\`，关闭该目录的定时清理；不会迁移旧 spill。
测试会生成原生会话、回想账目和持久引用。正常停止目标 DSH 后，可使用相同 profile 执行 \`dsh plugin --profile desktop remove dsh-recollection\`（Web 使用 \`--profile web\`）。卸载不会删除这些测试数据。

License：见包内 [LICENSE](./LICENSE)，第三方声明位于 \`lib/native/third-party/\`。
`;
}
