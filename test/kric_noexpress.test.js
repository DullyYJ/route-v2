// 급행 없는 노선의 '가짜 급행' 간선 차단 시험.  실행: node test/kric_noexpress.test.js
// 배경(2026-10-06): 인천2호선 검단오류→주안이 검단사거리·마전·완정·독정·검암·서구청을 건너뛰고 내려왔다.
//   KRIC 시간표에서 빠진 역을 파생 로직이 '급행 통과'로 읽어 D1 kric_xp 에 가짜 급행 간선을 저장했기 때문 → kricLoad 가 급행 없는 노선은 무시한다.
const fs = require('fs'), assert = require('assert'), path = require('path');
let src = fs.readFileSync(path.join(__dirname, '..', 'route-v2-worker.js'), 'utf8');
const ei = src.lastIndexOf('\nexport {'); assert.ok(ei > 0); src = src.slice(0, ei) + '\n';
const mod = new Function('fetch', 'caches', src + '\nreturn { kricLoad, kricNN, kricDeriveCore, kricRederive, KRIC_NO_EXPRESS, SUBWAY_BUNDLE, ENGINE_VERSION };')(async () => ({}), undefined);
let pass = 0; const t = async (n, f) => { try { await f(); pass++; console.log('  ok  ', n); } catch (e) { console.log('  FAIL', n, '\n      ', e.message.split('\n')[0]); process.exitCode = 1; } };
const B = mod.SUBWAY_BUNDLE;
const mkG = () => { const ST = {}, adj = {}; for (const k in B.stations) ST[k] = B.stations[k]; for (const k in B.seg) { const i = k.indexOf('|'), a = k.slice(0, i), b = k.slice(i + 1); (adj['S|' + a] = adj['S|' + a] || []).push({ to: 'S|' + b, w: B.seg[k], kind: 'ride', line: B.stations[a].l }); } return { ST, LN: B.lines, adj }; };
const mkEnv = (xrows, srows) => ({ DB: { prepare: (sql) => ({ all: async () => ({ results: /kric_xp/.test(sql) ? xrows : (srows || []) }) }) } });
const sg = (line, a, b, sec) => ({ line, a, b, sec });
const hasRide = (G, a, b) => (G.adj['S|' + a] || []).some((e) => e.to === 'S|' + b && e.kind === 'ride');
const rideW = (G, a, b) => ((G.adj['S|' + a] || []).find((e) => e.to === 'S|' + b && e.kind === 'ride') || {}).w;
const xp = (line, a, b) => ({ line, a, b, hop: 690, wk: '', we: '', hk: '', he: '' });
const xcount = (G, line) => { let n = 0; for (const k in G.adj) for (const e of G.adj[k]) if (e.kind === 'xpress' && e.line === line) n++; return n; };
(async () => {
  console.log('[kricLoad — 급행 간선]');
  await t('인천2호선(IN2) 가짜 급행 간선은 그래프에 들어가지 않는다', async () => {
    const G = mkG(); await mod.kricLoad(mkEnv([xp('IN2', 'IN2-001', 'IN2-007'), xp('IN2', 'IN2-002', 'IN2-008'), xp('IN2', 'IN2-018', 'IN2-027')]), G);
    assert.strictEqual(xcount(G, 'IN2'), 0);
  });
  await t('급행이 실제로 있는 1·9호선은 그대로 들어간다', async () => {
    const G = mkG(); await mod.kricLoad(mkEnv([xp('S01', 'S01-001', 'S01-002'), xp('S09', 'S09-001', 'S09-003')]), G);
    assert.strictEqual(xcount(G, 'S01'), 1); assert.strictEqual(xcount(G, 'S09'), 1);
  });
  await t('IN2 와 S01 이 섞여 있어도 IN2 만 걸러진다', async () => {
    const G = mkG(); await mod.kricLoad(mkEnv([xp('IN2', 'IN2-001', 'IN2-007'), xp('S01', 'S01-001', 'S01-002')]), G);
    assert.strictEqual(xcount(G, 'IN2'), 0); assert.strictEqual(xcount(G, 'S01'), 1);
  });
  await t('제외 목록은 급행이 있는 노선(1·4·9·공항철도·경의중앙·경춘·수인분당·서해선·GTX-A)을 포함하지 않는다', () => {
    ['S01', 'S04', 'S09', 'ARX', 'GJC', 'GCC', 'SUI', 'SHS', 'GXA'].forEach((l) => assert.ok(!mod.KRIC_NO_EXPRESS[l], l));
    ['IN1', 'IN2', 'GIM', 'UIS'].forEach((l) => assert.ok(mod.KRIC_NO_EXPRESS[l], l));
  });
  console.log('\n[kricLoad — 비인접 직행 구간 / 이름 별칭]');
  await t('KRIC 의 새 이름 서해구청 은 서구청 과 같은 역으로 맞춘다(시간표에서 역이 빠지지 않게)', () => {
    assert.strictEqual(mod.kricNN('운동장.송담대'), mod.kricNN('용인중앙시장'));
    assert.strictEqual(mod.kricNN('서해구청'), mod.kricNN('서구청')); assert.strictEqual(mod.kricNN('서구청'), '서구청'); assert.strictEqual(mod.kricNN('주안역'), '주안');
  });
  await t('인천2호선 아시아드경기장→가정 직행(서구청 건너뜀) 구간은 버리고, 인접 구간 시간은 반영한다', async () => {
    const G = mkG(); await mod.kricLoad(mkEnv([], [sg('IN2', 'IN2-009', 'IN2-011', 240), sg('IN2', 'IN2-009', 'IN2-010', 99)]), G);
    assert.ok(!hasRide(G, 'IN2-009', 'IN2-011'), '직행 구간이 남아 있다'); assert.strictEqual(rideW(G, 'IN2-009', 'IN2-010'), 99);
  });
  await t('급행이 있는 노선(1호선)은 번들에 없던 구간도 그대로 추가한다(종전 동작)', async () => {
    const G = mkG(); await mod.kricLoad(mkEnv([], [sg('S01', 'S01-001', 'S01-004', 600)]), G);
    assert.ok(hasRide(G, 'S01-001', 'S01-004'));
  });
  console.log('\n[kricDeriveCore — 파생 단계에서도 막는다]');
  const mkRows = () => {
    const ids = Object.keys(B.stations).filter((k) => k.startsWith('IN2-')).sort(), rows = { '8': [], '9': [] };
    const hhmmss = (sec) => { const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), x = sec % 60; return String(h).padStart(2, '0') + String(m).padStart(2, '0') + String(x).padStart(2, '0'); };
    const lines = ids.map(() => []);
    // 빠진 열차(tr>=6)는 같은 구간을 더 짧게 간 것처럼 찍힌다 = KRIC 누락 데이터가 급행처럼 보이는 상황
    for (let tr = 0; tr < 12; tr++) {                       // 12대: 앞 6대는 전 역 정차, 뒤 6대는 시간표에서 검단사거리~검암(3~7번째) 행이 빠진 열차
      ids.forEach((id, i) => { if (tr >= 6 && i >= 2 && i <= 6) return; const t = 8 * 3600 + tr * 600 + i * 120 - (tr >= 6 ? Math.min(Math.max(i - 1, 0), 6) * 60 : 0); lines[i].push('T' + tr + ',' + hhmmss(t) + ',' + hhmmss(t + 20) + ',,'); });
    }
    ids.forEach((id, i) => { const nm = B.stations[id].n === '서구청' ? '서해구청' : B.stations[id].n; rows['8'].push({ nm, data: lines[i].join('\n') }); });
    return rows;
  };
  await t('시간표에서 일부 열차의 역이 빠져도 인천2호선은 급행 간선을 만들지 않고, 서해구청도 매칭된다', () => {
    const out = mod.kricDeriveCore(B, 'IN2', mkRows());
    assert.strictEqual(out.xp.length, 0, '급행 간선 ' + out.xp.length + '개'); assert.ok(!out.unmatched['서해구청'], '서해구청 미매칭');
    assert.ok(out.seg.some((q) => q[0] === 'IN2-009>IN2-010') && out.seg.some((q) => q[0] === 'IN2-010>IN2-011'), '서구청 앞뒤 구간 없음');
    assert.ok(!out.seg.some((q) => q[0] === 'IN2-009>IN2-011'), '서구청을 건너뛰는 직행이 남아 있다');
  });
  await t('같은 데이터라도 급행이 있는 노선(경로 코드 S01)은 종전대로 급행 파생이 허용된다(제외 목록에 없다)', () => assert.ok(!mod.KRIC_NO_EXPRESS.S01));
  await t('rederive 는 lines 로 지정한 노선만 다시 계산한다', async () => {
    const calls = []; const db = { prepare: (sql) => { const o = { sql, args: [], bind: (...a) => { o.args = a; return o; }, first: async () => null, all: async () => ({ results: [] }), run: async () => { calls.push(sql); } }; return o; }, batch: async () => {} };
    const r = await mod.kricRederive({ DB: db }, ['IN2']);
    assert.strictEqual(r.line, 'IN2'); assert.strictEqual(r.remaining, 0);
  });
  await t('엔진 버전이 갱신돼 있다(배포 확인용)', () => assert.ok(/^route-v2-2026-10-06/.test(mod.ENGINE_VERSION), mod.ENGINE_VERSION));
  console.log('\n' + pass + '개 통과'); if (process.exitCode) console.log('실패 있음');
})();
