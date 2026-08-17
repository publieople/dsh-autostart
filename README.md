# dsh-autostart

DSH（DeepSeek Harness）插件：把 **dsh web 注册为 systemd user service**，让它在 WSL/Linux 登录后（linger 开启时随系统启动）自动拉起，并提供启停/状态管理。

> 架构认知：DSH 插件运行在 dsh 进程内，系统开机时 dsh 尚未运行，插件无法在"开机时刻"执行。因此本插件在每次 dsh 启动时**幂等地安装/同步** ~/.config/systemd/user/dsh-web.service，由 **systemd** 负责在登录后拉起 dsh web —— 这是 WSL/Linux 下自启动的正确姿势。

## 特性

| 特性 | 说明 |
|---|---|
| 开机自启动 | systemd user service + lingering，登录/开机后自动拉起 dsh web |
| 幂等同步 | dsh 每次启动时按配置同步 unit；内容无变化则零操作 |
| 只 enable 不 start | 绝不与手动启动的 dsh web 抢端口 |
| 崩溃自愈 | Restart=on-failure，dsh web 异常退出后自动拉起 |
| 安全失败 | 任何失败只记日志，绝不影响 dsh 主流程 |
| dry-run | 预览将要执行的系统操作，不实际执行 |
| WSL 辅助 | 可选生成 Windows 侧 .cmd + schtasks 注册指引（WSL 发行版默认按需启动） |

## 安装

    dsh plugin --profile web add github:publieople/dsh-autostart

在 ~/.dsh/profiles/web/cordis.patch.yml 中启用：

    - insert:
        - id: dsh-autostart
          name: 'dsh-autostart'
          config:
            enabled: true
            port: 3080

重启 dsh（或 dsh reload）后生效。

## 配置项

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| enabled | boolean | false | 是否启用开机自启动（dsh 每次启动时按此同步 unit） |
| profile | string | "web" | 自启动的 profile 名（当前支持 web；headless 为一次性任务，不适合常驻） |
| host | string | "127.0.0.1" | dsh web 监听地址 |
| port | number | 3080 | dsh web 监听端口 |
| extraArgs | string[] | [] | 追加的 dsh CLI 参数，如 --trusted-host |
| nodePath | string | "" | node 绝对路径；留空自动用 process.execPath |
| dshPath | string | "" | dsh 可执行绝对路径；留空自动用 process.argv[1] |
| environment | object | {} | 额外 Environment= 键值（systemd 不继承 shell 环境，如 https_proxy） |
| enableLinger | boolean | true | 尝试确保 lingering；无权限时仅提示 |
| removeUnitOnDisable | boolean | false | enabled=false 时是否删除 unit 文件 |
| wslWindowsAutostart | boolean | false | 是否生成 Windows 侧辅助 .cmd + schtasks 注册指引 |
| dryRun | boolean | false | 只打印将执行的命令，不实际执行（预览/测试） |

## 一次性系统配置：lingering（关键）

WSL 下没有传统登录会话，**user service 必须开启 lingering 才会随系统启动**（否则只在有活跃会话时运行）：

    sudo loginctl enable-linger po   # po 换成你的用户名

插件会在日志中提示；无 sudo 权限时请手动执行。

## 常用命令

    systemctl --user status  dsh-web.service   # 查看状态
    systemctl --user start   dsh-web.service   # 手动启动
    systemctl --user stop    dsh-web.service   # 停止
    systemctl --user restart dsh-web.service   # 重启
    systemctl --user enable  dsh-web.service   # 开机自启（插件已自动执行）
    systemctl --user disable dsh-web.service   # 取消自启

## Windows 宿主侧自启（可选）

WSL 发行版默认"按需启动"（首次 wsl 命令才拉起）。要让 Windows 开机 → WSL → dsh 全链路自启，设置 wslWindowsAutostart: true，插件会生成 ~/dsh-autostart/wsl-autostart.cmd 并打印注册命令，二选一：

    schtasks /create /tn "dsh-autostart" /tr "\"C:\\Users\\<你>\\dsh-autostart\\wsl-autostart.cmd\"" /sc onlogon /f

或把该 .cmd 的快捷方式放进 Windows 启动文件夹（shell:startup）。

## 故障排查

| 现象 | 原因与处理 |
|---|---|
| 服务未随开机启动 | 未开 lingering：sudo loginctl enable-linger <user>；或 WSL 发行版未被拉起（配 Windows 侧自启） |
| 端口冲突/反复重启 | 手动实例与 systemd 实例抢端口：手动实例换端口，或 systemctl --user stop dsh-web |
| 提示非 systemd 环境 | 发行版未启用 systemd（WSL2 需在 /etc/wsl.conf 配置 [boot] systemd=true） |
| 服务没起来 | journalctl --user -u dsh-web.service -n 50 查日志 |

## 本地测试

    npm install        # 安装 devDependencies
    npm test           # node:test 单测

真机验证：

    dsh plugin --profile web add github:publieople/dsh-autostart
    # patch 里配置 enabled: true, dryRun: true → 重启 dsh，核对日志中的 [dry-run] 输出
    # 去掉 dryRun → 重启 dsh → systemctl --user is-enabled dsh-web.service

## 免责声明

第三方插件，使用前请自行审阅源码；本项目以 MIT 许可发布，按现状提供。
