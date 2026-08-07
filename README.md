# 腾讯元宝 OpenAI 代理 + New API + cc-switch 完整接入指南

## 架构总览

```
codex / claude-code / opencode
    ↓  (各自协议)
cc-switch (写配置文件/环境变量)
    ↓
New API (端口 3000, 管理后台)
    ↓  (OpenAI /v1/chat/completions)
yuanbao2api (端口 60809, proxy.js)
    ↓  (SSE /kfbackend/api/getYuanBaoAnswer)
腾讯元宝 (kf.qq.com)
```

## 一、启动 yuanbao2api

```bash
cd yuanbao2api
node ./proxy.js
```

默认端口 60809，启动后访问 `http://localhost:60809/` 测试聊天，`http://localhost:60809/admin` 管理后台。

## 二、New API 配置

### 2.1 添加分组（可选）

1. 登录 New API 管理后台 `http://localhost:3000`
2. **左侧菜单 → 系统设置 → 比例设置**
3. 找到 **分组比例** 区域，点击 **添加分组**
4. 填分组名称（如 `yuanbao`）、比例 `1`、勾选用户可选、填描述
5. 保存

### 2.2 添加渠道

1. **左侧菜单 → 渠道 → 新建渠道**
2. 填写：

| 字段 | 值 |
|------|----|
| 类型 | OpenAI |
| 名称 | 腾讯元宝 |
| Base URL | `http://localhost:60809/v1` |
| 密钥 | 任意填（yuanbao2api 默认不鉴权） |
| 模型 | `yuanbao,hunyuan,tencent-yuanbao` |
| 分组 | `default`（或你新建的分组名） |

3. 保存

### 2.3 生成 Token

1. **左侧菜单 → 令牌 → 新建令牌**
2. 填名称、选择分组（与渠道分组匹配）
3. 生成后复制 Token（格式 `sk-xxx`）

### 2.4 验证

在渠道列表点 **测试** 按钮，选择模型测试，返回正常即配置成功。

## 三、cc-switch 配置

打开 cc-switch，分别配置各工具：

### 3.1 接入 codex

切换到 **Codex** 标签 → 添加自定义 provider：

| 字段 | 值 |
|------|----|
| Name | 腾讯元宝 |
| API Key | `sk-xxx`（New API 生成的 Token） |
| Base URL | `http://localhost:3000/v1` |
| Model | `yuanbao` |

保存后激活，codex 重启即可使用。

### 3.2 接入 claude-code

切换到 **Claude** 标签 → 添加自定义 provider：

| 字段 | 值 |
|------|----|
| Name | 腾讯元宝 |
| API Key | `sk-xxx` |
| Base URL | `http://localhost:3000/v1` |

cc-switch 会设置 `ANTHROPIC_BASE_URL` 和 `ANTHROPIC_AUTH_TOKEN` 环境变量。New API 会自动将 Anthropic 协议转为 OpenAI 协议，链路畅通。

### 3.3 接入 opencode

切换到 **OpenCode** 标签 → 添加自定义 provider：

| 字段 | 值 |
|------|----|
| Name | 腾讯元宝 |
| API Key | `sk-xxx` |
| Base URL | `http://localhost:3000/v1` |
| Model | `yuanbao` |

保存后激活，opencode 重启即可使用。

## 四、验证完整链路

```bash
# 1. 测试 yuanbao2api
curl http://localhost:60809/health

# 2. 测试 New API 渠道
curl http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer sk-xxx" \
  -H "Content-Type: application/json" \
  -d '{"model":"yuanbao","messages":[{"role":"user","content":"你好"}],"stream":false}'

# 3. 在 codex/claude-code/opencode 中直接使用
```

## 五、注意事项

- yuanbao2api 和 New API 需同时运行
- Token 的分组必须与渠道的分组匹配才能使用
- 局域网调用 yuanbao2api 用 `http://你的IP:60809`，已监听 `0.0.0.0`
- 如需外网访问，建议加 Nginx 反代 + HTTPS
