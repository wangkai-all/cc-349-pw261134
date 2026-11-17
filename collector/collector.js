// 浏览器采集器：驱动真实 Chromium 打开门户，把"筛选条件 / 展开请求 / 实际返回"
// 绑定成证据包提交给核对服务。
// 要点：
//  - 行身份只认 data-row-id，不认 DOM 节点（门户虚拟滚动会复用槽位）
//  - 展开超时/失败记录为"获取失败"，绝不记为"无明细"
//  - 每次捕获即写断点；进程被杀后用同一 run-id 重启可续采，提交幂等
import { createHash } from 'node:crypto';
import { ensureBrowserEnv } from '../scripts/browser-env.mjs';
import { createCheckpoint } from './checkpoint.js';

ensureBrowserEnv();
const { chromium } = await import('playwright-core');

const sha = (s) => createHash('sha256').update(s).digest('hex').slice(0, 32);
const TERMINAL = new Set(['verified', 'uncertain', 'incomplete']);

export class Collector {
  constructor({
    portalUrl = 'http://localhost:4100',
    verifierUrl = 'http://localhost:4200',
    runId, filter = { region: '', status: '' },
    checkpointDir = 'checkpoints',
    detailTimeoutMs = 6000,
    maxSweeps = 6,
    log = console.log,
  }) {
    Object.assign(this, { portalUrl, verifierUrl, runId, filter, checkpointDir, detailTimeoutMs, maxSweeps, log });
    this.discovered = new Map();   // rowId -> 最近见到的 rowVersion
    this.terminal = new Set();     // 核对服务判定为终态的行
    this.inflight = new Map();     // rowId -> {actionId, timer, resolve}
    this.submitQueue = [];
    this.draining = false;
    this.submitted = new Set();
    this.actionSeq = 0;
    this.currentAction = 0;
    this.domSeq = 0;
    this.lastDomHash = '';
    this.attempt = 1;
  }

  beginAction() {
    this.actionSeq++;
    this.currentAction = this.actionSeq;
    return this.actionSeq;
  }

  // ---------- 基础 ----------
  async j(path, opts) {
    const r = await fetch(this.verifierUrl + path, opts);
    if (!r.ok) throw new Error(`${r.status} ${path}`);
    return r.json();
  }

  async postEvent(type, message, { rowId = null, data = null } = {}) {
    try {
      await this.j(`/api/runs/${encodeURIComponent(this.runId)}/events`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ rowId, type, message, data }),
      });
    } catch (e) { this.log(`事件上报失败（忽略）: ${e.message}`); }
  }

  async init() {
    this.checkpoint = createCheckpoint(this.checkpointDir, this.runId);
    this.attempt = this.checkpoint.count('collector_started') + 1;
    this.submitted = this.checkpoint.values('submitted', 'artifactId');

    await this.j('/api/runs', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runId: this.runId, filter: this.filter, collector: 'playwright-chromium' }),
    });

    // 重启恢复：以核对服务中的行状态为准
    await this.refreshTerminal();

    this.checkpoint.record({ type: 'collector_started', attempt: this.attempt });
    await this.postEvent('collector_started',
      `采集器启动（第 ${this.attempt} 次）filter=${JSON.stringify(this.filter)}`,
      { data: { attempt: this.attempt } });
    this.log(`启动（第 ${this.attempt} 次），已恢复：发现 ${this.discovered.size} 行，终态 ${this.terminal.size} 行`);
  }

  // 终态以核对服务为准（服务端可能因新汇总证据单独改变行状态）
  async refreshTerminal() {
    const { rows } = await this.j(`/api/batches/${encodeURIComponent(this.runId)}/rows`);
    for (const r of rows ?? []) {
      this.discovered.set(r.row_id, r.summary_version);
      if (TERMINAL.has(r.status)) this.terminal.add(r.row_id);
    }
  }

  // ---------- 证据构造与提交 ----------
  makeArtifact(fields) {
    const a = {
      runId: this.runId,
      capturedAt: new Date().toISOString(),
      ...fields,
    };
    let key;
    if (a.kind === 'summary') key = `summary|${a.request.url}|${a.response?.body?.requestId}`;
    else if (a.kind === 'detail') key = `detail|${a.request.url}|${a.response?.body?.requestId ?? a.actionId}`;
    else if (a.kind === 'dom_snapshot') key = `dom|${this.runId}|${this.domSeq++}`;
    else key = JSON.stringify(a);
    a.artifactId = sha(key);
    return a;
  }

  enqueueArtifact(a) {
    this.submitQueue.push(a);
    void this.drain();
  }

  async drain() {
    if (this.draining) return;
    this.draining = true;
    while (this.submitQueue.length) {
      const a = this.submitQueue[0];
      if (this.submitted.has(a.artifactId)) { this.submitQueue.shift(); continue; }
      try {
        const resp = await this.j(`/api/runs/${encodeURIComponent(this.runId)}/artifacts`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(a),
        });
        this.submitted.add(a.artifactId);
        this.checkpoint.record({ type: 'submitted', artifactId: a.artifactId, kind: a.kind, rowId: a.rowId ?? null });
        this.submitQueue.shift();
        if (a.kind === 'summary') this.noteSummary(a, resp);
        if (a.kind === 'detail' && resp.assessment) this.noteAssessment(a.rowId, resp.assessment);
      } catch (e) {
        this.log(`提交失败，3s 后重试: ${e.message}`);
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
    this.draining = false;
  }

  async flush() {
    while (this.submitQueue.length || this.draining) {
      await this.drain();
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  noteSummary(a, resp) {
    const echo = a.response?.body?.filterEcho ?? {};
    if ((echo.region || '') !== (this.filter.region || '') || (echo.status || '') !== (this.filter.status || '')) {
      this.log(`汇总响应筛选条件不符（${JSON.stringify(echo)}），核对服务将拒收为证据`);
      return; // 不纳入本批发现集
    }
    if (resp?.bindingErrors?.length) return;
    for (const row of a.response.body.rows) this.discovered.set(row.rowId, row.rowVersion);
  }

  noteAssessment(rowId, a) {
    this.checkpoint.record({ type: 'row_status', rowId, status: a.status, rounds: a.rounds });
    if (TERMINAL.has(a.status)) {
      this.terminal.add(rowId);
      this.log(`行 ${rowId} → ${a.status}（${a.reason}，第 ${a.rounds} 轮）`);
    } else {
      this.log(`行 ${rowId} → ${a.status}（${a.reason}），将反复核对`);
    }
  }

  // ---------- 浏览器 ----------
  async setupBrowser() {
    this.browser = await chromium.launch();
    this.page = await this.browser.newPage();

    // 给每个 API 请求注入关联头：runId:动作号。门户回显后，
    // 响应就能被精确绑定到"哪一次采集动作"，核对服务也会校验回显。
    await this.page.route('**/api/**', (route) => {
      const headers = {
        ...route.request().headers(),
        'x-collect-action': `${this.runId}:${this.currentAction}`,
      };
      route.continue({ headers });
    });

    this.page.on('request', (req) => {
      const m = /\/api\/rows\/([^/]+)\/details/.exec(req.url());
      if (m) this.lastDetailRequest = { rowId: decodeURIComponent(m[1]), method: req.method(), url: req.url() };
    });

    this.page.on('response', (resp) => {
      const url = resp.url();
      if (url.includes('/api/summary')) {
        resp.json().then((body) => {
          this.enqueueArtifact(this.makeArtifact({
            kind: 'summary',
            actionId: this.actionSeq,
            request: { method: resp.request().method(), url },
            response: { status: resp.status(), requestId: body.requestId, body },
            outcome: 'ok',
          }));
        }).catch(() => {});
        return;
      }
      const m = /\/api\/rows\/([^/]+)\/details/.exec(url);
      if (m) {
        const rowId = decodeURIComponent(m[1]);
        resp.json().then((body) => {
          // 用门户回显的关联号精确匹配在途动作；对不上的视为迟到/无关响应
          const echo = body?.collectAction ?? null;
          const parsed = typeof echo === 'string' && echo.startsWith(`${this.runId}:`)
            ? Number(echo.slice(this.runId.length + 1)) : null;
          const pending = this.inflight.get(rowId);
          const artifact = this.makeArtifact({
            kind: 'detail', rowId,
            actionId: parsed ?? pending?.actionId ?? null,
            request: { method: resp.request().method(), url },
            response: { status: resp.status(), requestId: body?.requestId ?? null, body },
            outcome: resp.status() === 200 ? 'ok' : 'http_error',
          });
          if (pending && parsed === pending.actionId) {
            clearTimeout(pending.timer);
            this.inflight.delete(rowId);
            pending.resolve(artifact);
          } else {
            this.enqueueArtifact(artifact); // 迟到的响应（如超时后返回的 504）仍作证据
          }
        }).catch(() => {});
      }
    });

    const q = new URLSearchParams({
      region: this.filter.region || '', status: this.filter.status || '',
    });
    await this.page.goto(`${this.portalUrl}/?${q}`, { waitUntil: 'domcontentloaded' });
    await this.page.waitForFunction(() => window.__app, null, { timeout: 10000 });
    await this.settlePages();
  }

  async applyFilter() {
    this.beginAction();
    await this.page.selectOption('#f-region', this.filter.region || '');
    await this.page.selectOption('#f-status', this.filter.status || '');
    await Promise.all([
      this.page.waitForResponse((r) => r.url().includes('/api/summary'), { timeout: 10000 }),
      this.page.click('#filter-bar button[type=submit]'),
    ]);
    await this.settlePages();
  }

  async settlePages() {
    await this.page.waitForFunction(
      () => window.__app.state.pendingPages.size === 0, null, { timeout: 8000 },
    ).catch(() => {});
    await this.page.waitForTimeout(120);
  }

  async captureDomSnapshot(trigger) {
    const mappings = (await this.page.evaluate(() => window.__app.slotMap())).filter((x) => x.rowId);
    const hash = sha(JSON.stringify(mappings));
    if (hash === this.lastDomHash) return; // 映射未变，不重复提交
    this.lastDomHash = hash;
    this.enqueueArtifact(this.makeArtifact({
      kind: 'dom_snapshot', actionId: this.actionSeq, mappings, trigger,
    }));
  }

  // 滚动遍历：触发分页加载，记录 DOM 槽位复用
  async scrollPass() {
    this.log('滚动遍历开始（发现行 + 记录槽位复用）');
    await this.page.evaluate(() => { document.getElementById('viewport').scrollTop = 0; });
    await this.settlePages();
    await this.captureDomSnapshot('scroll-start'); // 顶部也要留证，便于追溯首屏行
    for (let i = 0; i < 60; i++) {
      this.beginAction();
      const info = await this.page.evaluate(() => {
        const vp = document.getElementById('viewport');
        vp.scrollTop = Math.min(vp.scrollTop + vp.clientHeight * 0.75, vp.scrollHeight);
        return { top: vp.scrollTop, bottom: vp.scrollTop + vp.clientHeight, height: vp.scrollHeight };
      });
      await this.settlePages();
      await this.captureDomSnapshot('scroll');
      if (info.bottom >= info.height - 2) break;
    }
    await this.flush();
    this.log(`滚动遍历结束，发现 ${this.discovered.size} 行`);
  }

  todoRows() {
    return [...this.discovered.keys()].filter((id) => !this.terminal.has(id));
  }

  waitDetail(rowId, actionId) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.inflight.delete(rowId);
        resolve(this.makeArtifact({
          kind: 'detail', rowId, actionId,
          request: { method: 'GET', url: `${this.portalUrl}/api/rows/${rowId}/details` },
          response: null,
          outcome: 'timeout',
          timeoutMs: this.detailTimeoutMs,
        }));
      }, this.detailTimeoutMs);
      this.inflight.set(rowId, { actionId, timer, resolve });
    });
  }

  async expandRow(rowId) {
    const actionId = this.beginAction();
    await this.postEvent('expand_clicked', `展开 ${rowId}`, { rowId, data: { actionId } });
    const outcome = this.waitDetail(rowId, actionId);
    const clicked = await this.page.evaluate((id) => {
      const el = document.querySelector(`.vrow[data-row-id="${id}"] [data-action="toggle"]`);
      if (!el) return false;
      el.click();
      return true;
    }, rowId);
    if (!clicked) {
      const pending = this.inflight.get(rowId);
      if (pending) { clearTimeout(pending.timer); this.inflight.delete(rowId); pending.resolve(null); }
      return false;
    }
    const artifact = await outcome;
    if (artifact) {
      if (artifact.outcome === 'timeout') {
        this.log(`行 ${rowId} 明细 ${this.detailTimeoutMs}ms 未响应 → 记为"获取失败"（非无明细）`);
      }
      this.enqueueArtifact(artifact);
      await this.flush();
    }
    return true;
  }

  async scrollToRow(rowId) {
    return this.page.evaluate((id) => {
      const app = window.__app;
      const idx = app.rowIndexOf(id);
      if (idx < 0) return false;
      const vp = document.getElementById('viewport');
      vp.scrollTop = Math.max(0, app.state.offsets[idx] - 40);
      return true;
    }, rowId);
  }

  // 展开遍历：扫过整个列表，展开所有未终态的行；每轮之间重新查询（反复核对）
  async expandPass() {
    for (let sweep = 0; sweep < this.maxSweeps; sweep++) {
      await this.refreshTerminal(); // 服务端可能已凭新汇总把行推进终态
      const todo = this.todoRows();
      if (!todo.length) return;
      this.log(`第 ${sweep + 1} 轮展开：待核对 ${todo.length} 行`);
      const attempted = new Set(); // 本轮已点击的行：避免重复点击把行折叠回去
      await this.page.evaluate(() => { document.getElementById('viewport').scrollTop = 0; });
      await this.settlePages();
      for (let step = 0; step < 80; step++) {
        const visible = (await this.page.evaluate(() => window.__app.slotMap()))
          .filter((x) => x.rowId && !this.terminal.has(x.rowId) && !attempted.has(x.rowId));
        for (const v of visible) {
          if (this.terminal.has(v.rowId) || attempted.has(v.rowId)) continue;
          attempted.add(v.rowId);
          await this.expandRow(v.rowId);
        }
        const done = await this.page.evaluate(() => {
          const vp = document.getElementById('viewport');
          const atBottom = vp.scrollTop + vp.clientHeight >= vp.scrollHeight - 2;
          if (!atBottom) vp.scrollTop = Math.min(vp.scrollTop + vp.clientHeight * 0.75, vp.scrollHeight);
          return atBottom;
        });
        await this.settlePages();
        if (done) break;
      }
      if (!this.todoRows().length) return;
      // 仍有不一致/失败的行：重新查询拿新汇总，再核对一轮
      this.log('重新查询以获取新汇总，开始反复核对');
      await this.applyFilter();
    }
  }

  async run() {
    await this.init();
    await this.setupBrowser(); // 直接打开带筛选参数的地址，首屏即为目标筛选
    await this.scrollPass();
    await this.expandPass();
    await this.flush();
    await this.refreshTerminal();
    const remaining = this.todoRows();
    await this.postEvent('collector_finished',
      remaining.length ? `采集结束，${remaining.length} 行未达终态` : '采集结束，全部行已达终态',
      { data: { remaining } });
    this.checkpoint.record({ type: 'collector_finished', remaining });
    this.log(remaining.length ? `结束，未达终态: ${remaining.join(', ')}` : '结束，全部行已达终态');
    await this.browser.close();
    return { remaining };
  }
}

// ---------- CLI ----------
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const opt = {};
  for (let i = 0; i < args.length; i += 2) opt[args[i].replace(/^--/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = args[i + 1];
  const collector = new Collector({
    runId: opt.runId ?? `run-${Date.now()}`,
    portalUrl: opt.portal ?? 'http://localhost:4100',
    verifierUrl: opt.verifier ?? 'http://localhost:4200',
    filter: { region: opt.region ?? '', status: opt.status ?? '' },
    checkpointDir: opt.checkpointDir ?? 'checkpoints',
  });
  collector.run().then(({ remaining }) => process.exit(remaining.length ? 2 : 0))
    .catch((e) => { console.error(e); process.exit(1); });
}
