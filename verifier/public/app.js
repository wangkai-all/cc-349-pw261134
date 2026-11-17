// 追溯页：批次列表 → 行状态表 → 单行证据链时间线。每 2.5s 自动刷新。
const STATUS_LABEL = {
  pending: '待核对', rechecking: '复核中', verified: '已核对',
  uncertain: '不确定', incomplete: '明细缺失',
};

let currentBatch = null;
let currentRow = null;

const $ = (sel) => document.querySelector(sel);

async function j(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`${r.status} ${path}`);
  return r.json();
}

function statusBadge(s) {
  return `<em class="badge st-${s}">${STATUS_LABEL[s] ?? s}</em>`;
}

async function refreshBatches() {
  const { batches } = await j('/api/batches');
  $('#batch-list').innerHTML = batches.map((b) => {
    const c = b.counts || {};
    const bits = Object.entries(c).map(([k, v]) => `${STATUS_LABEL[k] ?? k} ${v}`).join(' · ');
    return `<li class="${b.run_id === currentBatch ? 'sel' : ''}" data-run="${b.run_id}">
      <div class="mono">${b.run_id}</div>
      <div class="filter">筛选：区域=${b.filter.region || '全部'} 状态=${b.filter.status || '全部'}</div>
      <div class="counts">${b.rowCount} 行 · ${bits || '无数据'}</div>
    </li>`;
  }).join('');
  document.querySelectorAll('#batch-list li').forEach((li) => {
    li.onclick = () => { currentBatch = li.dataset.run; currentRow = null; closeDrawer(); refresh(); };
  });
  if (!currentBatch && batches.length) { currentBatch = batches[0].run_id; }
}

async function refreshRows() {
  if (!currentBatch) return;
  const { rows, limitation } = await j(`/api/batches/${encodeURIComponent(currentBatch)}/rows`);
  const banner = $('#limitation-banner');
  if (limitation) {
    banner.textContent = '⚠ ' + limitation;
    banner.classList.remove('hidden');
  } else {
    banner.classList.add('hidden');
  }
  $('#rows-table tbody').innerHTML = rows.map((r) => `
    <tr data-row="${r.row_id}" class="${r.row_id === currentRow ? 'sel' : ''}">
      <td class="mono">${r.row_id}</td>
      <td>${statusBadge(r.status)}</td>
      <td>${r.summary_version != null ? 'v' + r.summary_version : '—'}</td>
      <td>${r.detail_version != null ? 'v' + r.detail_version : '—'}</td>
      <td>${r.reconciles === null || r.reconciles === undefined ? '—' : r.reconciles ? '✓' : '✗'}</td>
      <td>${r.rounds}</td>
      <td class="lim">${r.limitation ?? ''}</td>
    </tr>`).join('');
  document.querySelectorAll('#rows-table tbody tr').forEach((tr) => {
    tr.onclick = () => { currentRow = tr.dataset.row; openLineage(); };
  });
}

function fmtArtifact(a, rowId) {
  const p = a.payload;
  const t = p.capturedAt || a.submitted_at || '';
  if (a.kind === 'summary') {
    const body = p.response?.body ?? {};
    const me = body.rows?.find((r) => r.rowId === rowId);
    if (!me) return null;
    return {
      t, cls: 'art',
      html: `<b>汇总捕获</b> · offset=${body.offset} · 本行版本 v${me.rowVersion} · <code>${body.requestId}</code>
        ${p.bindingErrors?.length ? `<span class="err">绑定异常: ${p.bindingErrors.join(',')}</span>` : ''}`,
    };
  }
  if (a.kind === 'detail') {
    if (a.outcome === 'timeout') {
      return { t, cls: 'art warn', html: `<b>明细请求超时</b>（${p.timeoutMs}ms 未响应）—— 不作为"无明细"处理` };
    }
    if (a.outcome === 'http_error') {
      return { t, cls: 'art warn', html: `<b>明细请求失败</b> HTTP ${p.response?.status} —— 不作为"无明细"处理` };
    }
    const body = p.response?.body ?? {};
    return {
      t, cls: 'art ok',
      html: `<b>明细捕获</b> · 版本 v${body.rowVersion} · ${body.lines?.length ?? '?'} 行明细 · <code>${body.requestId}</code>
        ${p.bindingErrors?.length ? `<span class="err">绑定异常: ${p.bindingErrors.join(',')}</span>` : ''}`,
    };
  }
  return null;
}

async function openLineage() {
  const data = await j(`/api/batches/${encodeURIComponent(currentBatch)}/rows/${encodeURIComponent(currentRow)}/lineage`);
  $('#drawer-title').innerHTML = `${currentRow} 证据链 ${statusBadge(data.row.status)}`;
  const items = [];
  for (const ev of data.events) {
    items.push({ t: ev.ts, cls: 'ev', html: `<b>${ev.type}</b> · ${ev.message ?? ''}` });
  }
  for (const a of data.artifacts) {
    const it = fmtArtifact(a, currentRow);
    if (it) items.push(it);
  }
  for (const m of data.domMentions) {
    for (const mm of m.payload.mappings?.filter((x) => x.rowId === currentRow) ?? []) {
      items.push({
        t: m.payload.capturedAt || '', cls: 'dom',
        html: `<b>DOM 复用</b> · 槽位 #${mm.slot} 渲染本行（逻辑行 #${mm.index}，v${mm.rowVersion}）`,
      });
    }
  }
  items.sort((x, y) => (x.t < y.t ? -1 : x.t > y.t ? 1 : 0));
  $('#drawer-body').innerHTML = `
    <div class="row-summary">
      汇总版本 v${data.row.summary_version ?? '—'} · 明细版本 v${data.row.detail_version ?? '—'} ·
      核对 ${data.row.rounds} 轮 · 金额勾稽（参考）${data.row.reconciles == null ? '—' : data.row.reconciles ? '✓' : '✗'}
      ${data.row.limitation ? `<div class="lim">⚠ ${data.row.limitation}</div>` : ''}
    </div>
    <ul class="timeline">${items.map((i) => `<li class="${i.cls}"><time>${(i.t || '').slice(11, 19)}</time> ${i.html}</li>`).join('')}</ul>`;
  $('#drawer').classList.remove('hidden');
}

function closeDrawer() { $('#drawer').classList.add('hidden'); currentRow = null; }
$('#drawer-close').onclick = closeDrawer;

async function refresh() {
  try {
    await refreshBatches();
    await refreshRows();
    if (currentRow) await openLineage();
  } catch (e) { console.error(e); }
}

refresh();
setInterval(refresh, 2500);
