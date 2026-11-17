// 演示编排：启动门户与核对服务，依次演示
//   A 滚动行复用（DOM 槽位复用可观测，源数据持续变化 → 保留不确定批次）
//   B 查看期间某行更新（版本不一致 → 反复核对 → 一致）
//   C 明细超时（获取失败 ≠ 无明细）
//   D 采集器崩溃重启（断点续采 + 幂等入库）
// 每个场景做断言，最后截图并保留服务供页面查看。
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { ensureBrowserEnv } from '../scripts/browser-env.mjs';

ensureBrowserEnv();

const PORTAL = 'http://localhost:4100';
const VERIFIER = 'http://localhost:4200';
const DB = 'demo/demo.db';
const NO_SERVE = process.argv.includes('--no-serve');
const TERMINAL = new Set(['verified', 'uncertain', 'incomplete']);

const children = [];
function sh(args, name, env = {}) {
  const proc = spawn(process.execPath, args, {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const pipe = (stream) => stream.on('data', (d) => {
    for (const l of d.toString().split('\n')) if (l.trim()) console.log(`  [${name}] ${l}`);
  });
  pipe(proc.stdout); pipe(proc.stderr);
  children.push(proc);
  return proc;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitHealth(url, name) {
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(url)).ok) return; } catch { /* 未就绪 */ }
    await wait(200);
  }
  throw new Error(`${name} 未就绪: ${url}`);
}

async function chaos(msg) {
  const r = await fetch(`${PORTAL}/api/chaos`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(msg),
  });
  return r.json();
}

function runCollector(runId, filter = {}) {
  return new Promise((resolve) => {
    const proc = sh([
      'collector/collector.js', '--run-id', runId,
      '--region', filter.region ?? '', '--status', filter.status ?? '',
    ], `coll:${runId}`);
    proc.on('exit', (code) => resolve(code));
  });
}

const failures = [];
function check(name, cond, detail = '') {
  console.log(`  ${cond ? '✔' : '✘'} ${name}${detail ? ` —— ${detail}` : ''}`);
  if (!cond) failures.push(name);
}

const db = () => new DatabaseSync(DB, { readOnly: true });
const rowsOf = (d, runId) => d.prepare('SELECT * FROM row_states WHERE run_id=?').all(runId);
const artsOf = (d, runId, kind) => d.prepare('SELECT * FROM artifacts WHERE run_id=? AND kind=?').all(runId, kind);

async function scenarioA() {
  console.log('\n=== 场景 A：滚动行复用 + 源数据持续变化（反复核对 / 保留不确定性）===');
  await chaos({ action: 'mutator', on: true, intervalMs: 2500 }); // 后台随机变更
  await chaos({ action: 'hot_row', rowId: 'DO-1007', intervalMs: 200 }); // DO-1007 持续变更
  const code = await runCollector('run-scroll');
  await chaos({ action: 'reset' });
  check('A: 采集器正常结束', code === 0, `exit=${code}`);

  const d = db();
  const rows = rowsOf(d, 'run-scroll');
  check('A: 60 行全部入库', rows.length === 60, `实际 ${rows.length}`);
  const hot = rows.find((r) => r.row_id === 'DO-1007');
  check('A: 热点行 DO-1007 反复核对后保留为"不确定"', hot?.status === 'uncertain', `实际 ${hot?.status}，${hot?.rounds} 轮`);
  check('A: 不确定行带限制说明', Boolean(hot?.limitation), hot?.limitation ?? '');
  const verified = rows.filter((r) => r.status === 'verified').length;
  check('A: 其余行绝大多数已核对', verified >= 50, `verified=${verified}`);
  check('A: 无"明细获取失败"行', rows.every((r) => r.status !== 'incomplete'));

  // DOM 槽位复用：同一槽位在滚动中渲染过多个不同行
  const slotToRows = new Map();
  for (const a of artsOf(d, 'run-scroll', 'dom_snapshot')) {
    for (const m of JSON.parse(a.payload).mappings ?? []) {
      if (!slotToRows.has(m.slot)) slotToRows.set(m.slot, new Set());
      slotToRows.get(m.slot).add(m.rowId);
    }
  }
  const maxReuse = Math.max(0, ...[...slotToRows.values()].map((s) => s.size));
  check('A: DOM 槽位复用可观测（同一槽位渲染过多行）', maxReuse >= 3, `单槽位最多映射 ${maxReuse} 行`);

  const batch = await (await fetch(`${VERIFIER}/api/batches/run-scroll`)).json();
  check('A: 批次带限制说明（页面显式展示）', Boolean(batch.limitation), batch.limitation ?? '');
  d.close();
}

async function scenarioB() {
  console.log('\n=== 场景 B：查看期间某行更新（版本不一致 → 反复核对 → 一致）===');
  await chaos({ action: 'mutate_after_summary', rowId: 'DO-1020' }); // 汇总发出后 DO-1020 立即变化
  const code = await runCollector('run-update');
  check('B: 采集器正常结束', code === 0, `exit=${code}`);

  const d = db();
  const rows = rowsOf(d, 'run-update');
  const row = rows.find((r) => r.row_id === 'DO-1020');
  check('B: DO-1020 最终已核对', row?.status === 'verified', `实际 ${row?.status}`);
  check('B: 汇总与明细版本最终一致', row?.summary_version === row?.detail_version,
    `summary=v${row?.summary_version} detail=v${row?.detail_version}`);
  check('B: 全部行已核对', rows.every((r) => r.status === 'verified') && rows.length === 60);
  const ev = d.prepare("SELECT * FROM events WHERE run_id='run-update' AND row_id='DO-1020' AND type='row_status'").all();
  // 反复核对 = 检出版本不一致 → 重新获取证据 → 一致（可由汇总重取或明细重取完成）
  check('B: 经过反复核对（轨迹含 不一致→一致）', ev.some((e) => e.message.includes('version_mismatch'))
    && ev.some((e) => e.message.includes('version_match')),
    ev.map((e) => e.message).join(' | '));
  d.close();
}

async function scenarioC() {
  console.log('\n=== 场景 C：明细超时（获取失败 ≠ 无明细）===');
  await chaos({ action: 'timeout', rowId: 'DO-1030', times: 1 }); // DO-1030 首次明细请求挂起
  const code = await runCollector('run-detail-timeout');
  check('C: 采集器正常结束', code === 0, `exit=${code}`);

  const d = db();
  const rows = rowsOf(d, 'run-detail-timeout');
  const row = rows.find((r) => r.row_id === 'DO-1030');
  check('C: DO-1030 重试后最终已核对', row?.status === 'verified', `实际 ${row?.status}`);
  const det = d.prepare("SELECT * FROM artifacts WHERE run_id='run-detail-timeout' AND row_id='DO-1030' AND kind='detail'").all();
  check('C: 存在超时证据（而非"无明细"记录）', det.some((a) => a.outcome === 'timeout'));
  const timeoutArt = det.find((a) => a.outcome === 'timeout');
  check('C: 超时证据不伪造空明细', timeoutArt && JSON.parse(timeoutArt.payload).response === null);
  check('C: 重试后拿到真实明细', det.some((a) => a.outcome === 'ok'));
  check('C: 全部行终态', rows.every((r) => TERMINAL.has(r.status)) && rows.length === 60);
  d.close();
}

async function scenarioD() {
  console.log('\n=== 场景 D：采集器崩溃重启（断点续采 + 幂等入库）===');
  const proc1 = sh(['collector/collector.js', '--run-id', 'run-restart'], 'coll:run-restart#1');
  // 等首批行进入终态后杀掉采集器
  let term = 0;
  for (let i = 0; i < 400; i++) {
    try {
      const b = await (await fetch(`${VERIFIER}/api/batches/run-restart`)).json();
      term = (b.counts?.verified ?? 0) + (b.counts?.uncertain ?? 0) + (b.counts?.incomplete ?? 0);
      if (term >= 15) break;
    } catch { /* 批次尚未创建 */ }
    await wait(300);
  }
  check('D: 首次运行已产出部分终态行', term >= 15, `terminal=${term}`);
  proc1.kill('SIGKILL');
  await new Promise((r) => proc1.on('exit', r));
  console.log('  …采集器已被 SIGKILL，3s 后以同一 run-id 重启');
  await wait(3000);

  const code = await runCollector('run-restart');
  check('D: 重启后采集器正常结束', code === 0, `exit=${code}`);

  const d = db();
  const rows = rowsOf(d, 'run-restart');
  check('D: 60 行全部终态', rows.length === 60 && rows.every((r) => TERMINAL.has(r.status)));
  const starts = d.prepare("SELECT * FROM events WHERE run_id='run-restart' AND type='collector_started'").all();
  check('D: 两次启动均留痕（可追溯）', starts.length === 2 && starts.some((e) => e.message.includes('第 2 次')),
    `启动记录 ${starts.length} 条`);
  const detCount = d.prepare("SELECT COUNT(*) n FROM artifacts WHERE run_id='run-restart' AND kind='detail'").get().n;
  check('D: 重启未大面积重复展开', detCount <= 65, `明细证据 ${detCount} 条（60 行）`);
  const dup = d.prepare(`SELECT COUNT(*) n FROM (
    SELECT artifact_id FROM artifacts WHERE run_id='run-restart' GROUP BY artifact_id HAVING COUNT(*)>1)`).get().n;
  check('D: 证据入库幂等（无重复）', dup === 0);
  d.close();
}

async function screenshots() {
  console.log('\n=== 截图（demo/shots/）===');
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(PORTAL, { waitUntil: 'networkidle' }).catch(() => {});
  await page.waitForTimeout(1200);
  await page.screenshot({ path: 'demo/shots/portal.png' });
  await page.goto(VERIFIER, { waitUntil: 'networkidle' }).catch(() => {});
  await page.waitForTimeout(1200);
  await page.click('li[data-run="run-scroll"]');
  await page.waitForTimeout(600);
  await page.screenshot({ path: 'demo/shots/viewer-batch.png' });
  await page.click('tr[data-row="DO-1007"]');
  await page.waitForTimeout(800);
  await page.screenshot({ path: 'demo/shots/viewer-lineage.png' });
  await browser.close();
  console.log('  已保存 portal.png / viewer-batch.png / viewer-lineage.png');
}

async function main() {
  // 端口预检：已有服务占用时直接失败，避免连到旧进程读到脏数据
  for (const [url, name] of [[PORTAL, 'portal'], [VERIFIER, 'verifier']]) {
    const occupied = await fetch(url).then(() => true).catch(() => false);
    if (occupied) {
      console.error(`端口已被占用（${name} ${url}），请先停止旧进程`);
      process.exit(1);
    }
  }

  rmSync(DB, { force: true });
  rmSync('checkpoints', { recursive: true, force: true });
  mkdirSync('demo/shots', { recursive: true });

  sh(['portal/server.js'], 'portal');
  sh(['verifier/server.js'], 'verifier', { VERIFIER_DB: DB });
  await waitHealth(`${PORTAL}/api/state`, 'portal');
  await waitHealth(`${VERIFIER}/api/batches`, 'verifier');
  console.log('门户与核对服务已就绪\n');

  await scenarioA();
  await scenarioB();
  await scenarioC();
  await scenarioD();
  await screenshots();

  console.log('\n=== 批次汇总 ===');
  const { batches } = await (await fetch(`${VERIFIER}/api/batches`)).json();
  for (const b of batches.reverse()) {
    const c = b.counts ?? {};
    console.log(`  ${b.run_id}: ${b.rowCount} 行 · 已核对 ${c.verified ?? 0} · 不确定 ${c.uncertain ?? 0} · 明细缺失 ${c.incomplete ?? 0}`);
    if (b.limitation) console.log(`    ⚠ ${b.limitation}`);
  }

  if (failures.length) {
    console.log(`\n✘ ${failures.length} 项断言失败: ${failures.join('；')}`);
  } else {
    console.log('\n✔ 全部断言通过');
  }
  console.log(`\n门户: ${PORTAL}   追溯页: ${VERIFIER}`);

  if (NO_SERVE) {
    for (const p of children) p.kill('SIGTERM');
    await wait(500);
    for (const p of children) { try { p.kill('SIGKILL'); } catch { /* 已退出 */ } }
    process.exit(failures.length ? 1 : 0);
  }
  console.log('服务保持运行，按 Ctrl+C 结束');
  await new Promise(() => {});
}

process.on('SIGINT', () => {
  for (const p of children) p.kill('SIGTERM');
  process.exit(0);
});

main().catch((e) => {
  console.error(e);
  for (const p of children) p.kill('SIGTERM');
  process.exit(1);
});
