// 경로 탭(최단시간·최소환승·지하철·버스) 계약 시험. 실행: node test/tab_modes.test.js [엔진파일]
//   · 지하철 탭 = 기본은 지하철만(역이 가까우면 버스 없음). 역이 멀어 버스가 필요하면 버스+지하철, 경로없음으로 두지 않는다   · 버스 탭 = 버스만(지하철 없음)
//   · 최소환승 탭 = 환승 횟수가 가장 적은 경로(시간이 좀 더 걸려도)   · 최단시간 = 가장 빠른 경로
const fs = require('fs'), assert = require('assert'), path = require('path');
let src = fs.readFileSync(process.argv[2] || path.join(__dirname, '..', 'route-v2-worker.js'), 'utf8');
const ei = src.lastIndexOf('\nexport {'); assert.ok(ei > 0); src = src.slice(0, ei) + '\n';
const mod = new Function('fetch', 'caches', src + '\nreturn { buildSubway, addBus, dijkstra, subwayTabRoute, ENGINE_VERSION, XPEN, WPEN };')(async () => ({}), undefined);
let fail = 0; const t = (n, f) => { try { f(); console.log('  ok  ', n); } catch (e) { fail++; console.log('  FAIL', n, '\n      ', e.message.split('\n')[0]); } };

const KM = 1 / 111.0;   // 위도 1km ≈ 0.009°
const O = [37.5, 127.0], D = [37.5, 127.30];
// ── 지하철 1호선: S1(출발지 근처) – S2 – S3 – S4(도착지 근처), 역간 600초
const ST = { 1: { n: '가', l: 'L1', y: 37.5, x: 127.003 }, 2: { n: '나', l: 'L1', y: 37.5, x: 127.10 }, 3: { n: '다', l: 'L1', y: 37.5, x: 127.20 }, 4: { n: '라', l: 'L1', y: 37.5, x: 127.297 } };
const seg = {}; [[1, 2], [2, 3], [3, 4]].forEach(([a, b]) => { seg[a + '|' + b] = 600; seg[b + '|' + a] = 600; });
const B = { stations: ST, lines: { L1: { n: '1호선', hw: 300 } }, seg, groups: {} };
const row = (rk, no, id, nm, seq, lat, lng) => ({ route_key: rk, route_no: no, route_type: '간선', start_time: '0400', end_time: '2400', node_id: id, node_nm: nm, seq, lat, lng });
// 버스 노선: 모두 출발지·도착지 근처에서 서고 지하철역과 멀리(500m+) 떨어진 정류장을 쓴다(정류장↔역 도보 연결이 생기지 않게 y 를 북쪽으로 3km 올림)
const Y = 37.5054;
const rowsOf = (spec) => { const rows = []; for (const [rk, no, pts] of spec) pts.forEach((p, i) => rows.push(row(rk, no, p[0], p[0], i + 1, p[1], p[2]))); return rows; };
function build(spec, farSub) {
  // farSub: 지하철을 멀리(북쪽 44km) 치워 버스만 비교하는 장면
  const Bx = farSub ? Object.assign({}, B, { stations: Object.fromEntries(Object.entries(ST).map(([k, v]) => [k, Object.assign({}, v, { y: v.y + 0.4 })])) }) : B;
  const sub = mod.buildSubway(Bx);
  const G = { adj: sub.adj, ST: sub.ST, LN: sub.LN, _baseMs: Date.UTC(2026, 9, 14, 3, 0) };
  const bc = mod.addBus(G, rowsOf(spec), Bx);
  return { G, busCoord: bc.busCoord, busNm: bc.busNm };
}
const run = (X, mode, opt) => mod.dijkstra(X.G, X.busCoord, X.busNm, O[0], O[1], D[0], D[1], mode, opt);
const modes = (r) => (r && r.legs || []).map((L) => L.mode).filter((m) => m === 'bus' || m === 'subway');
const nBus = (r) => modes(r).filter((m) => m === 'bus').length;

// ── 장면 1: 직행버스가 지하철보다 빠르다. 그래도 지하철 탭은 지하철만, 버스 탭은 버스만.
//    버스 R1: 출발지 근처(B1)에서 도착지 근처(B2)까지 한 번에.
const X1 = build([['R1', '1', [['B1', 37.5 + 0.0, 127.0005 + 0.0], ['B2', 37.5, 127.299]]]]);
// 위 정류장이 역(S1·S4)과 500m 안이면 도보 연결(환승)이 생겨 시험 의도와 다르므로 북쪽(Y)으로 옮긴 노선도 같이 쓴다
const X1b = build([['R1', '1', [['B1', Y, 127.0005], ['B2', Y, 127.299]]]]);
t('지하철 탭: 버스 구간이 하나도 없다 (직행버스가 더 빨라도)', () => {
  const r = run(X1b, 'minTime', { mustSubway: true, subwayNearest: true, noBus: true });
  assert.ok(r, '지하철만 경로가 있어야 한다');
  assert.strictEqual(nBus(r), 0, JSON.stringify(modes(r)));
  assert.ok(modes(r).indexOf('subway') >= 0);
});
t('버스 탭: 지하철 구간이 없다', () => {
  const r = run(X1b, 'minTime', { noSubway: true });
  assert.ok(r); assert.strictEqual(modes(r).filter((m) => m === 'subway').length, 0);
  assert.ok(nBus(r) >= 1);
});
const tabSub = (X, o) => mod.subwayTabRoute(X.G, X.busCoord, X.busNm, o[0], o[1], D[0], D[1]);
t('지하철 탭(역이 가까움): 직행버스가 더 빨라도 버스 없이 지하철만', () => {
  const r = tabSub(X1b, O);
  assert.ok(r); assert.strictEqual(nBus(r), 0, JSON.stringify(modes(r))); assert.ok(modes(r).indexOf('subway') >= 0);
});
t('지하철 탭(역이 멀고 버스가 역까지 데려다 줌): 버스를 타서 역까지 가고, 경로없음이 아니다', () => {
  // 출발지(126.97)는 S1 까지 약 2.9km(걸어서 30분+). 버스 R2 가 출발지 근처 F1 에서 S1 앞 F2 까지 간다.
  const far = [37.5, 126.97];
  const Xf = build([['R2', '2', [['F1', 37.5, 126.9705], ['F2', 37.5, 127.0025]]]]);
  const r = tabSub(Xf, far);
  assert.ok(r, '경로가 있어야 한다');
  assert.ok(nBus(r) >= 1, '버스 ' + nBus(r) + ' ' + JSON.stringify(modes(r)));
  assert.ok(modes(r).indexOf('subway') >= 0, '지하철도 타야 한다');
  const only = mod.dijkstra(Xf.G, Xf.busCoord, Xf.busNm, far[0], far[1], D[0], D[1], 'minTime', { mustSubway: true, subwayNearest: true, noBus: true });
  assert.ok(!only || r.totalMin < only.totalMin, '버스 경로가 걷기보다 빨라야 한다');
});
t('지하철 탭(역이 멀지만 버스가 없음): 걸어서 역까지 가는 지하철 경로(경로없음 아님)', () => {
  const far = [37.5, 126.97];
  const Xe = build([['R9', '9', [['Z1', 37.9, 127.5], ['Z2', 37.9, 127.6]]]]);
  const r = tabSub(Xe, far);
  assert.ok(r); assert.strictEqual(nBus(r), 0); assert.ok(modes(r).indexOf('subway') >= 0);
});

// ── 장면 2: 최소환승. 환승 2번인 빠른 경로 vs 환승 0번인 느린 직행(우회).
//    빠른 경로: R3(O→P1) → R4(P1→P2) → R5(P2→D), 정류장은 같은 곳(P1,P2)에서 갈아탄다.
const fastChain = [
  ['R3', '3', [['A1', Y, 127.0005], ['P1', Y, 127.10]]],
  ['R4', '4', [['P1', Y, 127.10], ['P2', Y, 127.20]]],
  ['R5', '5', [['P2', Y, 127.20], ['A9', Y, 127.299]]],
];
// 직행 R6: 같은 출발·도착 정류장이지만 남쪽으로 크게 우회(거리가 훨씬 길다)
const detour = ['R6', '6', [['A1', Y, 127.0005], ['W1', 37.10, 127.05], ['W2', 37.10, 127.25], ['A9', Y, 127.299]]];
const X2 = build(fastChain.concat([detour]), true);
t('최단시간: 환승이 있어도 더 빠른 경로를 고른다', () => {
  const r = run(X2, 'minTime');
  assert.ok(r); const direct = run(X2, 'minTransfer');
  assert.ok(r.totalMin <= direct.totalMin, r.totalMin + ' vs ' + direct.totalMin);
});
t('최소환승: 환승 횟수가 가장 적은 경로(직행)를 고른다', () => {
  const r = run(X2, 'minTransfer');
  assert.ok(r);
  assert.strictEqual(nBus(r), 1, '버스 ' + nBus(r) + '번 탔다: ' + JSON.stringify((r.legs || []).map((L) => L.busNo || L.mode)));
  assert.strictEqual(r.transfers, 0);
});
t('XPEN.minTransfer 는 환승을 시간보다 우선할 만큼 크다(>= 3600초)', () => assert.ok(mod.XPEN.minTransfer >= 3600, String(mod.XPEN.minTransfer)));
t('환승이 같으면 더 빠른 쪽: 직행이 둘이면 빠른 노선', () => {
  const X3 = build([['R7', '7', [['A1', Y, 127.0005], ['A9', Y, 127.299]]], detour], true);
  const r = run(X3, 'minTransfer');
  assert.ok(r); assert.strictEqual(r.legs.filter((L) => L.mode === 'bus')[0].busNo, '7');
});

// ── 장면 3: 최소환승이 50분씩 걷지 않는다 (YJ: "최소환승 왜 50분을 걸어가, 버스타야지")
t('최소환승: 걷기가 환승 한 번보다 훨씬 길면 버스를 탄다(약 2.5km·40분 걷기 대신 버스 1번)', () => {
  const far = [37.5, 126.975];   // S1(127.003)까지 약 2.5km
  const Xw = build([['R2', '2', [['W1', 37.5, 126.9752], ['W2', 37.5, 127.0025]]]]);
  const r = mod.dijkstra(Xw.G, Xw.busCoord, Xw.busNm, far[0], far[1], D[0], D[1], 'minTransfer');
  assert.ok(r); assert.ok(nBus(r) >= 1, '버스 ' + nBus(r) + ' ' + JSON.stringify(modes(r)));
});

// ── 장면 4: 버스를 한 정거장(500m 안)만 타고 내려 바로 걷는 구간이 없다 (YJ: "왜 같은 곳에서 버스를 타고 내리는 거야?")
t('한 정거장만 타고 내리지 않는다: 정류장→역이 걸어서 400m 이면 그냥 걷는다', () => {
  const hopRows = [['R8', '8', [['F1', 37.5, 126.95], ['F2', 37.5, 126.97], ['H1', 37.5, 126.9985]]], ['R7', '7', [['H1', 37.5, 126.9985], ['H2', 37.5, 127.0028]]]];
  const Xh = build(hopRows);
  const r = mod.dijkstra(Xh.G, Xh.busCoord, Xh.busNm, 37.5, 126.95, D[0], D[1], 'minTime');
  assert.ok(r);
  const buses = (r.legs || []).filter((L) => L.mode === 'bus');
  assert.ok(buses.length >= 1);
  for (const L of buses) assert.ok(L.stopList.length > 2 || L.busNo !== '7', '한 정거장 버스 구간이 있다: ' + L.busNo + ' ' + L.stopList.join('>'));
});

// ── 장면 5: 새벽·심야 노선은 운행시간 자료가 비어도 낮·저녁에는 다니지 않는다 (YJ: "새벽버스가 진짜 저때 다니는 거야?")
t('새벽A148(운행시각 없음)은 저녁 7시에 안 나오고, 새벽 4시에는 나온다', () => {
  const mk = (utcMs) => {
    const Bx = B, sub = mod.buildSubway(Bx);
    const G = { adj: sub.adj, ST: sub.ST, LN: sub.LN, _baseMs: utcMs };
    const rows = [['11_SEL1', '새벽A148', '마을버스', [['N1', Y, 127.0005], ['N2', Y, 127.299]]]].flatMap(([rk, no, rt, pts]) => pts.map((p, i) => ({ route_key: rk, route_no: no, route_type: rt, start_time: null, end_time: null, node_id: p[0], node_nm: p[0], seq: i + 1, lat: p[1], lng: p[2] })));
    const bc = mod.addBus(G, rows, Bx);
    return mod.dijkstra(G, bc.busCoord, bc.busNm, O[0], O[1], D[0], D[1], 'minTime', { noSubway: true });
  };
  assert.strictEqual(mk(Date.UTC(2026, 9, 13, 10, 20)), null, '19:20 KST 에는 새벽버스가 없어야 한다');
  const dawn = mk(Date.UTC(2026, 9, 12, 19, 10));   // 04:10 KST
  assert.ok(dawn && nBus(dawn) >= 1, '04:10 KST 에는 새벽버스가 다닌다');
});

console.log(fail ? fail + ' 실패' : '전부 통과', '(엔진 ' + mod.ENGINE_VERSION + ')'); process.exit(fail ? 1 : 0);
