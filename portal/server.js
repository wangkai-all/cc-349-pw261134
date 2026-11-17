// 业务门户服务器（虚构数据）。提供：
//   GET  /                     单页应用（虚拟滚动 + 行展开）
//   GET  /api/summary          汇总行（分页，含每行 rowVersion，无统一快照）
//   GET  /api/rows/:id/details 行明细（独立接口，返回该行当前版本）
//   POST /api/chaos            演示控制：注入变更 / 明细超时 / 后台变更开关
//   GET  /api/state            调试：当前 seq、各请求计数
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDataStore } from './data.js';

const PORT = Number(process.env.PORTAL_PORT || 4100);
const PUBLIC = join(fileURLToPath(new URL('.', import.meta.url)), 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

const store = createDataStore(60);

// ---- 演示控制（chaos）状态 ----
const chaos = {
  timeouts: new Map(),        // rowId -> 剩余超时次数（明细接口挂起 20s 后返回 504）
  afterSummary: new Map(),    // rowId -> true：下次 summary 包含该行后立刻变更该行（一次性）
  hot: new Map(),             // rowId -> interval handle：高频变更某行
  mutator: null,              // 后台随机变更 interval handle
  log: [],                    // 最近变更记录（门户侧栏展示）
};

function logChange(entry) {
  chaos.log.unshift({ ...entry, at: new Date().toISOString() });
  if (chaos.log.length > 30) chaos.log.pop();
}

function startMutator(intervalMs) {
  stopMutator();
  chaos.mutator = setInterval(() => logChange(store.randomMutate('background-mutator')), intervalMs);
}
function stopMutator() {
  if (chaos.mutator) clearInterval(chaos.mutator);
  chaos.mutator = null;
}

function send(res, status, obj, extraHeaders = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...extraHeaders });
  res.end(body);
}

async function serveStatic(req, res, path) {
  const file = normalize(join(PUBLIC, path === '/' ? 'index.html' : path));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); res.end(); return; }
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404); res.end('not found');
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const path = url.pathname;
  if (process.env.PORTAL_ACCESS_LOG && path.startsWith('/api/')) {
    console.log(`[access] ${new Date().toISOString().slice(11, 23)} ${req.method} ${path}${url.search}`);
  }

  if (path === '/api/summary') {
    const result = store.summary({
      region: url.searchParams.get('region') || '',
      status: url.searchParams.get('status') || '',
      offset: Number(url.searchParams.get('offset') || 0),
      limit: Number(url.searchParams.get('limit') || 12),
    });
    // 回显采集器注入的关联头（如有），证明本响应对应哪次采集动作
    result.collectAction = req.headers['x-collect-action'] ?? null;
    // chaos：summary 刚把某行发出去，该行立刻变化（演示"查看期间源数据变化"）
    // afterSummary 值为 'always' 时每次都触发（热点行），否则一次性
    for (const row of result.rows) {
      const flag = chaos.afterSummary.get(row.rowId);
      if (flag) {
        if (flag !== 'always') chaos.afterSummary.delete(row.rowId);
        const rowId = row.rowId;
        setTimeout(() => logChange(store.mutateRow(rowId, 'chaos:mutate-after-summary')), 30);
      }
    }
    send(res, 200, result, { 'x-request-id': result.requestId });
    return;
  }

  const detailMatch = path.match(/^\/api\/rows\/([^/]+)\/details$/);
  if (detailMatch) {
    const rowId = decodeURIComponent(detailMatch[1]);
    // chaos：明细请求超时——挂起 20 秒后返回 504（采集器 6s 即判定超时）
    const remaining = chaos.timeouts.get(rowId) || 0;
    if (remaining > 0) {
      chaos.timeouts.set(rowId, remaining - 1);
      setTimeout(() => {
        if (!res.destroyed) send(res, 504, { error: 'upstream timeout', rowId, requestId: store.nextRequestId() });
      }, 20000);
      return;
    }
    const d = store.details(rowId);
    if (!d) { send(res, 404, { error: 'row not found', rowId }); return; }
    d.collectAction = req.headers['x-collect-action'] ?? null;
    send(res, 200, d, { 'x-request-id': d.requestId });
    return;
  }

  if (path === '/api/chaos' && req.method === 'POST') {
    let body = '';
    for await (const chunk of req) body += chunk;
    const msg = JSON.parse(body || '{}');
    const reply = { ok: true, action: msg.action };
    switch (msg.action) {
      case 'mutate': // 立刻变更指定行
        reply.change = logChange(store.mutateRow(msg.rowId, 'chaos:mutate'));
        break;
      case 'mutate_after_summary': // 下次 summary 出现该行后变更（一次性）
        chaos.afterSummary.set(msg.rowId, true);
        break;
      case 'timeout': // 指定行接下来 times 次明细请求超时
        chaos.timeouts.set(msg.rowId, msg.times ?? 1);
        break;
      case 'hot_row': // 高频变更指定行 + 每次汇总出现该行后立即变更（制造持续不一致）
        if (chaos.hot.has(msg.rowId)) clearInterval(chaos.hot.get(msg.rowId));
        chaos.hot.set(msg.rowId, setInterval(() => logChange(store.mutateRow(msg.rowId, 'chaos:hot-row')), msg.intervalMs ?? 200));
        chaos.afterSummary.set(msg.rowId, 'always');
        break;
      case 'hot_row_off':
        if (chaos.hot.has(msg.rowId)) { clearInterval(chaos.hot.get(msg.rowId)); chaos.hot.delete(msg.rowId); }
        if (chaos.afterSummary.get(msg.rowId) === 'always') chaos.afterSummary.delete(msg.rowId);
        break;
      case 'mutator': // 后台随机变更开关
        msg.on ? startMutator(msg.intervalMs ?? 2500) : stopMutator();
        break;
      case 'reset': // 关闭所有 chaos
        stopMutator();
        for (const h of chaos.hot.values()) clearInterval(h);
        chaos.hot.clear(); chaos.timeouts.clear(); chaos.afterSummary.clear();
        break;
      default:
        send(res, 400, { ok: false, error: `unknown action ${msg.action}` });
        return;
    }
    send(res, 200, reply);
    return;
  }

  if (path === '/api/state') {
    send(res, 200, {
      seq: store.seq,
      mutatorOn: Boolean(chaos.mutator),
      hotRows: [...chaos.hot.keys()],
      pendingTimeouts: Object.fromEntries(chaos.timeouts),
      recentChanges: chaos.log.slice(0, 12),
    });
    return;
  }

  if (req.method === 'GET') return serveStatic(req, res, path);
  res.writeHead(404); res.end('not found');
});

server.listen(PORT, () => {
  console.log(`[portal] 业务门户（虚构数据）: http://localhost:${PORT}`);
});
