// dsh-autostart / test/unit.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildUnit,
  buildExecStart,
  escapeSystemdValue,
  unitName,
  unitPath,
  resolvePaths,
} from "../lib/systemd.js";
import {
  buildWindowsScript,
  buildSchtasksCommand,
  windowsScriptPath,
  windowsUserScriptPath,
  toWindowsPath,
} from "../lib/wsl.js";

test("escapeSystemdValue: $ 转义为 $$，引号转义，反斜杠翻倍", () => {
  assert.equal(escapeSystemdValue("a$b"), "a$$b");
  assert.equal(escapeSystemdValue('a"b'), 'a\\"b');
  assert.equal(escapeSystemdValue("a\\b"), "a\\\\b");
  assert.equal(escapeSystemdValue("plain"), "plain");
});

test("buildExecStart: 组装参数顺序与引号", () => {
  const s = buildExecStart("/usr/bin/node", "/home/po/.npm-global/bin/dsh", "web", "127.0.0.1", 3080, ["--trusted-host", "h1"]);
  assert.ok(s.includes('"/usr/bin/node"'));
  assert.ok(s.includes('"/home/po/.npm-global/bin/dsh"'));
  assert.ok(s.includes('"web"'));
  assert.ok(s.includes('"--host"'));
  assert.ok(s.includes('"127.0.0.1"'));
  assert.ok(s.includes('"--port"'));
  assert.ok(s.includes('"3080"'));
  assert.ok(s.includes('"--trusted-host"'));
  assert.ok(s.includes('"h1"'));
});

test("buildUnit: 关键节与默认值", () => {
  const u = buildUnit({ nodePath: "/usr/bin/node", dshPath: "/home/po/.npm-global/bin/dsh" });
  assert.ok(u.includes("[Unit]"));
  assert.ok(u.includes("[Service]"));
  assert.ok(u.includes("[Install]"));
  assert.ok(u.includes("WantedBy=default.target"));
  assert.ok(u.includes("Type=simple"));
  assert.ok(u.includes("Restart=on-failure"));
  assert.ok(u.includes("RestartSec=3"));
  assert.ok(u.includes('ExecStart="/usr/bin/node" "/home/po/.npm-global/bin/dsh" "web" "--host" "127.0.0.1" "--port" "3080"'));
  assert.ok(u.includes("WorkingDirectory=%h"));
});

test("buildUnit: 自定义 host/port/profile/extraArgs", () => {
  const u = buildUnit({ nodePath: "N", dshPath: "D", profile: "web", host: "0.0.0.0", port: 9090, extraArgs: ["--trusted-host", "x:1"] });
  assert.ok(u.includes('"N" "D" "web" "--host" "0.0.0.0" "--port" "9090" "--trusted-host" "x:1"'));
});

test("buildUnit: environment 生成 Environment= 行", () => {
  const u = buildUnit({ nodePath: "N", dshPath: "D", environment: { https_proxy: "http://127.0.0.1:7890", FOO: "bar baz" } });
  assert.ok(u.includes('Environment="https_proxy=http://127.0.0.1:7890"'));
  assert.ok(u.includes('Environment="FOO=bar baz"'));
});

test("buildUnit: PATH 包含 node/dsh 目录", () => {
  const u = buildUnit({ nodePath: "/opt/node/bin/node", dshPath: "/home/po/.npm-global/bin/dsh" });
  assert.ok(u.includes("Environment=PATH=/opt/node/bin:/home/po/.npm-global/bin:/usr/local/bin:/usr/bin:/bin"));
});

test("unitName / unitPath", () => {
  assert.equal(unitName(), "dsh-web.service");
  assert.equal(unitPath("/home/po"), "/home/po/.config/systemd/user/dsh-web.service");
});

test("resolvePaths: 显式配置优先", () => {
  const p = resolvePaths({ nodePath: "/x/node", dshPath: "/y/dsh" });
  assert.deepEqual(p, { nodePath: "/x/node", dshPath: "/y/dsh" });
});

test("windows 辅助脚本与 schtasks 命令", () => {
  const s = buildWindowsScript({ distro: "Arch", user: "po" });
  assert.ok(s.includes("wsl.exe -d Arch -u po systemctl --user start dsh-web.service"));
  const c = buildSchtasksCommand({ scriptPath: "C:\\dsh-autostart\\wsl-autostart.cmd" });
  assert.ok(c.startsWith("schtasks /create /tn"));
  assert.ok(c.includes("onlogon"));
});

test("windowsScriptPath", () => {
  assert.equal(windowsScriptPath("/home/po"), "/home/po/dsh-autostart/wsl-autostart.cmd");
  assert.equal(windowsUserScriptPath("po"), "/mnt/c/Users/po/dsh-autostart-wsl.cmd");
  assert.equal(windowsUserScriptPath(""), "");
});

test("toWindowsPath: /mnt 路径转 Windows 格式", () => {
  assert.equal(toWindowsPath("/mnt/c/Users/Administrator/x.cmd"), "C:\\Users\\Administrator\\x.cmd");
  assert.equal(toWindowsPath("/home/po/a.cmd"), "/home/po/a.cmd");
});
