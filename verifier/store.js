// 核对服务的存储层（node:sqlite）。所有证据原件落库，支持逐行追溯。
import { DatabaseSync } from 'node:sqlite';

export function createStore(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS batches (
      run_id      TEXT PRIMARY KEY,
      filter_json TEXT NOT NULL,
      collector   TEXT,
      status      TEXT NOT NULL DEFAULT 'open',
      started_at  TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS artifacts (
      artifact_id TEXT PRIMARY KEY,   -- 采集器计算的确定性哈希：幂等键
      run_id      TEXT NOT NULL,
      kind        TEXT NOT NULL,      -- summary | detail | dom_snapshot
      row_id      TEXT,
      outcome     TEXT,               -- ok | timeout | http_error
      request_id  TEXT,               -- 门户返回的 requestId（每次响应唯一）
      payload     TEXT NOT NULL,      -- 完整证据：请求+响应+采集上下文
      submitted_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_artifacts_row ON artifacts(run_id, row_id);
    CREATE TABLE IF NOT EXISTS row_states (
      run_id      TEXT NOT NULL,
      row_id      TEXT NOT NULL,
      status      TEXT NOT NULL,
      reason      TEXT,
      summary_version INTEGER,
      detail_version  INTEGER,
      rounds      INTEGER NOT NULL DEFAULT 0,
      reconciles  INTEGER,            -- 参考信号：1 勾稽相符 / 0 不符 / NULL 不可比
      limitation  TEXT,
      updated_at  TEXT NOT NULL,
      PRIMARY KEY (run_id, row_id)
    );
    CREATE TABLE IF NOT EXISTS events (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id  TEXT NOT NULL,
      row_id  TEXT,
      type    TEXT NOT NULL,
      message TEXT,
      data    TEXT,
      ts      TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_events_row ON events(run_id, row_id);
  `);

  const now = () => new Date().toISOString();

  const qEnsureBatch = db.prepare(
    `INSERT INTO batches(run_id, filter_json, collector, started_at) VALUES (?,?,?,?)
     ON CONFLICT(run_id) DO NOTHING`);
  const qInsertArtifact = db.prepare(
    `INSERT OR IGNORE INTO artifacts(artifact_id, run_id, kind, row_id, outcome, request_id, payload, submitted_at)
     VALUES (?,?,?,?,?,?,?,?)`);
  const qArtifactsForRow = db.prepare(
    `SELECT * FROM artifacts WHERE run_id=? AND row_id=? ORDER BY submitted_at, artifact_id`);
  const qSummaryArtifacts = db.prepare(
    `SELECT * FROM artifacts WHERE run_id=? AND kind='summary' ORDER BY submitted_at, artifact_id`);
  const qUpsertRow = db.prepare(
    `INSERT INTO row_states(run_id, row_id, status, reason, summary_version, detail_version, rounds, reconciles, limitation, updated_at)
     VALUES (@run_id,@row_id,@status,@reason,@summary_version,@detail_version,@rounds,@reconciles,@limitation,@updated_at)
     ON CONFLICT(run_id,row_id) DO UPDATE SET
       status=@status, reason=@reason, summary_version=@summary_version, detail_version=@detail_version,
       rounds=@rounds, reconciles=@reconciles, limitation=@limitation, updated_at=@updated_at`);
  const qGetRow = db.prepare(`SELECT * FROM row_states WHERE run_id=? AND row_id=?`);
  const qRows = db.prepare(`SELECT * FROM row_states WHERE run_id=? ORDER BY row_id`);
  const qAddEvent = db.prepare(
    `INSERT INTO events(run_id, row_id, type, message, data, ts) VALUES (?,?,?,?,?,?)`);
  const qEventsForRow = db.prepare(
    `SELECT * FROM events WHERE run_id=? AND (row_id=? OR row_id IS NULL) ORDER BY id`);
  const qBatches = db.prepare(`SELECT * FROM batches ORDER BY started_at DESC`);
  const qGetBatch = db.prepare(`SELECT * FROM batches WHERE run_id=?`);
  const qDomMentions = db.prepare(
    `SELECT artifact_id, kind, row_id, outcome, payload, submitted_at FROM artifacts
     WHERE run_id=? AND kind='dom_snapshot' AND payload LIKE ? ORDER BY submitted_at`);
  const qSummaryMentions = db.prepare(
    `SELECT artifact_id, kind, row_id, outcome, payload, submitted_at FROM artifacts
     WHERE run_id=? AND kind='summary' AND payload LIKE ? ORDER BY submitted_at`);
  const qSetBatchStatus = db.prepare(`UPDATE batches SET status=? WHERE run_id=?`);
  const qCountArtifacts = db.prepare(`SELECT COUNT(*) n FROM artifacts WHERE run_id=?`);

  return {
    ensureBatch({ runId, filter, collector }) {
      qEnsureBatch.run(runId, JSON.stringify(filter ?? {}), collector ?? null, now());
    },
    getBatch(runId) {
      const b = qGetBatch.get(runId);
      return b ? { ...b, filter: JSON.parse(b.filter_json) } : null;
    },
    listBatches() {
      return qBatches.all().map((b) => ({ ...b, filter: JSON.parse(b.filter_json) }));
    },
    setBatchStatus(runId, status) { qSetBatchStatus.run(status, runId); },
    artifactCount(runId) { return qCountArtifacts.get(runId).n; },

    // 幂等：artifact_id 冲突即重复提交，返回 duplicate=true
    insertArtifact(a) {
      const r = qInsertArtifact.run(
        a.artifactId, a.runId, a.kind, a.rowId ?? null, a.outcome ?? null,
        a.requestId ?? null, JSON.stringify(a), a.submittedAt ?? now());
      return { duplicate: r.changes === 0 };
    },
    artifactsForRow(runId, rowId) {
      return qArtifactsForRow.all(runId, rowId).map((r) => ({ ...r, payload: JSON.parse(r.payload) }));
    },
    summaryArtifacts(runId) {
      return qSummaryArtifacts.all(runId).map((r) => ({ ...r, payload: JSON.parse(r.payload) }));
    },
    domMentions(runId, rowId) {
      return qDomMentions.all(runId, `%${rowId}%`).map((r) => ({ ...r, payload: JSON.parse(r.payload) }));
    },
    summaryMentions(runId, rowId) {
      return qSummaryMentions.all(runId, `%${rowId}%`).map((r) => ({ ...r, payload: JSON.parse(r.payload) }));
    },

    getRow(runId, rowId) { return qGetRow.get(runId, rowId) ?? null; },
    rowsForBatch(runId) { return qRows.all(runId); },
    saveRowState(runId, rowId, s) {
      const n = (v) => (v === undefined ? null : v);
      qUpsertRow.run({
        run_id: runId, row_id: rowId, status: s.status, reason: n(s.reason),
        summary_version: n(s.summaryVersion), detail_version: n(s.detailVersion),
        rounds: s.rounds ?? 0, reconciles: s.reconciles === null || s.reconciles === undefined ? null : (s.reconciles ? 1 : 0),
        limitation: n(s.limitation), updated_at: now(),
      });
    },

    addEvent(runId, rowId, type, message, data) {
      qAddEvent.run(runId, rowId ?? null, type, message ?? null, data ? JSON.stringify(data) : null, now());
    },
    eventsForRow(runId, rowId) {
      return qEventsForRow.all(runId, rowId).map((e) => ({ ...e, data: e.data ? JSON.parse(e.data) : null }));
    },

    close() { db.close(); },
  };
}
