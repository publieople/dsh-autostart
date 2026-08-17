// dsh-autostart / lib/systemd.js
// systemd user service 管理：unit 文件生成、systemctl/loginctl 封装。
// 设计为无第三方依赖的纯 ES 模块，便于单元测试。
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

// ---------- 纯函数 ----------

/**
 * systemd unit 值转义：
 *  - `$` 在 unit 里是变量展开符，需写为 `$$`
 *  - `\` 是 systemd 的转义前缀，字面反斜杠需写为 `\\`
 *  - `"` 在双引号参数内需转义
 */
export function escapeSystemdValue(value) {
  return String(value)
    .replace(/\\/g, () => "\\\\")
    .replace(/\$/g, () => "$$")
    .replace(/"/g, () => '\\"');
}

/**
 * 解析 node / dsh 可执行路径。
 * 显式配置优先；否则从当前进程推断：
 *  - node  → process.execPath
 *  - dsh   → process.argv[1]（dsh 经 `node <dsh脚本> web` 启动，argv[1] 即 dsh 可执行文件）
 */
export function resolvePaths(config = {}) {
  return {
    nodePath: config.nodePath || process.execPath || "/usr/bin/node",
    dshPath: config.dshPath || process.argv[1] || "",
  };
}

/** 组装 ExecStart 命令行（systemd 语法：每个参数用双引号包裹并转义）。 */
export function buildExecStart(nodePath, dshPath, profile = "web", host = "127.0.0.1", port = 3080, extraArgs = []) {
  const args = [
    nodePath,
    dshPath,
    profile,
    "--host",
    host,
    "--port",
    String(port),
    ...(extraArgs || []),
  ];
  return args.map((a) => `"${escapeSystemdValue(a)}"`).join(" ");
}

/**
 * 生成 dsh-web.service unit 文本（纯函数，便于测试）。
 * PATH 基于 node/dsh 所在目录推导，保证 systemd 环境下 dsh 内部子进程可解析。
 */
export function buildUnit({ nodePath, dshPath, profile = "web", host = "127.0.0.1", port = 3080, extraArgs = [], environment = {} }) {
  const envLines = Object.entries(environment || {}).map(
    ([k, v]) => `Environment="${escapeSystemdValue(k)}=${escapeSystemdValue(v)}"`,
  );
  const pathEnv = [
    dirname(nodePath),
    dirname(dshPath),
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ].join(":");
  const lines = [
    "[Unit]",
    "Description=DeepSeek Harness (dsh) web server (autostart)",
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    "WorkingDirectory=%h",
    "Environment=HOME=%h",
    `Environment=PATH=${pathEnv}`,
    ...envLines,
    `ExecStart=${buildExecStart(nodePath, dshPath, profile, host, port, extraArgs)}`,
    "Restart=on-failure",
    "RestartSec=3",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ];
  return lines.join("\n");
}

export function unitName() {
  return "dsh-web.service";
}

export function unitDir(home = homedir()) {
  return join(home, ".config", "systemd", "user");
}

export function unitPath(home = homedir()) {
  return join(unitDir(home), unitName());
}

// ---------- 命令执行（不抛异常，返回结果对象） ----------

/** 执行外部命令，返回 { exitCode, stdout, stderr }。 */
export function runCommand(bin, args) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: 15000 }, (error, stdout, stderr) => {
      if (!error) {
        resolve({ exitCode: 0, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
        return;
      }
      const code = typeof error.code === "number" ? error.code : 1;
      resolve({ exitCode: code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
  });
}

/** systemctl --user 封装；dryRun 时只记录命令。 */
export function systemctlUser(args, { dryRun = false, log = () => {} } = {}) {
  const full = ["--user", ...args];
  if (dryRun) {
    log(`[dry-run] systemctl ${full.join(" ")}`);
    return Promise.resolve({ exitCode: 0, stdout: "", stderr: "", dryRun: true });
  }
  return runCommand("systemctl", full);
}

/** dryRun 下视为未启用/未运行，从而让主流程打印所有需要的命令。 */
export async function isEnabled({ dryRun = false, log = () => {} } = {}) {
  if (dryRun) return false;
  const r = await systemctlUser(["is-enabled", unitName()], { dryRun, log });
  return r.exitCode === 0;
}

export async function isActive({ dryRun = false, log = () => {} } = {}) {
  if (dryRun) return false;
  const r = await systemctlUser(["is-active", unitName()], { dryRun, log });
  return r.exitCode === 0;
}

export function enableUnit(opts = {}) {
  return systemctlUser(["enable", unitName()], opts);
}

export function disableUnit(opts = {}) {
  return systemctlUser(["disable", unitName()], opts);
}

export function daemonReload(opts = {}) {
  return systemctlUser(["daemon-reload"], opts);
}

/**
 * 检查/开启 loginctl lingering。
 * WSL 下没有传统登录会话，user service 需 lingering 才能随系统启动。
 * 返回 'enabled' | 'disabled' | 'no-loginctl'。
 */
export async function ensureLinger(user, { dryRun = false, log = () => {}, enable = true } = {}) {
  if (dryRun) {
    log(`[dry-run] loginctl show-user ${user} -p Linger`);
    if (enable) log(`[dry-run] loginctl enable-linger ${user}`);
    return "disabled";
  }
  const probe = await runCommand("loginctl", ["show-user", user, "-p", "Linger"]);
  if (probe.exitCode !== 0) return "no-loginctl";
  if (probe.stdout.trim().includes("Linger=yes")) return "enabled";
  if (enable) {
    const r = await runCommand("loginctl", ["enable-linger", user]);
    if (r.exitCode !== 0) return "disabled"; // 无权限等 → 提示用户手动执行
    return "enabled";
  }
  return "disabled";
}

/** systemd 是否可用（systemctl 存在且可执行）。 */
export function systemdAvailable() {
  return runCommand("systemctl", ["--version"]).then((r) => r.exitCode === 0);
}

/** 读取已存在的 unit 文件内容；不存在返回 null。 */
export function readExistingUnit(home = homedir()) {
  const p = unitPath(home);
  return existsSync(p) ? readFileSync(p, "utf8") : null;
}

/** 写入 unit 文件（内容一致则跳过）。返回 true=已写（或 dryRun 会写），false=无变化。 */
export function writeUnit(text, home = homedir(), { dryRun = false, log = () => {} } = {}) {
  const p = unitPath(home);
  if (readExistingUnit(home) === text) return false;
  if (dryRun) {
    log(`[dry-run] 写入 ${p}`);
    return true;
  }
  mkdirSync(unitDir(home), { recursive: true });
  writeFileSync(p, text, "utf8");
  return true;
}

/** 删除 unit 文件（若存在）。返回是否删除了。 */
export function removeUnit(home = homedir(), { dryRun = false, log = () => {} } = {}) {
  const p = unitPath(home);
  if (!existsSync(p)) return false;
  if (dryRun) {
    log(`[dry-run] 删除 ${p}`);
    return true;
  }
  rmSync(p);
  return true;
}
