// 核对服务：接收采集器提交的证据包，检查"筛选条件 / 展开请求 / 实际返回"是否
// 属于同一批数据，判定行状态并入库；同时提供追溯页（viewer）。
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from './store.js';
import { assessRow, bindingErrors, batchLimitation, isTerminal } from './verify.js';

const PORT = Number(process.env.VERIFIER_PORT || 4200);
const DB_PATH = process.env.VERIFIER_DB || 'verifier.db';
const PUBLIC = join(fileURLToPath(new URL('.', import.meta.url)), 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

const store = createStore(DB_PATH);

function send(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

async function serveStatic(res, path) {
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

// 从 artifacts 重建行的观测序列并重新判定（单一事实来源 = artifacts 表）
function reassessRow(runId, rowId) {
  const summary = [];
  const details = [];
  // 汇总证据是页级的（row_id 为 NULL），需从页内行列表中找本行
  for (const a of store.summaryArtifacts(runId)) {
    const p = a.payload;
    if (p.bindingErrors?.length) continue; // 绑定失败的汇总不作为行证据
    const row = p.response?.body?.rows?.find((r) => r.rowId === rowId);
    if (row) {
      summary.push({
        rowVersion: row.rowVersion, amountCents: row.amountCents,
        requestId: p.response.body.requestId, bindingErrors: [],
      });
    }
  }
  for (const a of store.artifactsForRow(runId, rowId)) {
    const p = a.payload;
    if (a.kind !== 'detail') continue;
    details.push({
      outcome: a.outcome,
      rowVersion: p.response?.body?.rowVersion ?? null,
      amountCents: p.response?.body?.amountCents ?? null,
      requestId: p.response?.body?.requestId ?? null,
      bindingErrors: p.bindingErrors ?? [],
    });
  }
  const prev = store.getRow(runId, rowId);
  // 终态粘性：行已闭环（已核对/不确定/明细缺失）后，新观测留作证据但不重开；
  // 若源数据在终态后继续变化，记一条提示事件（追溯可见），批次状态保持稳定。
  if (prev && isTerminal(prev.status)) {
    const latestSummary = summary[summary.length - 1];
    if (latestSummary && prev.summary_version != null && latestSummary.rowVersion > prev.summary_version) {
      const alreadyNoted = store.eventsForRow(runId, rowId)
        .some((e) => e.type === 'post_terminal_change');
      if (!alreadyNoted) {
        store.addEvent(runId, rowId, 'post_terminal_change',
          `终态（${prev.status}）后源数据继续变化（汇总已至 v${latestSummary.rowVersion}）；本批次不重开`,
          { observedVersion: latestSummary.rowVersion });
      }
    }
    return {
      status: prev.status, reason: prev.reason, rounds: prev.rounds,
      summaryVersion: prev.summary_version, detailVersion: prev.detail_version,
      reconciles: prev.reconciles === null ? null : Boolean(prev.reconciles),
      limitation: prev.limitation, action: 'none',
    };
  }
  const assessed = assessRow({ summary, details });
  store.saveRowState(runId, rowId, assessed);
  if (!prev || prev.status !== assessed.status) {
    store.addEvent(runId, rowId, 'row_status',
      `状态：${prev?.status ?? '∅'} → ${assessed.status}（${assessed.reason}）`, assessed);
  }
  return assessed;
}

function batchView(runId) {
  const batch = store.getBatch(runId);
  if (!batch) return null;
  const rows = store.rowsForBatch(runId);
  const counts = {};
  for (const r of rows) counts[r.status] = (counts[r.status] || 0) + 1;
  return { ...batch, counts, rowCount: rows.length, limitation: batchLimitation(rows) };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const path = url.pathname;
  const readBody = async () => {
    let b = '';
    for await (const c of req) b += c;
    return b ? JSON.parse(b) : {};
  };

  // ---- 采集器接口 ----
  if (path === '/api/runs' && req.method === 'POST') {
    const { runId, filter, collector } = await readBody();
    if (!runId) return send(res, 400, { error: 'runId required' });
    store.ensureBatch({ runId, filter, collector });
    store.addEvent(runId, null, 'batch_opened', `批次创建/继续：${runId}`, { filter, collector });
    return send(res, 200, { ok: true, batch: batchView(runId) });
  }

  const artMatch = path.match(/^\/api\/runs\/([^/]+)\/artifacts$/);
  if (artMatch && req.method === 'POST') {
    const runId = decodeURIComponent(artMatch[1]);
    const batch = store.getBatch(runId);
    if (!batch) return send(res, 404, { error: `unknown run ${runId}` });
    const artifact = await readBody();
    artifact.runId = runId;
    // 绑定检查：筛选条件回显、请求↔响应行一致性
    artifact.bindingErrors = bindingErrors(artifact, batch);
    const { duplicate } = store.insertArtifact(artifact);
    if (duplicate) {
      return send(res, 200, { ok: true, duplicate: true, artifactId: artifact.artifactId });
    }
    let assessment = null;
    if (artifact.kind === 'summary') {
      if (artifact.bindingErrors.length) {
        // 筛选条件对不上的汇总响应：记录并拒收，不进入任何行的证据链
        store.addEvent(runId, null, 'binding_rejected',
          `汇总证据绑定失败（${artifact.bindingErrors.join(',')}），已拒收`, { artifactId: artifact.artifactId });
      } else {
        for (const row of artifact.response?.body?.rows ?? []) reassessRow(runId, row.rowId);
      }
    } else if (artifact.kind === 'detail' && artifact.rowId) {
      assessment = reassessRow(runId, artifact.rowId);
    }
    return send(res, 200, {
      ok: true, duplicate: false, artifactId: artifact.artifactId,
      bindingErrors: artifact.bindingErrors,
      assessment, // collector 依据 assessment.action 决定是否反复核对
    });
  }

  const evMatch = path.match(/^\/api\/runs\/([^/]+)\/events$/);
  if (evMatch && req.method === 'POST') {
    const runId = decodeURIComponent(evMatch[1]);
    if (!store.getBatch(runId)) return send(res, 404, { error: `unknown run ${runId}` });
    const { rowId, type, message, data } = await readBody();
    store.addEvent(runId, rowId ?? null, type, message, data);
    if (type === 'collector_finished') store.setBatchStatus(runId, 'done');
    return send(res, 200, { ok: true });
  }

  // ---- 追溯页接口 ----
  if (path === '/api/batches') return send(res, 200, { batches: store.listBatches().map((b) => batchView(b.run_id)) });

  const batchMatch = path.match(/^\/api\/batches\/([^/]+)$/);
  if (batchMatch) {
    const view = batchView(decodeURIComponent(batchMatch[1]));
    return view ? send(res, 200, view) : send(res, 404, { error: 'not found' });
  }

  const rowsMatch = path.match(/^\/api\/batches\/([^/]+)\/rows$/);
  if (rowsMatch) {
    const runId = decodeURIComponent(rowsMatch[1]);
    return send(res, 200, { rows: store.rowsForBatch(runId), limitation: batchLimitation(store.rowsForBatch(runId)) });
  }

  const lineageMatch = path.match(/^\/api\/batches\/([^/]+)\/rows\/([^/]+)\/lineage$/);
  if (lineageMatch) {
    const runId = decodeURIComponent(lineageMatch[1]);
    const rowId = decodeURIComponent(lineageMatch[2]);
    const row = store.getRow(runId, rowId);
    if (!row) return send(res, 404, { error: 'not found' });
    return send(res, 200, {
      row,
      artifacts: [...store.artifactsForRow(runId, rowId), ...store.summaryMentions(runId, rowId)],
      domMentions: store.domMentions(runId, rowId),
      events: store.eventsForRow(runId, rowId),
      terminal: isTerminal(row.status),
    });
  }

  if (req.method === 'GET') return serveStatic(res, path);
  res.writeHead(404); res.end('not found');
});

server.listen(PORT, () => {
  console.log(`[verifier] 核对服务 + 追溯页: http://localhost:${PORT} (db: ${DB_PATH})`);
});
