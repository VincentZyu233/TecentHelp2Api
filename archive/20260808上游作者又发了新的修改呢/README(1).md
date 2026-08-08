# 元宝 OpenAI 兼容代理 (Yuanbao OpenAI Proxy)

将腾讯元宝（腾讯客服 AI）接口转换为 OpenAI API 兼容格式，支持流式/非流式响应、Function Call 适配、配置热加载和可视化管理后台。

## 特性

- **OpenAI API 兼容** — 直接替换 `base_url` 即可接入现有 OpenAI 客户端
- **Function Call 适配** — 通过 prompt 注入 + 固定格式输出解析，让不支持原生 tools 的元宝接口兼容 OpenAI tools 协议
- **流式 SSE** — 支持 `stream: true` 流式输出
- **配置热加载** — 修改 `config.json` 或通过管理页面保存，0.5 秒内自动生效，无需重启
- **管理后台** — Web 可视化界面，支持配置编辑、运行监控、Function Call 测试
- **旧接口透传** — `/kfbackend/*` 原样转发，向后兼容现有网页
- **安全加固** — API Key 鉴权、CORS 白名单、路径遍历防护、请求体限制、并发控制
- **TLS 连接池** — keep-alive 复用连接，减少握手开销

## 快速开始

### 环境要求

- Node.js >= 18（推荐 22）

### 运行

```bash
cd yuanbao-openai-proxy
node proxy.js
```

启动后：

| 地址 | 说明 |
|------|------|
| `http://localhost:8080/` | 测试聊天页面 |
| `http://localhost:8080/admin` | 管理后台 |
| `http://localhost:8080/health` | 健康检查 |
| `http://localhost:8080/v1/chat/completions` | OpenAI 兼容接口 |
| `http://localhost:8080/v1/models` | 模型列表 |

### 测试

```bash
# 非流式请求
curl http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "yuanbao",
    "messages": [{"role": "user", "content": "你好"}],
    "stream": false
  }'

# 流式请求
curl -N http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "yuanbao",
    "messages": [{"role": "user", "content": "你好"}],
    "stream": true
  }'

# 运行完整测试脚本
bash test.sh
```

## 部署方式

### PM2（推荐生产环境）

```bash
npm install -g pm2
mkdir -p logs
pm2 start ecosystem.config.js
pm2 save
pm2 startup   # 开机自启
```

常用命令：

```bash
pm2 logs yuanbao-openai-proxy   # 查看日志
pm2 restart yuanbao-openai-proxy
pm2 stop yuanbao-openai-proxy
pm2 delete yuanbao-openai-proxy
```

### Docker

```bash
docker build -t yuanbao-proxy .
docker run -d -p 8080:8080 -v $(pwd)/config.json:/app/config.json --name yuanbao-proxy yuanbao-proxy
```

挂载 `config.json` 可以持久化配置修改。

### systemd

```bash
sudo cp yuanbao-proxy.service /etc/systemd/system/
sudo mkdir -p /opt/yuanbao-openai-proxy
sudo cp proxy.js config.json index.html admin.html /opt/yuanbao-openai-proxy/
sudo systemctl daemon-reload
sudo systemctl enable --now yuanbao-proxy
```

## 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `PORT` | 监听端口（也可在 config.json 配置） | `8080` |
| `HTTPS_PROXY` | 出站代理（内网环境需要） | 无 |

> API Key 等其他配置通过 `config.json` 或管理后台设置，不依赖环境变量。

## 配置说明

所有配置集中在 `config.json`，支持通过管理后台或直接编辑文件修改：

```json
{
  "port": 8080,
  "apiKey": "",
  "defaultUserId": "oIJ9428d51b28d039a107af55343e3f969f",
  "corsOrigins": ["*"],
  "maxBodySize": 10485760,
  "maxConcurrent": 20,
  "requestTimeoutMs": 60000,
  "retryCount": 1,
  "retryDelayMs": 1000,
  "keepAlive": true,
  "functionCall": {
    "enabled": true,
    "detectionBuffer": 200,
    "marker": "<tool_call>",
    "markerEnd": "</tool_call>",
    "systemPrompt": "..."
  },
  "logging": {
    "level": "info",
    "maskSensitive": true
  }
}
```

| 字段 | 说明 |
|------|------|
| `apiKey` | API Key 鉴权，空值不鉴权 |
| `corsOrigins` | 允许的 CORS 来源列表，生产环境建议限定域名 |
| `maxConcurrent` | 最大并发请求数，超出返回 429 |
| `maxBodySize` | 请求体大小上限（字节） |
| `requestTimeoutMs` | 请求超时（毫秒） |
| `keepAlive` | 是否启用 TLS 连接池 |
| `functionCall.enabled` | 是否启用 Function Call 适配 |
| `functionCall.detectionBuffer` | 流式检测窗口大小（字符数） |
| `functionCall.marker` / `markerEnd` | tool call 输出标记 |
| `functionCall.systemPrompt` | 注入 prompt 模板，`{tools_schema}` 为占位符 |
| `logging.level` | 日志级别：debug / info / warn / error |
| `logging.maskSensitive` | 管理接口中脱敏敏感字段 |

## Function Call 适配原理

元宝接口不支持原生 function call，本代理通过以下方式实现兼容：

```
┌──────────────────────────────────────────────────────────────┐
│  1. 请求转换                                                  │
│     OpenAI tools 定义 → 自然语言描述 → 注入到 query 开头       │
│                                                              │
│  2. 模型推理                                                  │
│     元宝按指令输出固定格式：                                    │
│     <tool_call>{"name":"get_weather","arguments":{...}}</tool_call> │
│                                                              │
│  3. 输出解析                                                  │
│     非流式：完整输出后解析标记 → 返回 OpenAI tool_calls 格式    │
│     流式：缓冲前 N 字符检测 → 命中返回 tool_calls chunk        │
│                              未命中则透传为普通 content         │
│                                                              │
│  4. 多轮对话                                                  │
│     tool 返回结果转为自然语言拼入 query，支持连续多轮工具调用    │
└──────────────────────────────────────────────────────────────┘
```

### Function Call 测试示例

```bash
curl http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "yuanbao",
    "messages": [{"role": "user", "content": "深圳天气怎么样？"}],
    "tools": [{
      "type": "function",
      "function": {
        "name": "get_weather",
        "description": "获取指定城市的天气信息",
        "parameters": {
          "type": "object",
          "properties": {
            "city": {"type": "string", "description": "城市名称"}
          },
          "required": ["city"]
        }
      }
    }],
    "stream": false
  }'
```

如果模型判断需要调用工具，返回：

```json
{
  "choices": [{
    "message": {
      "role": "assistant",
      "content": null,
      "tool_calls": [{
        "id": "call-xxxx",
        "type": "function",
        "function": {
          "name": "get_weather",
          "arguments": "{\"city\":\"深圳\"}"
        }
      }]
    },
    "finish_reason": "tool_calls"
  }]
}
```

也可以在管理后台「测试」标签页可视化测试 Function Call。

## API 接口

### OpenAI 兼容接口

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/v1/chat/completions` | 对话补全（流式 + 非流式 + function call） |
| GET | `/v1/models` | 模型列表 |

### 管理接口

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/admin` | 管理后台页面 |
| GET | `/api/config` | 读取配置 |
| POST | `/api/config` | 保存配置（热加载） |
| GET | `/api/stats` | 运行统计 |
| GET | `/health` | 健康检查 |

### 旧接口透传

所有 `/kfbackend/*`、`/kf-backend/*`、`/cgi-bin/*` 请求原样透传到 `kf.qq.com`，保持向后兼容。

## 文件说明

| 文件 | 说明 |
|------|------|
| `proxy.js` | 核心代理服务 |
| `config.json` | 配置文件（支持热加载） |
| `admin.html` | 管理后台页面 |
| `index.html` | 测试聊天页面 |
| `test.sh` | 命令行测试脚本 |
| `ecosystem.config.js` | PM2 配置 |
| `Dockerfile` | Docker 镜像配置 |
| `yuanbao-proxy.service` | systemd 服务配置 |

## 接入 OpenAI 客户端

### Python (openai 库)

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:8080/v1",
    api_key="your-api-key"  # 与 config.json 中 apiKey 一致，留空则传任意值
)

response = client.chat.completions.create(
    model="yuanbao",
    messages=[{"role": "user", "content": "你好"}],
    stream=True
)

for chunk in response:
    print(chunk.choices[0].delta.content or "", end="")
```

### JavaScript / Node.js

```javascript
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "http://localhost:8080/v1",
  apiKey: "your-api-key",
});

const response = await client.chat.completions.create({
  model: "yuanbao",
  messages: [{ role: "user", content: "你好" }],
});

console.log(response.choices[0].message.content);
```

### cURL

```bash
curl http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-api-key" \
  -d '{
    "model": "yuanbao",
    "messages": [{"role": "user", "content": "你好"}]
  }'
```

## 生产部署建议

1. **设置 API Key** — 在管理后台或 `config.json` 中设置 `apiKey`，避免未授权访问
2. **限定 CORS** — 将 `corsOrigins` 从 `["*"]` 改为具体域名
3. **反向代理** — 用 Nginx 做前置，加 HTTPS 和限流
4. **日志持久化** — PM2 模式下日志在 `logs/` 目录；Docker 模式挂载日志卷
5. **进程守护** — 推荐用 PM2 或 systemd，自动重启

### Nginx 反向代理示例

```nginx
server {
    listen 443 ssl;
    server_name ai-proxy.example.com;

    ssl_certificate     /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;

        # SSE 支持
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 300s;
    }
}
```

## License

MIT
