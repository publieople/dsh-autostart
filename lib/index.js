// dsh-autostart / lib/index.js
// DSH（DeepSeek Harness）插件：把 dsh web 注册为 systemd user service，
// 实现 WSL/Linux 登录（linger 开启时随系统启动）自动拉起 dsh web。
//
// 原理：DSH 插件运行在 dsh 进程内，系统开机时 dsh 尚未运行，插件无法在
// “开机时刻”执行；因此插件在每次 dsh 启动时幂等地安装/同步
// ~/.config/systemd/user/dsh-web.service，由 systemd 负责按需拉起 dsh web。
// 本插件只 enable 不 start，避免与用户手动启动的实例抢端口。
import z from "@deepseek-ai/schemastery";
import { homedir } from "node:os";
import {
  buildUnit,
  unitPath,
  writeUnit,
  removeUnit,
  isEnabled,
  isActive,
  enableUnit,
  disableUnit,
  daemonReload,
  ensureLinger,
  systemdAvailable,
  resolvePaths,
} from "./systemd.js";
import { writeWindowsScript, detectDistro, detectWindowsUser } from "./wsl.js";

const name = "dsh-autostart";
/** 不依赖任何注入服务（ctx.logger 为 cordis 内置）。 */
const inject = [];

const Config = z.object({
  /** 是否启用开机自启动（dsh 每次启动时按此同步 systemd unit） */
  enabled: z.boolean().default(false).description("是否启用开机自启动"),
  /** 自启动的 profile 名（当前支持 web；headless 为一次性任务，不适合常驻） */
  profile: z.string().default("web").description("自启动的 profile 名"),
  /** dsh web 监听地址 */
  host: z.string().default("127.0.0.1").description("dsh web 监听地址"),
  /** dsh web 监听端口 */
  port: z.number().default(3080).description("dsh web 监听端口"),
  /** 追加的 dsh CLI 参数，如 --trusted-host */
  extraArgs: z.array(z.string()).default([]).description("追加的 dsh CLI 参数"),
  /** node 绝对路径；留空自动用 process.execPath */
  nodePath: z.string().default("").description("node 绝对路径，留空自动探测"),
  /** dsh 可执行绝对路径；留空自动用 process.argv[1] */
  dshPath: z.string().default("").description("dsh 可执行绝对路径，留空自动探测"),
  /** 额外的 Environment= 键值（systemd 不继承 shell 环境，如 https_proxy） */
  environment: z.dict(z.string()).default({}).description("额外环境变量（Environment=）"),
  /** 尝试确保 loginctl lingering；无权限时仅提示用户手动执行 */
  enableLinger: z.boolean().default(true).description("尝试确保 lingering（无权限时仅提示）"),
  /** enabled=false 时是否删除 unit 文件 */
  removeUnitOnDisable: z.boolean().default(false).description("关闭自启动时是否删除 unit 文件"),
  /** 是否生成 Windows 侧辅助 .cmd 并打印 schtasks 注册指引 */
  wslWindowsAutostart: z.boolean().default(false).description("是否生成 Windows 侧辅助脚本与注册指引"),
  /** 只打印将执行的命令，不实际执行（预览/测试） */
  dryRun: z.boolean().default(false).description("dry-run：只打印不执行"),
});

async function syncAutostart(logger, config) {
  const log = (msg) => logger.info(`[dsh-autostart] ${msg}`);
  const paths = resolvePaths(config);
  if (!paths.dshPath) {
    logger.warn("[dsh-autostart] 无法确定 dsh 可执行路径（process.argv[1] 为空），请显式配置 dshPath");
    return;
  }
  if (!config.dryRun && !(await systemdAvailable())) {
    logger.warn("[dsh-autostart] 未检测到 systemctl：本插件需要 systemd，已跳过自启动管理（不影响 dsh 主流程）");
    return;
  }
  const home = homedir();
  const user = process.env.USER || "";

  if (config.enabled) {
    // 1. 生成并写入 unit（内容一致则跳过），有变更时 daemon-reload
    const unitText = buildUnit({
      nodePath: paths.nodePath,
      dshPath: paths.dshPath,
      profile: config.profile,
      host: config.host,
      port: config.port,
      extraArgs: config.extraArgs,
      environment: config.environment,
    });
    const changed = writeUnit(unitText, home, { dryRun: config.dryRun, log });
    if (changed && !config.dryRun) await daemonReload({ dryRun: config.dryRun, log });

    // 2. enable（幂等；只 enable 不 start，避免抢端口）
    const wasEnabled = await isEnabled({ dryRun: config.dryRun, log });
    if (!wasEnabled) await enableUnit({ dryRun: config.dryRun, log });
    const enabled = config.dryRun ? false : await isEnabled({ dryRun: config.dryRun, log });

    // 3. lingering：WSL 下 user service 随系统启动的关键
    if (config.enableLinger && user) {
      const linger = await ensureLinger(user, { dryRun: config.dryRun, log });
      if (linger === "disabled" && !config.dryRun) {
        logger.info(`[dsh-autostart] WSL 下 user service 需 lingering 才能随系统启动，请执行：sudo loginctl enable-linger ${user}`);
      }
    }

    // 4. 状态摘要与提示
    const active = await isActive({ dryRun: config.dryRun, log });
    logger.info(`[dsh-autostart] 自启动状态：unit=${unitPath(home)} enabled=${enabled || config.dryRun ? "是" : "待启用"} active=${active ? "是" : "否"}`);
    if (!active && !config.dryRun) {
      logger.info("[dsh-autostart] 服务未运行。可手动启动：systemctl --user start dsh-web.service（注意勿与手动启动的 dsh web 端口冲突）");
    }
  } else {
    // 关闭自启动（幂等）
    const enabled = await isEnabled({ dryRun: config.dryRun, log });
    if (enabled) await disableUnit({ dryRun: config.dryRun, log });
    if (config.removeUnitOnDisable) {
      const removed = removeUnit(home, { dryRun: config.dryRun, log });
      if (removed && !config.dryRun) await daemonReload({ dryRun: config.dryRun, log });
    }
    logger.info("[dsh-autostart] 已按配置关闭开机自启动（enabled=false）");
  }

  // 5. Windows 宿主侧辅助（可选，仅生成脚本与指引）
  if (config.wslWindowsAutostart) {
    writeWindowsScript({ dryRun: config.dryRun, log, user, distro: detectDistro(), home, winUser: detectWindowsUser() });
  }
}

function apply(ctx, config) {
  void (async () => {
    try {
      await syncAutostart(ctx.logger, config);
    } catch (error) {
      ctx.logger.warn(`[dsh-autostart] 出错（不影响 dsh 主流程）: ${String(error)}`);
    }
  })();
}

export { Config, apply, inject, name };
