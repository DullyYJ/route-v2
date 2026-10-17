// 환승 표시 계약 시험(엔진 s36). 실행: node test/transfers.test.js [엔진파일]
//   · 앱은 그림만 그리므로 "어디서 갈아타는가"는 엔진이 info.transfers 로 준다
//   · 같은 역 노선 갈아타기 / 도보 환승 / 버스끼리 / 일반↔급행 열차 갈아타기(같은 노선이라도 열차가 바뀐다)
const fs = require('fs'), assert = require('assert'), path = require('path');
let src = fs.readFileSync(process.argv[2] || path.join(__dirname, '..', 'route-v2-worker.js'), 'utf8');
const ei = src.lastIndexOf('\nexport {'); assert.ok(ei > 0); src = src.slice(0, ei) + '\n';
const mod = new Function('fetch', 'caches', src + '\nreturn { buildSubway, dijkstra, buildTransfers, legsToSubPath, routeToAppPath };')(() => { throw new Error('no fetch'); }, {});
let fail = 0; const t = (n, f) => { try { f(); console.log('  ok  ', n); } catch (e) { fail++; console.log('  FAIL', n, '\n      ', e.message.split('\n')[0]); } };

const sub = (name, from, to, extra) => Object.assign({ trafficType: 1, sectionTime: 10, lane: [{ name }], startName: from, endName: to }, extra || {});
const bus = (no, from, to) => ({ trafficType: 2, sectionTime: 8, lane: [{ busNo: no }], startName: from, endName: to });
const walk = (min, name) => ({ trafficType: 3, sectionTime: min, lane: [{ name: name || '도보' }] });

t('같은 역에서 노선 갈아타기 = kind line, 역·노선 이름이 엔진 값 그대로', () => {
  const r = mod.buildTransfers([walk(3), sub('1호선', '부평', '구로'), walk(1, '환승'), sub('경부선', '구로', '두정'), walk(4)]);
  assert.strictEqual(r.length, 1);
  assert.deepStrictEqual([r[0].kind, r[0].at, r[0].fromLine, r[0].toLine, r[0].walkMin, r[0].secIdx, r[0].xferSecIdx], ['line', '구로', '1호선', '경부선', 1, 1, 2]);
});
t('도보로 옮겨 타기 = kind walk (역이 다르다)', () => {
  const r = mod.buildTransfers([sub('2호선', 'A', 'B'), walk(5), bus('146', 'C', 'D')]);
  assert.strictEqual(r.length, 1);
  assert.deepStrictEqual([r[0].kind, r[0].at, r[0].boardAt, r[0].toType, r[0].toLine, r[0].walkMin], ['walk', 'B', 'C', 2, '146', 5]);
});
t('버스끼리 바로 갈아타기 = kind bus', () => {
  const r = mod.buildTransfers([bus('1', 'A', 'B'), bus('2', 'B', 'C')]);
  assert.strictEqual(r.length, 1); assert.strictEqual(r[0].kind, 'bus'); assert.strictEqual(r[0].xferSecIdx, null);
});
t('출발·도착 도보는 환승이 아니다 / 환승 없는 한 번 탑승은 빈 목록', () => {
  assert.deepStrictEqual(mod.buildTransfers([walk(3), sub('1호선', 'A', 'B'), walk(2)]), []);
  assert.deepStrictEqual(mod.buildTransfers(null), []);
});
t('일반↔급행 갈아타기(trainChanges)는 구간이 하나여도 환승으로 나온다', () => {
  const r = mod.buildTransfers([sub('1호선', '부평', '두정', { trainChanges: [{ at: '구로', idx: 3, to: 'express' }] })]);
  assert.strictEqual(r.length, 1);
  assert.deepStrictEqual([r[0].kind, r[0].at, r[0].service, r[0].secIdx, r[0].stopIdx], ['train', '구로', 'express', 0, 3]);
});
t('환승 순서 = 경로 순서 (노선 갈아타기 뒤 열차 갈아타기)', () => {
  const r = mod.buildTransfers([sub('4호선', 'A', 'B'), sub('1호선', 'B', 'E', { trainChanges: [{ at: 'C', idx: 1, to: 'express' }] })]);
  assert.deepStrictEqual(r.map((x) => x.kind + ':' + x.at), ['line:B', 'train:C']);
});

// ── 실제 길찾기: 일반 열차로 가다 급행으로 갈아타는 장면에서 엔진이 swaps 를 남기는가
const ST = { 1: { n: '가', l: 'L1', y: 37.5, x: 127.0 }, 2: { n: '나', l: 'L1', y: 37.5, x: 127.1 }, 3: { n: '다', l: 'L1', y: 37.5, x: 127.2 }, 4: { n: '라', l: 'L1', y: 37.5, x: 127.3 } };
const seg = {}; [[1, 2], [2, 3], [3, 4]].forEach(([a, b]) => { seg[a + '|' + b] = 600; seg[b + '|' + a] = 600; });
const B = { stations: ST, lines: { L1: { n: '1호선', hw: 300 } }, seg, groups: {} };
t('길찾기: 가→나는 일반, 나→라는 급행이면 leg.swaps 에 나·express 가 남는다', () => {
  const s = mod.buildSubway(B);
  const G = { adj: s.adj, ST: s.ST, LN: s.LN, _baseMs: Date.UTC(2026, 9, 14, 3, 0) };
  const all = new Array(480).fill(1);
  [[2, 3], [3, 4]].forEach(([a, b]) => (G.adj['S|' + a] = G.adj['S|' + a] || []).push({ to: 'S|' + b, w: 120, kind: 'xpress', line: 'L1', dep: all, depW: all, hp: null, hpW: null, bw: 150 }));
  const r = mod.dijkstra(G, {}, {}, 37.5, 127.001, 37.5, 127.299, 'minTime', {});
  assert.ok(r, '경로');
  const L = r.legs.find((x) => x.mode === 'subway');
  assert.ok(L && L.swaps && L.swaps.length === 1, JSON.stringify(r.legs.map((x) => [x.mode, x.swaps])));
  assert.deepStrictEqual([L.swaps[0].at, L.swaps[0].to], ['나', 'express']);
  const app = mod.routeToAppPath(r, 3, {}, 'fast');
  const tr = app.info.transfers.filter((x) => x.kind === 'train');
  assert.strictEqual(tr.length, 1); assert.strictEqual(tr[0].at, '나');
});
t('길찾기: 처음부터 끝까지 급행이면 갈아타기가 없다', () => {
  const s = mod.buildSubway(B);
  const G = { adj: s.adj, ST: s.ST, LN: s.LN, _baseMs: Date.UTC(2026, 9, 14, 3, 0) };
  const all = new Array(480).fill(1);
  [[1, 2], [2, 3], [3, 4]].forEach(([a, b]) => (G.adj['S|' + a] = G.adj['S|' + a] || []).push({ to: 'S|' + b, w: 120, kind: 'xpress', line: 'L1', dep: all, depW: all, hp: null, hpW: null, bw: 150 }));
  const r = mod.dijkstra(G, {}, {}, 37.5, 127.001, 37.5, 127.299, 'minTime', {});
  const L = r.legs.find((x) => x.mode === 'subway');
  assert.ok(L && !(L.swaps && L.swaps.length), JSON.stringify(L && L.swaps));
});
console.log(fail ? ('FAIL ' + fail) : 'ALL OK'); process.exit(fail ? 1 : 0);
