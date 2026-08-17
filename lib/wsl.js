// dsh-autostart / lib/wsl.js
// Windows 宿主侧辅助：WSL 发行版默认按需启动，插件无法在 Windows 开机时刻执行，
// 因此生成 .cmd 辅助脚本并给出 schtasks 注册指引，由用户在 Windows 侧手动注册。
// 脚本会尝试同时写入 Windows 用户目录（/mnt/c/Users/<user>），并给出 Windows 可用的路径。
import { homedir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";

/** 探测 WSL 发行版名：环境变量优先，其次 wsl.exe -l -q，失败返回空串。 */
export function detectDistro() {
  if (process.env.WSL_DISTRO_NAME) return process.env.WSL_DISTRO_NAME;
  try {
    const out = execFileSync("wsl.exe", ["-l", "-q"], { encoding: "utf8", timeout: 8000, windowsHide: true });
    const name = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
    return name || "";
  } catch {
    return "";
  }
}

/** 探测 Windows 用户名：cmd.exe %USERNAME% 优先，其次 /mnt/c/Users 目录推断，失败返回空串。 */
export function detectWindowsUser() {
  try {
    const out = execFileSync("cmd.exe", ["/c", "echo %USERNAME%"], { encoding: "utf8", timeout: 8000, windowsHide: true });
    const name = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
    if (name) return name;
  } catch {
    // fallthrough
  }
  try {
    const users = execFileSync("ls", ["/mnt/c/Users"], { encoding: "utf8", timeout: 3000 })
      .split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !/^(Public|Default|All Users|desktop.ini)$/i.test(s));
    return users[0] || "";
  } catch {
    return "";
  }
}

/** WSL 侧备用脚本路径：~/dsh-autostart/wsl-autostart.cmd */
export function windowsScriptPath(home = homedir()) {
  return join(home, "dsh-autostart", "wsl-autostart.cmd");
}

/** Windows 侧脚本路径（在 WSL 中表示为 /mnt/c/Users/<user>/dsh-autostart-wsl.cmd）。 */
export function windowsUserScriptPath(winUser) {
  return winUser ? join("/mnt/c/Users", winUser, "dsh-autostart-wsl.cmd") : "";
}

/** 生成 .cmd 内容（CRLF，Windows 换行）。 */
export function buildWindowsScript({ distro = "", user = "", unit = "dsh-web.service" } = {}) {
  const d = distro || "<DISTRO>";
  const u = user || "<USER>";
  return [
    "@echo off",
    "rem dsh-autostart: start dsh web inside WSL at Windows logon",
    "wsl.exe -d " + d + " -u " + u + " systemctl --user start " + unit,
    "",
  ].join("\r\n");
}

/**
 * WSL 路径转 Windows 路径：/mnt/c/Users/Administrator/x.cmd → C:\\Users\\Administrator\\x.cmd
 * 非 /mnt 路径原样返回。
 */
export function toWindowsPath(p) {
  const m = /^\/mnt\/([a-zA-Z])\/(.+)$/.exec(p);
  if (!m) return p;
  return m[1].toUpperCase() + ":\\" + m[2].replace(/\//g, "\\");
}

/** schtasks 注册命令（打印给用户手动执行，不自动注册）。 */
export function buildSchtasksCommand({ scriptPath }) {
  return 'schtasks /create /tn "dsh-autostart" /tr "\\"' + toWindowsPath(scriptPath) + '\\"" /sc onlogon /f';
}

/** 写 Windows 辅助脚本并打印注册指引；dryRun 时只打印。 */
export function writeWindowsScript({ dryRun = false, log = () => {}, user = "", distro = "", home = homedir(), winUser = "" } = {}) {
  const wslPath = windowsScriptPath(home);
  const winPath = windowsUserScriptPath(winUser);
  const content = buildWindowsScript({ distro, user });
  const cmd = buildSchtasksCommand({ scriptPath: winPath || wslPath });
  if (dryRun) {
    log("[dry-run] 写入 " + wslPath);
    if (winPath) log("[dry-run] 写入 " + winPath);
    log("[dry-run] Windows 注册命令: " + cmd);
    return;
  }
  mkdirSync(join(home, "dsh-autostart"), { recursive: true });
  writeFileSync(wslPath, content, "utf8");
  log("已生成 WSL 侧辅助脚本: " + wslPath);
  if (winPath) {
    try {
      writeFileSync(winPath, content, "utf8");
      log("已生成 Windows 侧辅助脚本: " + winPath);
      log("在 Windows 上注册登录自启（可选）: " + cmd);
    } catch {
      log("Windows 用户目录不可写（" + winPath + "），可手动复制该 .cmd，或改用: " + cmd);
    }
  } else {
    log("未能探测 Windows 用户名，无法写入 /mnt/c/Users；请手动把该 .cmd 放入 Windows 启动文件夹（shell:startup）。");
  }
}
