/**
 * ============================================================================
 *  腾讯元宝 (Hunyuan) → OpenAI 兼容中转代理
 * ============================================================================
 *
 *  对外暴露标准 OpenAI API：
 *    POST /v1/chat/completions   ← 流式 & 非流式均支持
 *    GET  /v1/models             ← 模型列表
 *    GET  /health                ← 健康检查
 *
 *  对内调用元宝 SSE 接口，自动转换格式。
 *  旧接口（/kfbackend/*）原样透传，老网页零影响。
 *
 *  零依赖，仅需 Node.js ≥ 16。
 *
 *  用法：
 *    node proxy.js
 *    PORT=8080 API_KEY=sk-your-key node proxy.js
 *
 *  环境变量：
 *    PORT          监听端口（默认 8080）
 *    API_KEY       可选，设后需在 Authorization: Bearer 中传入才能调用
 *    DEFAULT_USERID  默认 userid（默认使用内置测试 ID）
 * ============================================================================
 */

const http  = require('http');
const tls   = require('tls');
const fs    = require('fs');
const path  = require('path');
const crypto = require('crypto');

/* ========================== 配置 ========================== */
const PORT          = process.env.PORT || 8080;
const API_KEY       = process.env.API_KEY || '';           // 留空 = 不鉴权
const DEFAULT_USERID = process.env.DEFAULT_USERID || 'oIJ9428d51b28d039a107af55343e3f969f';
const TARGET_HOST   = 'kf.qq.com';

const MODELS = [
  { id: 'yuanbao',     object: 'model', created: 1700000000, owned_by: 'tencent' },
  { id: 'hunyuan',     object: 'model', created: 1700000000, owned_by: 'tencent' },
  { id: 'tencent-yuanbao', object: 'model', created: 1700000000, owned_by: 'tencent' },
];

/* ========================== 环境代理检测 ========================== */
const PROXY_URL = process.env.HTTPS_PROXY || process.env.https_proxy ||
                  process.env.HTTP_PROXY  || process.env.http_proxy || '';
let proxyHost = null, proxyPort = null;
if (PROXY_URL) {
  const m = PROXY_URL.match(/^https?:\/\/([^:]+):(\d+)/);
  if (m) { proxyHost = m[1]; proxyPort = parseInt(m[2]); }
}

/* ========================== TLS 连接 ========================== */
function connectTLS(callback) {
  if (proxyHost) {
    const connectReq = http.request({
      host: proxyHost, port: proxyPort, method: 'CONNECT',
      path: `${TARGET_HOST}:443`,
    });
    connectReq.on('connect', (resp, socket) => {
      if (resp.statusCode !== 200) { callback(new Error(`CONNECT 失败: ${resp.statusCode}`)); return; }
      const tlsSocket = tls.connect({ socket, servername: TARGET_HOST }, () => callback(null, tlsSocket));
      tlsSocket.on('error', (e) => callback(e));
    });
    connectReq.on('error', (e) => callback(e));
    connectReq.end();
  } else {
    const tlsSocket = tls.connect({ host: TARGET_HOST, port: 443, servername: TARGET_HOST }, () => callback(null, tlsSocket));
    tlsSocket.on('error', (e) => callback(e));
  }
}

/* ========================== 工具函数 ========================== */
function genId(prefix) {
  return prefix + '-' + crypto.randomBytes(12).toString('hex');
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

/* ---- 从 OpenAI messages 中提取 query ---- */
function extractQuery(messages) {
  if (!Array.isArray(messages) || !messages.length) return '';
  // 取最后一条 user 消息作为 query
  // 如果有 system 消息，拼到前面作为上下文
  let systemParts = [];
  let userQuery = '';
  let lastUser = '';

  for (const msg of messages) {
    if (msg.role === 'system') systemParts.push(msg.content);
    if (msg.role === 'user') lastUser = msg.content;
  }

  userQuery = lastUser || messages[messages.length - 1].content || '';
  if (systemParts.length) {
    return systemParts.join('\n') + '\n\n' + userQuery;
  }
  return userQuery;
}

/* ========================== 核心：调用元宝 SSE ========================== */
/**
 * 调用元宝 getYuanBaoAnswer，通过回调返回解析后的数据
 * @param {string} query    用户问题
 * @param {string} userid   用户 ID
 * @param {string} senceName 场景名（可空）
 * @param {object} callbacks { onCitations, onContent, onFinish, onError }
 * @returns {Promise<void>}
 */
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

    connectTLS((err, tlsSocket) => {
      if (err) { reject(err); return; }

      const upstream = http.request({
        method: 'GET', path: urlPath, headers,
        createConnection: () => tlsSocket,
      }, (upRes) => {
        if (upRes.statusCode !== 200) {
          reject(new Error(`元宝接口返回 HTTP ${upRes.statusCode}`));
          return;
        }

        let buffer = '';
        let citationsSent = false;

        upRes.on('data', (chunk) => {
          buffer += chunk.toString('utf-8');
          const lines = buffer.split('\n');
          buffer = lines.pop(); // 保留最后不完整的行

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data:')) continue;

            const jsonStr = trimmed.slice(5).trim();
            if (!jsonStr || jsonStr === '[DONE]') continue;

            let data;
            try { data = JSON.parse(jsonStr); } catch { continue; }

            const delta = data.choices?.[0]?.delta || {};
            const finishReason = data.choices?.[0]?.finish_reason;

            // reasoning_content → 引用文档
            if (delta.reasoning_content && !citationsSent) {
              try {
                const refData = JSON.parse(delta.reasoning_content);
                if (refData.docs && refData.docs.length) {
                  callbacks.onCitations?.(refData);
                  citationsSent = true;
                }
              } catch { /* 分片，忽略 */ }
            }

            // content → 正文
            if (delta.content) {
              callbacks.onContent?.(delta.content);
            }

            // 结束
            if (finishReason === 'stop') {
              callbacks.onFinish?.();
            }
          }
        });

        upRes.on('end', () => {
          // 处理 buffer 中剩余数据
          if (buffer.trim().startsWith('data:')) {
            const jsonStr = buffer.trim().slice(5).trim();
            if (jsonStr && jsonStr !== '[DONE]') {
              try {
                const data = JSON.parse(jsonStr);
                const delta = data.choices?.[0]?.delta || {};
                if (delta.content) callbacks.onContent?.(delta.content);
                if (data.choices?.[0]?.finish_reason === 'stop') callbacks.onFinish?.();
              } catch {}
            }
          }
          callbacks.onFinish?.();
          resolve();
        });

        upRes.on('error', (e) => reject(e));
      });

      upstream.on('error', (e) => reject(e));
      upstream.end();
    });
  });
}

/* ========================== OpenAI 接口处理 ========================== */

/* ---- POST /v1/chat/completions ---- */
async function handleChatCompletions(req, res) {
  let body;
  try {
    const raw = await readBody(req);
    body = JSON.parse(raw.toString('utf-8'));
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Invalid JSON body', type: 'invalid_request_error' } }));
    return;
  }

  const query = extractQuery(body.messages);
  if (!query) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'No user message found', type: 'invalid_request_error' } }));
    return;
  }

  // userid 来源优先级: body.user > header > 环境变量
  const userid = body.user ||
                 req.headers['x-yuanbao-userid'] ||
                 DEFAULT_USERID;
  const senceName = body.sence_name || req.headers['x-yuanbao-sence'] || '';
  const model = body.model || 'yuanbao';
  const stream = body.stream !== false; // 默认流式

  const completionId = genId('chatcmpl');
  const created = Math.floor(Date.now() / 1000);

  // ---- 非流式：收集全部后返回 ----
  if (!stream) {
    let fullContent = '';
    let citations = null;

    try {
      await callYuanbao(query, userid, senceName, {
        onCitations: (refData) => { citations = refData; },
        onContent: (text) => { fullContent += text; },
      });
    } catch (err) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: '上游调用失败: ' + err.message, type: 'api_error' } }));
      return;
    }

    // 如果有引用，在正文前添加引用列表（Markdown 格式）
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
        message: { role: 'assistant', content: fullContent },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    };

    // 附加引用信息（自定义字段，不影响 OpenAI 兼容性）
    if (citations) response.citations = citations;

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(response));
    return;
  }

  // ---- 流式：实时转发 SSE ----
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  // 发送角色 chunk
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
  try {
    await callYuanbao(query, userid, senceName, {
      onCitations: (refData) => {
        citations = refData;
        // 引用文档作为首个 content 块发送（Markdown 格式）
        if (refData.docs?.length) {
          let refs = `> **${refData.title || '引用资料'}**\n\n`;
          refData.docs.forEach(d => {
            refs += `${d.index}. [${d.title}](${d.url}) - ${d.author || ''}\n`;
          });
          refs += '\n---\n\n';
          sendChunk({ content: refs }, null);
        }
      },
      onContent: (text) => {
        sendChunk({ content: text }, null);
      },
      onFinish: () => {
        sendChunk({}, 'stop');
        res.write('data: [DONE]\n\n');
      },
    });
  } catch (err) {
    // 发送错误信息作为 content
    sendChunk({ content: `\n\n[错误] ${err.message}` }, 'stop');
    res.write('data: [DONE]\n\n');
  }

  res.end();
}

/* ---- GET /v1/models ---- */
function handleModels(req, res) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ object: 'list', data: MODELS }));
}

/* ---- GET /health ---- */
function handleHealth(req, res) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    status: 'ok',
    timestamp: new Date().toISOString(),
    upstream: TARGET_HOST,
    proxy: proxyHost ? `${proxyHost}:${proxyPort}` : 'direct',
  }));
}

/* ========================== 旧接口透传（向后兼容）========================== */
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

  connectTLS((err, tlsSocket) => {
    if (err) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
      return;
    }
    const upstream = http.request({
      method: req.method, path: urlPath, headers,
      createConnection: () => tlsSocket,
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
  });
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
  if (!API_KEY) return true; // 未设 API_KEY = 不鉴权
  const auth = req.headers['authorization'] || '';
  const token = auth.replace(/^Bearer\s+/i, '');
  return token === API_KEY;
}

/* ========================== 主服务 ========================== */
const server = http.createServer({ insecureHTTPParser: true }, async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = req.url || '/';

  // ---- 健康检查（不需鉴权）----
  if (url === '/health') { handleHealth(req, res); return; }

  // ---- 鉴权 ----
  if (!checkAuth(req)) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Invalid API key', type: 'authentication_error' } }));
    return;
  }

  // ---- OpenAI 兼容路由 ----
  if (url === '/v1/chat/completions' && req.method === 'POST') {
    await handleChatCompletions(req, res);
    return;
  }
  if (url === '/v1/models' && req.method === 'GET') {
    handleModels(req, res);
    return;
  }

  // ---- 旧接口透传（向后兼容）----
  if (url.startsWith('/kfbackend') || url.startsWith('/kf-backend') || url.startsWith('/cgi-bin')) {
    const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req) : null;
    proxyLegacy(req, res, url, body);
    return;
  }

  // ---- 静态文件（测试页面）----
  serveStatic(req, res, url);
});

server.listen(PORT, () => {
  console.log('╔═══════════════════════════════════════════════════════════╗');
  console.log('║  腾讯元宝 → OpenAI 兼容中转代理                            ║');
  console.log('╠═══════════════════════════════════════════════════════════╣');
  console.log(`║  监听端口:    ${String(PORT).padEnd(45)}║`);
  console.log(`║  鉴权:        ${API_KEY ? '已启用 (Bearer token)' : '未启用'.padEnd(33)}║`);
  console.log(`║  网络代理:    ${(proxyHost ? proxyHost + ':' + proxyPort : '直连').padEnd(45)}║`);
  console.log('║                                                           ║');
  console.log('║  OpenAI 接口:                                              ║');
  console.log('║    POST /v1/chat/completions   (流式 & 非流式)             ║');
  console.log('║    GET  /v1/models                                        ║');
  console.log('║    GET  /health                                           ║');
  console.log('║                                                           ║');
  console.log('║  旧接口透传: /kfbackend/* /kf-backend/* (向后兼容)         ║');
  console.log('║                                                           ║');
  console.log(`║  测试页面:    http://localhost:${String(PORT).padEnd(29)}║`);
  console.log('╚═══════════════════════════════════════════════════════════╝');
});

server.on('clientError', (err, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
});
