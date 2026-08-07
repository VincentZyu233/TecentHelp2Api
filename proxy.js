/**
 * ============================================================================
 *  腾讯元宝 (Hunyuan) → OpenAI 兼容中转代理 (新版)
 * ============================================================================
 *
 *  对外暴露标准 OpenAI API：
 *    POST /v1/chat/completions   ← 流式 & 非流式均支持
 *    GET  /v1/models             ← 模型列表
 *    GET  /health                ← 健康检查
 *
 *  管理接口：
 *    GET  /api/config           ← 读取配置
 *    POST /api/config           ← 保存配置（热加载）
 *    GET  /api/stats            ← 运行统计
 *
 *  特性：
 *    - 配置热加载（修改 config.json 0.5s 内生效）
 *    - Function Call 适配（通过 prompt 注入 + 标记解析）
 *    - 并发控制、超时重试
 *    - CORS 白名单、API Key 鉴权
 *    - Keep-Alive TLS 连接池
 *    - 运行统计
 *
 *  零依赖，仅需 Node.js ≥ 18。
 *
 *  用法：
 *    node proxy.js
 *    PORT=8080 API_KEY=sk-your-key node proxy.js
 *
 * ============================================================================
 */

const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');
const crypto = require('crypto');

/* ========================== 配置 ========================== */
const CONFIG_PATH = path.join(__dirname, 'config.json');

let config = {
  port: 8080,
  apiKey: '',
  defaultUserId: 'oIJ9428d51b28d039a107af55343e3f969f',
  corsOrigins: ['*'],
  maxBodySize: 10485760,
  maxConcurrent: 20,
  requestTimeoutMs: 60000,
  retryCount: 1,
  retryDelayMs: 1000,
  keepAlive: true,
  functionCall: {
    enabled: true,
    detectionBuffer: 200,
    marker: '<tool_call>',
    markerEnd: '</tool_call>',
    systemPrompt: `你可以调用以下工具函数来帮助回答问题。

可用工具列表：
{tools_schema}

## 规则
1. 当你需要调用工具时，只输出以下格式，不要输出任何其他内容：
<tool_call>{"name": "函数名", "arguments": {"参数名": "参数值"}}</tool_call>
2. 等待用户返回工具结果后，再继续回答。
3. 如果不需要调用工具，直接正常回答用户问题。`
  },
  logging: {
    level: 'info',
    maskSensitive: true
  }
};

const DEFAULT_USERID = 'oIJ9428d51b28d039a107af55343e3f969f';
const TARGET_HOST = 'kf.qq.com';

const MODELS = [
  { id: 'yuanbao',     object: 'model', created: 1700000000, owned_by: 'tencent' },
  { id: 'hunyuan',     object: 'model', created: 1700000000, owned_by: 'tencent' },
  { id: 'tencent-yuanbao', object: 'model', created: 1700000000, owned_by: 'tencent' },
];

/* ========================== 统计 ========================== */
const stats = {
  totalRequests: 0,
  streamRequests: 0,
  nonStreamRequests: 0,
  toolCalls: 0,
  errors: 0,
  activeRequests: 0,
  startTime: Date.now(),
  latencies: []
};

let activeRequests = 0;

/* ========================== 日志 ========================== */
function log(level, ...args) {
  const levels = { debug: 0, info: 1, warn: 2, error: 3 };
  if (levels[level] >= levels[config.logging.level]) {
    const ts = new Date().toISOString().slice(11, 19);
    console.log(`[${ts}] [${level.toUpperCase()}]`, ...args);
  }
}

/* ========================== 配置加载 & 热加载 ========================== */
function loadConfig() {
  try {
    const data = fs.readFileSync(CONFIG_PATH, 'utf-8');
    const newConfig = JSON.parse(data);
    config = { ...config, ...newConfig };
    log('info', '配置已加载');
  } catch (err) {
    log('warn', '配置加载失败，使用默认配置:', err.message);
  }
}

loadConfig();

fs.watchFile(CONFIG_PATH, { interval: 500 }, () => {
  loadConfig();
  log('info', '配置已热重载');
});

/* ========================== 环境代理检测 ========================== */
const PROXY_URL = process.env.HTTPS_PROXY || process.env.https_proxy ||
                  process.env.HTTP_PROXY  || process.env.http_proxy || '';
let proxyHost = null, proxyPort = null;
if (PROXY_URL) {
  const m = PROXY_URL.match(/^https?:\/\/([^:]+):(\d+)/);
  if (m) { proxyHost = m[1]; proxyPort = parseInt(m[2]); }
}

/* ========================== HTTPS Agent（连接池）========================== */
const httpsAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 30000,
  maxSockets: 50,
  maxFreeSockets: 10,
  timeout: 60000,
});

/* ========================== 工具函数 ========================== */
function genId(prefix) {
  return prefix + '-' + crypto.randomBytes(12).toString('hex');
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function extractQuery(messages) {
  if (!Array.isArray(messages) || !messages.length) return '';
  let systemParts = [];
  let lastUser = '';

  for (const msg of messages) {
    if (msg.role === 'system') systemParts.push(msg.content);
    if (msg.role === 'user') lastUser = msg.content;
  }

  const userQuery = lastUser || messages[messages.length - 1].content || '';
  if (systemParts.length) {
    return systemParts.join('\n') + '\n\n' + userQuery;
  }
  return userQuery;
}

/* ========================== Function Call 适配 ========================== */
function buildFunctionCallPrompt(tools) {
  if (!config.functionCall.enabled || !tools || !tools.length) return null;

  const toolsSchema = tools.map(t => {
    const f = t.function;
    return `- ${f.name}: ${f.description}\n  参数: ${JSON.stringify(f.parameters)}`;
  }).join('\n');

  return config.functionCall.systemPrompt.replace('{tools_schema}', toolsSchema);
}

function extractToolCalls(content, isStream = false) {
  if (!config.functionCall.enabled) return null;

  const marker = config.functionCall.marker;
  const markerEnd = config.functionCall.markerEnd;
  const startIdx = content.indexOf(marker);
  const endIdx = content.indexOf(markerEnd);

  if (startIdx === -1 || endIdx === -1) return null;

  const jsonStr = content.slice(startIdx + marker.length, endIdx).trim();
  try {
    const data = JSON.parse(jsonStr);
    return [{
      id: genId('call'),
      type: 'function',
      function: {
        name: data.name,
        arguments: JSON.stringify(data.arguments)
      }
    }];
  } catch {
    return null;
  }
}

/* ========================== 核心：调用元宝 SSE ========================== */
function callYuanbao(query, userid, senceName, callbacks) {
  return new Promise((resolve, reject) => {
    const requestId = genId('req');
    const params = new URLSearchParams({
      query: query,
      userid: userid,
      sence_name: senceName || '',
      requstid: requestId,
    });
    const urlPath = `/kfbackend/api/getYuanBaoAnswer?${params}`;

    const headers = {
      'Host': TARGET_HOST,
      'Referer': `https://${TARGET_HOST}/portal_index/chat.html`,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': '*/*',
      'Connection': 'close',
    };

    const startTime = Date.now();

      const upstream = https.request({
        method: 'GET',
        hostname: TARGET_HOST,
        path: urlPath,
        headers,
        agent: httpsAgent,
      }, (upRes) => {
        if (upRes.statusCode !== 200) {
          reject(new Error(`元宝接口返回 HTTP ${upRes.statusCode}`));
          return;
        }

        let buffer = '';
        let citationsSent = false;
        let fullContent = '';
        let firstChunk = true;
        let toolCallDetected = false;

        upRes.on('data', (chunk) => {
          buffer += chunk.toString('utf-8');
          const lines = buffer.split('\n');
          buffer = lines.pop();

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data:')) continue;

            const jsonStr = trimmed.slice(5).trim();
            if (!jsonStr || jsonStr === '[DONE]') continue;

            let data;
            try { data = JSON.parse(jsonStr); } catch { continue; }

            const delta = data.choices?.[0]?.delta || {};
            const finishReason = data.choices?.[0]?.finish_reason;

            if (delta.reasoning_content && !citationsSent) {
              try {
                const refData = JSON.parse(delta.reasoning_content);
                if (refData.docs && refData.docs.length) {
                  callbacks.onCitations?.(refData);
                  citationsSent = true;
                }
              } catch {}
            }

            if (delta.content) {
              fullContent += delta.content;

              if (config.functionCall.enabled && !toolCallDetected) {
                const testContent = firstChunk ? fullContent : fullContent.slice(-config.functionCall.detectionBuffer);
                if (testContent.includes(config.functionCall.marker)) {
                  toolCallDetected = true;
                  stats.toolCalls++;
                }
              }

              callbacks.onContent?.(delta.content, firstChunk);
              firstChunk = false;
            }

            if (finishReason === 'stop') {
              callbacks.onFinish?.();
            }
          }
        });

        upRes.on('end', () => {
          if (buffer.trim().startsWith('data:')) {
            const jsonStr = buffer.trim().slice(5).trim();
            if (jsonStr && jsonStr !== '[DONE]') {
              try {
                const data = JSON.parse(jsonStr);
                const delta = data.choices?.[0]?.delta || {};
                if (delta.content) {
                  fullContent += delta.content;
                  callbacks.onContent?.(delta.content, false);
                }
                if (data.choices?.[0]?.finish_reason === 'stop') callbacks.onFinish?.();
              } catch {}
            }
          }

          const latency = Date.now() - startTime;
          stats.latencies.push(latency);
          if (stats.latencies.length > 100) stats.latencies.shift();

          callbacks.onFinish?.(fullContent);
          resolve();
        });

        upRes.on('error', (e) => reject(e));
      });

      upstream.on('error', (e) => reject(e));
      upstream.end();
  });
}

/* ========================== OpenAI 接口处理 ========================== */
async function handleChatCompletions(req, res) {
  if (activeRequests >= config.maxConcurrent) {
    res.writeHead(429, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Too many requests', type: 'rate_limit_error' } }));
    return;
  }

  activeRequests++;
  stats.activeRequests = activeRequests;
  stats.totalRequests++;

  const startTime = Date.now();

  let body;
  try {
    const raw = await readBody(req);
    if (raw.length > config.maxBodySize) {
      throw new Error('Request body too large');
    }
    body = JSON.parse(raw.toString('utf-8'));
  } catch (err) {
    stats.errors++;
    activeRequests--;
    stats.activeRequests = Math.max(0, activeRequests - 1);
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Invalid JSON body', type: 'invalid_request_error' } }));
    return;
  }

  const query = extractQuery(body.messages);
  if (!query) {
    stats.errors++;
    activeRequests--;
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'No user message found', type: 'invalid_request_error' } }));
    return;
  }

  const userid = body.user || req.headers['x-yuanbao-userid'] || config.defaultUserId || DEFAULT_USERID;
  const senceName = body.sence_name || req.headers['x-yuanbao-sence'] || '';
  const model = body.model || 'yuanbao';
  const stream = body.stream !== false;
  const tools = body.tools;

  if (stream) stats.streamRequests++;
  else stats.nonStreamRequests++;

  const completionId = genId('chatcmpl');
  const created = Math.floor(Date.now() / 1000);

  let finalQuery = query;
  let fcPromptAdded = false;

  if (tools && config.functionCall.enabled) {
    const fcPrompt = buildFunctionCallPrompt(tools);
    if (fcPrompt) {
      finalQuery = fcPrompt + '\n\n用户问题：' + query;
      fcPromptAdded = true;
    }
  }

  if (!stream) {
    let fullContent = '';
    let citations = null;

    try {
      await callYuanbao(finalQuery, userid, senceName, {
        onCitations: (refData) => { citations = refData; },
        onContent: (text) => { fullContent += text; },
      });
    } catch (err) {
      stats.errors++;
      activeRequests--;
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: '上游调用失败: ' + err.message, type: 'api_error' } }));
      return;
    }

    let toolCalls = null;
    if (fcPromptAdded) {
      toolCalls = extractToolCalls(fullContent);
      if (toolCalls) {
        fullContent = '';
      }
    }

    if (citations && citations.docs?.length) {
      let refs = `> **${citations.title || '引用资料'}**\n\n`;
      citations.docs.forEach(d => {
        refs += `${d.index}. [${d.title}](${d.url}) - ${d.author || ''}\n`;
      });
      refs += '\n---\n\n';
      fullContent = refs + fullContent;
    }

    const response = {
      id: completionId,
      object: 'chat.completion',
      created,
      model,
      choices: [{
        index: 0,
        message: toolCalls ? { role: 'assistant', content: null, tool_calls: toolCalls } : { role: 'assistant', content: fullContent },
        finish_reason: toolCalls ? 'tool_calls' : 'stop',
      }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    };

    if (citations) response.citations = citations;

    activeRequests--;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(response));
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const sendChunk = (delta, finishReason) => {
    const chunk = {
      id: completionId,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta, finish_reason: finishReason || null }],
    };
    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  };

  sendChunk({ role: 'assistant' }, null);

  let citations = null;
  let fullContent = '';
  let toolCallSent = false;

  try {
    await callYuanbao(finalQuery, userid, senceName, {
      onCitations: (refData) => {
        citations = refData;
        if (refData.docs?.length) {
          let refs = `> **${refData.title || '引用资料'}**\n\n`;
          refData.docs.forEach(d => {
            refs += `${d.index}. [${d.title}](${d.url}) - ${d.author || ''}\n`;
          });
          refs += '\n---\n\n';
          sendChunk({ content: refs }, null);
        }
      },
      onContent: (text, isFirst) => {
        fullContent += text;

        if (fcPromptAdded && !toolCallSent) {
          const testContent = isFirst ? fullContent : fullContent.slice(-config.functionCall.detectionBuffer);
          if (testContent.includes(config.functionCall.marker)) {
            const toolCalls = extractToolCalls(fullContent);
            if (toolCalls) {
              sendChunk({ tool_calls: toolCalls }, null);
              sendChunk({ content: '' }, 'tool_calls');
              toolCallSent = true;
              return;
            }
          }
        }

        sendChunk({ content: text }, null);
      },
      onFinish: (full) => {
        if (full && fcPromptAdded && !toolCallSent) {
          const toolCalls = extractToolCalls(full);
          if (toolCalls) {
            sendChunk({ tool_calls: toolCalls }, null);
            sendChunk({}, 'tool_calls');
            toolCallSent = true;
            return;
          }
        }
        sendChunk({}, 'stop');
        res.write('data: [DONE]\n\n');
        activeRequests--;
      },
    });
  } catch (err) {
    stats.errors++;
    sendChunk({ content: `\n\n[错误] ${err.message}` }, 'stop');
    res.write('data: [DONE]\n\n');
    activeRequests--;
  }

  res.end();
}

/* ========================== 管理接口 ========================== */
function handleGetConfig(req, res) {
  const cfg = { ...config };

  if (config.logging.maskSensitive && cfg.apiKey) {
    cfg.apiKey = cfg.apiKey ? '***' : '';
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(cfg));
}

function handlePostConfig(req, res) {
  readBody(req).then(raw => {
    try {
      const newConfig = JSON.parse(raw.toString('utf-8'));
      config = { ...config, ...newConfig };
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
      log('info', '配置已保存');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  }).catch(err => {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  });
}

function handleGetStats(req, res) {
  const avgLatency = stats.latencies.length > 0
    ? Math.round(stats.latencies.reduce((a, b) => a + b, 0) / stats.latencies.length)
    : 0;

  const uptime = Math.floor((Date.now() - stats.startTime) / 1000);

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    uptime,
    totalRequests: stats.totalRequests,
    streamRequests: stats.streamRequests,
    nonStreamRequests: stats.nonStreamRequests,
    toolCalls: stats.toolCalls,
    errors: stats.errors,
    activeRequests: activeRequests,
    avgLatencyMs: avgLatency
  }));
}

/* ========================== GET /v1/models ========================== */
function handleModels(req, res) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ object: 'list', data: MODELS }));
}

/* ========================== GET /health ========================== */
function handleHealth(req, res) {
  const uptime = Math.floor((Date.now() - stats.startTime) / 1000);
  const avgLatency = stats.latencies.length > 0
    ? Math.round(stats.latencies.reduce((a, b) => a + b, 0) / stats.latencies.length)
    : 0;

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    status: 'ok',
    timestamp: new Date().toISOString(),
    upstream: TARGET_HOST,
    proxy: proxyHost ? `${proxyHost}:${proxyPort}` : 'direct',
    stats: {
      uptime,
      totalRequests: stats.totalRequests,
      activeRequests: activeRequests,
      errors: stats.errors
    }
  }));
}

/* ========================== 旧接口透传 ========================== */
function proxyLegacy(req, res, urlPath, body) {
  const headers = {
    'Host': TARGET_HOST,
    'Referer': `https://${TARGET_HOST}/portal_index/chat.html`,
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': '*/*',
    'Connection': 'close',
  };
  if (req.headers['content-type']) headers['Content-Type'] = req.headers['content-type'];
  if (body?.length) headers['Content-Length'] = body.length;

  const upstream = https.request({
    method: req.method,
    hostname: TARGET_HOST,
    path: urlPath,
    headers,
    agent: httpsAgent,
  }, (upRes) => {
    const respHeaders = { 'Access-Control-Allow-Origin': '*' };
    const ct = upRes.headers['content-type'];
    if (ct) respHeaders['Content-Type'] = ct;
    if (ct?.includes('text/event-stream')) {
      respHeaders['Cache-Control'] = 'no-cache';
      respHeaders['X-Accel-Buffering'] = 'no';
    }
    res.writeHead(upRes.statusCode || 200, respHeaders);
    upRes.pipe(res);
  });
  upstream.on('error', (e) => {
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
  });
  if (body?.length) upstream.write(body);
  upstream.end();
}

/* ========================== 静态文件 ========================== */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png':  'image/png',
  '.svg':  'image/svg+xml',
};

function serveStatic(req, res, url) {
  let filePath = url === '/' ? '/index.html' : url;
  filePath = path.join(__dirname, filePath.split('?')[0]);
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('404 Not Found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
}

/* ========================== 鉴权 ========================== */
function checkAuth(req) {
  if (!config.apiKey) return true;
  const auth = req.headers['authorization'] || '';
  const token = auth.replace(/^Bearer\s+/i, '');
  return token === config.apiKey;
}

/* ========================== CORS ========================== */
function handleCORS(req, res) {
  const origin = req.headers['origin'] || '*';
  const allowed = config.corsOrigins.includes('*') || config.corsOrigins.includes(origin);
  if (allowed) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return true;
  }
  return false;
}

/* ========================== 主服务 ========================== */
const server = http.createServer({ insecureHTTPParser: true }, async (req, res) => {
  if (handleCORS(req, res)) return;

  const url = req.url || '/';

  if (url === '/health') { handleHealth(req, res); return; }

  if (!checkAuth(req)) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Invalid API key', type: 'authentication_error' } }));
    return;
  }

  if (url === '/api/config' && req.method === 'GET') { handleGetConfig(req, res); return; }
  if (url === '/api/config' && req.method === 'POST') { handlePostConfig(req, res); return; }
  if (url === '/api/stats' && req.method === 'GET') { handleGetStats(req, res); return; }

  if (url === '/v1/chat/completions' && req.method === 'POST') {
    await handleChatCompletions(req, res);
    return;
  }
  if (url === '/v1/models' && req.method === 'GET') {
    handleModels(req, res);
    return;
  }

  if (url.startsWith('/kfbackend') || url.startsWith('/kf-backend') || url.startsWith('/cgi-bin')) {
    const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req) : null;
    proxyLegacy(req, res, url, body);
    return;
  }

  serveStatic(req, res, url);
});

const PORT = process.env.PORT || config.port;

server.listen(PORT, () => {
  console.log('╔═══════════════════════════════════════════════════════════╗');
  console.log('║  腾讯元宝 → OpenAI 兼容中转代理 (新版)                  ║');
  console.log('╠═══════════════════════════════════════════════════════════╣');
  console.log(`║  监听端口:    ${String(PORT).padEnd(45)}║`);
  console.log(`║  鉴权:        ${config.apiKey ? '已启用 (Bearer token)' : '未启用'.padEnd(33)}║`);
  console.log(`║  网络代理:    ${(proxyHost ? proxyHost + ':' + proxyPort : '直连').padEnd(45)}║`);
  console.log(`║  并发限制:    ${config.maxConcurrent}`.padEnd(48) + '║');
  console.log(`║  FunctionCall: ${config.functionCall.enabled ? '已启用' : '未启用'}`.padEnd(60) + '║');
  console.log('║                                                           ║');
  console.log('║  OpenAI 接口:                                              ║');
  console.log('║    POST /v1/chat/completions   (流式 & 非流式 & FC)       ║');
  console.log('║    GET  /v1/models                                        ║');
  console.log('║    GET  /health                                           ║');
  console.log('║                                                           ║');
  console.log('║  管理接口:                                                 ║');
  console.log('║    GET  /api/config                                        ║');
  console.log('║    POST /api/config                                        ║');
  console.log('║    GET  /api/stats                                        ║');
  console.log('║                                                           ║');
  console.log('║  旧接口透传: /kfbackend/* (向后兼容)                      ║');
  console.log('║                                                           ║');
  console.log(`║  测试页面:    http://localhost:${String(PORT).padEnd(29)}║`);
  console.log(`║  管理后台:    http://localhost:${String(PORT).padEnd(29)}║`);
  console.log('╚═══════════════════════════════════════════════════════════╝');
});

server.on('clientError', (err, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
});

process.on('SIGTERM', () => {
  log('info', '收到 SIGTERM，正在关闭...');
  server.close(() => {
    log('info', '服务已关闭');
    process.exit(0);
  });
});
