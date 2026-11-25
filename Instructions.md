# dsh-atomcode 实现说明

> 这份文档讲**内部实现**：为什么要回环代理、签名怎么算、登录态从哪来、接口与排错。
> 想先装起来用，看 [README](README.md) 或 [English README](README.en.md)。

把 **AtomGit AtomCode 的 CodingPlan 模型**接进 DeepSeek Harness（DSH）的插件。

装上之后，DSH 的模型选择器里会多出一个 provider：**AtomGit AtomCode**，里面是 CodingPlan
当前可用、且已经领取（`plan_available: true`）的模型。

---

## 为什么需要"回环代理"这一层

AtomGit 的 LLM 网关（`https://llm-api.atomgit.com/v1`）不是普通的 OpenAI 兼容端点：

- 认证是 `Authorization: Bearer <AtomGit access_token>`，**另外**还要求五个签名头：
  `x-atomcode-sig` / `x-atomcode-ts` / `x-atomcode-nonce` / `x-atomcode-alg` / `x-atomcode-ver`；
- 只带 Bearer 会得到 `403 ATOMCODE_SIG_MISSING`（"请升级到最新版 AtomCode 后再试。"）；
- 签名是 **对请求体字节** 做的 HMAC，pi-ai 侧没法在"已经序列化好"之后插手。

所以插件起一个只监听 `127.0.0.1` 的小代理：

```
DSH / pi-ai  ──(OpenAI /chat/completions, Bearer=回环随机口令)──▶  127.0.0.1:<随机端口>
                                                                      │ 取 auth.toml 的 token
                                                                      │ X-AtomCode-* 签名
                                                                      ▼
                                                     https://llm-api.atomgit.com/v1/chat/completions
```

对 DSH 来说，它只是"又一个 OpenAI 兼容 provider"，签名细节全部藏在代理里。

### 签名算法

```
salt        = user_id ‖ 0x01 ‖ uint64_le(ts / 3600) ‖ sha256(token) ‖ sha256(client_version)
prk         = HMAC-SHA256(key=salt, data=MASTER_KEY)                    # HKDF-Extract
signing_key = HMAC-SHA256(key=prk,  data="atomcode-signing-v1" ‖ 0x01)  # HKDF-Expand
canonical   = "v1\n" ‖ METHOD ‖ "\n" ‖ path ‖ "\n" ‖ ts ‖ "\n" ‖ hex(nonce) ‖ "\n" ‖ sha256(body)
sig         = "v1:" ++ hex(HMAC-SHA256(signing_key, canonical))
```

- `MASTER_KEY = e97250f05303162c8ecd68c688b2f55c1d81e508d243d88466472e7f54637123`
- `path` 是**网关侧的**路径（base URL 的 path + `/chat/completions`），例如
  `https://llm-api.atomgit.com/v1` → `/v1/chat/completions`；
- `body` 必须是**真正发出去的那串字节**，不能重新序列化（顺序/空格都会让签名失效）；
- `nonce` 16 字节随机，`ts` 是 Unix 秒，`client_version` 目前是 `5.2.7`。

`lib/sign.js` 里的实现已用 7 条从官方 CLI 抓下来的真实请求逐字节核对（校验脚本是本地开发工具，不入库），
并用它直接打通了线上网关（HTTP 200 + SSE）。

### 密钥与安全边界

- `MASTER_KEY` 是**客户端协议常量**，随官方二进制分发，不是用户密钥。它能证明的只是
  "调用方实现了 AtomCode 签名协议"，不带来账号权限：网关仍然校验 `Authorization`，
  派生密钥绑定 `sha256(token) + user_id`，没有 token 既不能反推也不能冒充别人。
- 代价是客户端身份校验（attestation）没有秘密可言——任何第三方客户端都能签出同样的头。
  这是"把对称密钥放进客户端"这一设计的固有限制，不是本插件引入的。
- 签名**不防重放**：派生密钥按 `floor(ts / 3600)` 分桶，nonce 只进签名串、不进密钥。
  同一小时内抓到的完整请求可原样重发；要防只能由网关侧缓存 nonce / 限制 ts 偏移。
- 两处默认值都可用环境变量覆盖，供应方轮换时不用改代码、不用发版：
  `ATOMCODE_MASTER_KEY`（32 字节 hex，长度不对会直接报错）、
  `ATOMCODE_CLIENT_VERSION`（默认 `5.2.7`）。

---

## 登录态来自哪里

插件**不自己造账号体系**，直接复用 AtomCode 官方 CLI 的登录结果：

```
~/.atomcode/auth.toml        # ATOMCODE_HOME 可覆盖
```

里面有 `access_token` / `refresh_token` / `expires_in` / `created_at` / `[user] id`。
所以最短路径是：

```bash
atomcode login      # 浏览器授权一次
```

插件启动时读这个文件；token 快过期时用 `refresh_token` 换新的，并**写回同一个文件**
（AtomGit 的 refresh 会轮换 `refresh_token`，所以两边共享同一份登录态）。

也可以完全不装 CLI，让插件自己走一遍 OAuth（`POST /api/atomcode/login`）：
它调 `GET https://acs.atomgit.com/auth/login?provider=atomgit` 拿 `login_url`，
浏览器授权后轮询 `/auth/check`，再 `/auth/token` 换回 token，同样写进 `~/.atomcode/auth.toml`。

---

## 安装

要求：DSH ≥ `0.1.2-rc.1`，Node `^22.19.0 || >=24.0.0`。**纯 JS，无需构建。**

1. 把仓库放到任意目录（或 `npm pack` 成 tarball）；
2. 在 DSH 里用 `plugin_manager` 的 `install_bundle`，`target` 指向该目录 / tarball；
3. 在 Plugins 页启用 `dsh-atomcode`；
4. 首次装完**刷新一次页面**（浏览器半在启动时组装，宿主半不用重启）。

登录：

```bash
atomcode login          # 装过 AtomCode CLI 的话，复用它的 auth.toml 即可
# 或让插件自己走 OAuth（面板上的「登录」按钮 / POST /api/atomcode/login）
```

宿主侧（HTTP 路由 / provider）改完用「禁用 → 启用」热重载，不必重启 DSH。

---

## 配置项

`cordis.patch.yml` 里给 `llm-atomcode` 的 config：

| 键 | 默认值 | 说明 |
| --- | --- | --- |
| `enabledModels` | `[]` | 只暴露这些模型 id；空数组 = 全开 |
| `planType` | `""` | 查 `models-v2` 时带的 `plan_type`；空则从 `status-v2` 自动读 |
| `platformBase` | `https://acs.atomgit.com` | OAuth broker（登录 / 换 token / 刷新） |
| `apiBase` | `https://api.gitcode.com/api/v5` | CodingPlan 控制面（status / models / claim / usage） |
| `llmBase` | `https://llm-api.atomgit.com/v1` | LLM 网关（会强制验签） |
| `refreshIntervalMinutes` | `60` | 模型清单刷新间隔（最小 5 分钟） |
| `clientVersion` | `5.2.7` | 签名盐里用的客户端版本号 |

想换端点（比如 `api-ai.gitcode.com`——它不验签、只拦 `atomcode/*` UA）改 `llmBase` 即可。

---

## HTTP 接口

全部只接受本机回环请求（`127.0.0.1` / `::1`），挂在 DSH 自己的 Web 端口上：

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/api/atomcode/status` | 登录态、套餐、用量窗口、模型清单、注册状态 |
| GET | `/api/atomcode/usage` | 近 60 天按天聚合的调用次数与 tokens（面板图表用） |
| POST | `/api/atomcode/login` | 发起 OAuth：返回 `login_url`，轮询到授权完成为止 |
| GET | `/api/atomcode/login` | 查询当前登录流程的状态 |
| POST | `/api/atomcode/logout` | 清掉内存与磁盘上的登录态 |
| POST | `/api/atomcode/refresh` | 强制刷新模型清单 |
| POST | `/api/atomcode/claim` | 按 Max → Pro → Lite 顺序领取可用套餐 |
| GET | `/api/atomcode/probe?model=` | 走 DSH 的 `resolveModelInfo`，确认模型能被解析 |
| GET | `/api/atomcode/chat?model=&prompt=` | 真发一次补全（排障用，返回流式块汇总） |

```powershell
# 看现在能不能用
Invoke-WebRequest http://127.0.0.1:<DSH端口>/api/atomcode/status -UseBasicParsing | % Content

# 端到端试一发
Invoke-WebRequest 'http://127.0.0.1:<DSH端口>/api/atomcode/chat?model=qwen3.8-27b&prompt=hello' -UseBasicParsing | % Content
```

---

## 侧边栏面板

左侧图标栏多一格 **AtomCode**（order 60，排在 CodeArts 之后），点开是主面板：

- **账号**：登录状态、`name · @username`、`auth.toml` 路径、token 到期时间
- **套餐**：`CodingPlan Lite-体验版` / Pro 名称、`claimed_at → expires_at`、剩余天数、档位 pill
- **本窗口调用**：`calls_used / call_limit` + 进度条 + 重置倒计时（5 小时滚动窗口）
- **额度窗口**：`rate_limit_windows` 里 `show_enable == 1` 的每一条，含 `reset_label`
- **近 60 天用量**：按天柱状图（悬停看次数/tokens）+ 每个模型的占比条、调用次数、tokens
- **可用模型**：上下文、输出上限、是否视觉、推理档位
- **操作**：刷新 / 领取套餐 / 登录（弹出 `login_url`）/ 退出登录

面板数据每 60 秒自动轮询一次，倒计时每 30 秒刷新。展示字段与官方
`atomgit.com/dashboard/resource-usage?tab=coding-plan` 对齐（套餐、窗口额度、按天用量、
分模型统计），只是数据走本机回环接口而不是网页。

浏览器半在 `lib/client/index.js`，是**手写**的 `window.__ModuleLoader__.load({id, factory})`
包（不引构建链），只用 `react` + 宿主主题变量（`--dsw-alias-*`）画界面：

```
sidebar.panellist  id=dsh-atomcode, order=60   → 图标按钮
main               key=dsh-atomcode            → 主面板
settings.section   id=dsh-atomcode, order=60   → 设置左侧入口（同一个面板）
```

`package.json` 里对应声明：

```json
"exports": { "./client": "./lib/client/index.js" },
"dsh": { "client": { "platform": "web", "inject": ["@deepseek-ai/dsh-client-ui-renderer"] } }
```

> 浏览器半只在页面加载时组合一次：装好插件或改过 `dsh.client` 后需要**刷新一次页面**
> （Ctrl+R）才会出现那一格。宿主半（HTTP 路由、provider）用
> `plugin_manager set_bundle` 关再开即可热重载，不必重启 DSH。

---

## 模型来源

`models-v2?plan_type=<档位>` 返回的条目会被规整成 pi-ai 的模型描述：

- `display_model_name` → 模型 id（如 `qwen3.8-27b`）
- `context_window` 有 128k 下限（服务端给更小就抬到 128k，给更大就照用）
- `max_tokens` 缺省 32000
- `supports_vision` → 是否开图像输入
- `reasoning_effort_levels` → 推理档位；**没声明的档位会被显式钉成 `null`**，
  否则 pi-ai 会把"未提及"当成"支持"，UI 上就会给只支持 `high` 的模型列出 `off/low/medium`
- 只注册 `plan_available: true` 的模型

控制面拿不到时退回内置种子（`qwen3.8-27b`、`glm5.3-flash`），保证断网也能选出模型。

---

## 排错

| 现象 | 原因 / 处理 |
| --- | --- |
| `403 ATOMCODE_SIG_MISSING` | 签名没带上或算法漂了；确认走的是插件的回环代理而不是直连网关 |
| `401 ... token rejected` | `auth.toml` 里的 token 失效；`POST /api/atomcode/refresh` 或重跑 `atomcode login` |
| `403 model is not enabled for codingplan 'Lite-beta'` | 该模型不在当前套餐里；`/api/atomcode/status` 看 `planAvailable` |
| `models-v2` 400 `Required request parameter 'plan_type'` | `planType` 为空且 `status-v2` 没读到；手动配 `planType` |
| 刷新 token 后 CLI 掉登录 | 正常：AtomGit 会轮换 `refresh_token`，两边共用 `auth.toml`，以最后写入的为准 |
| 面板点「退出登录」后 CLI 也掉登录 | 预期行为：会删除共用的 `auth.toml`，CLI 需要重新登录；不想影响 CLI 就不要点这个按钮 |
| 模型列表是空的 | 看 `/api/atomcode/status` 的 `lastError` / `modelsSource`（`server` 还是 `fallback`） |

调试日志：设 `DSH_ATOMCODE_DEBUG=1` 启动 DSH，插件会往 stderr 打 `[dsh-atomcode] ...`。

---

## 目录

```
lib/
  sign.js        # X-AtomCode-* 签名（HKDF + HMAC-SHA256）
  auth.js        # auth.toml 读写、OAuth 登录、refresh 轮换
  codingplan.js  # status-v2 / models-v2 / usage / claim-v2
  catalog.js     # 模型条目规整 + 缓存 + 种子回退
  shim.js        # 127.0.0.1 回环代理：签名后转发 /chat/completions
  adapter.js     # pi-ai provider `atomcode`
  index.js       # 插件入口：注册 adapter、定时刷新、HTTP 路由
  client/
    index.js     # 浏览器半：侧边栏图标 + 主面板（手写 CJS bundle）
```

测试与冒烟脚本放在本地 `test/` 目录，按 `.gitignore` 不入库；需要时直接 `node --test "test/*.test.mjs"`，或单独 `node test/smoke-shim.mjs`。

## 已知限制

- 只代理 `/chat/completions`；`/responses`、embeddings、rerank 都还没接。
- 一个进程一套登录态；多账号轮换没做（AtomCode 官方 CLI 的 `account` 概念也还没搬过来）。
- 用量/额度只读展示（来自 `status-v2`），不做本地记账。
- 网关目前把客户端版本算进签名盐，换大版本时需要同步 `clientVersion`（或设 `ATOMCODE_CLIENT_VERSION`）。
- 面板的「退出登录」删的是与 CLI 共用的 `auth.toml`；正在运行的 CLI 可能把文件重新写回来。
- 签名不防重放（见上文「密钥与安全边界」），只能由网关侧修。

## 隐私

- 登录态只落在本机 `~/.atomcode/auth.toml`，由你本机的 AtomCode CLI 与 DSH 共用；
  插件不保存第二份副本，也不往任何第三方服务器发。
- 回环代理只监听 `127.0.0.1`，且要求 `Authorization: Bearer <每进程随机口令>`；
  `/api/atomcode/*` 路由额外校验请求来自回环地址。
- 仓库里**不含**任何真实 token、用户 id、邮箱或绝对路径：测试全部用 fixture，
  抓包校验脚本的 token 从环境变量读。
- 别把 `auth.toml`、`capture-log.jsonl` 之类的运行期产物提交进仓库（见 `.gitignore`）。

## 许可

MIT，见 [LICENSE](LICENSE)。