// 경로 탭(최단시간·최소환승·지하철·버스) 계약 시험. 실행: node test/tab_modes.test.js [엔진파일]
//   · 지하철 탭 = 기본은 지하철만(역이 가까우면 버스 없음). 역이 멀어 버스가 필요하면 버스+지하철, 경로없음으로 두지 않는다   · 버스 탭 = 버스만(지하철 없음)
//   · 최소환승 탭 = 환승 횟수가 가장 적은 경로(시간이 좀 더 걸려도)   · 최단시간 = 가장 빠른 경로
const fs = require('fs'), assert = require('assert'), path = require('path');
let src = fs.readFileSync(process.argv[2] || path.join(__dirname, '..', 'route-v2-worker.js'), 'utf8');
const ei = src.lastIndexOf('\nexport {'); assert.ok(ei > 0); src = src.slice(0, ei) + '\n';
const mod = new Function('fetch', 'caches', src + '\nreturn { buildSubway, addBus, dijkstra, subwayTabRoute, ENGINE_VERSION, XPEN, WPEN, pickMinTransfer, pickSubwayTab, tabNormalize, busSvcNameWindow, isBusOnlyRoute };')(async () => ({}), undefined);
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


// ── 최소환승 후보 고르기: 환승 수가 확정된 경로들 중 환승 적은 순 → 빠른 순, 처음 걷기 20분 초과는 제외
t('pickMinTransfer: 환승 적은 쪽, 같으면 빠른 쪽, 너무 오래 걷는 경로는 제외', () => {
  const R = (transfers, totalMin, accessWalkMin) => ({ transfers, totalMin, accessWalkMin });
  assert.strictEqual(mod.pickMinTransfer([R(1, 47, 1), R(0, 26, 1)]).totalMin, 26);          // 직행이 있으면 그것
  assert.strictEqual(mod.pickMinTransfer([R(1, 50, 1), R(1, 40, 1)]).totalMin, 40);           // 환승 같으면 빠른 쪽
  assert.strictEqual(mod.pickMinTransfer([R(0, 70, 53), R(1, 60, 2)]).totalMin, 60);          // 53분 걷는 0환승은 제외
  assert.strictEqual(mod.pickMinTransfer([R(0, 70, 53), R(1, 60, 40)]).transfers, 0);         // 전부 오래 걸으면 그대로 환승 적은 쪽
  assert.strictEqual(mod.pickMinTransfer([null, null]), null);
});


// ── 지하철 탭: 첫 버스가 바로 다른 역에 닿으면 그 역에서 탄다(가까운 역까지 버스를 또 갈아타지 않는다)
//    (YJ: "탑승한 대중교통에서 지하철역까지 한 번에 갈 수 있으면 환승시키지 마")
t('지하철 탭: 버스 한 번으로 닿는 역(S2)이 있으면 가까운 역(S1)까지 버스를 갈아타지 않는다', () => {
  const far = [37.5, 126.97];   // 가장 가까운 역 S1 까지 약 2.9km
  const Xb = build([
    ['R2', '2', [['F1', 37.5, 126.9705], ['X1', 37.5, 127.045], ['F2', 37.5, 127.098]]],   // 출발지 근처 → 중간 → S2(127.10) 앞. 한 번에 감
    ['R5', '5', [['X1', 37.5, 127.045], ['N1', 37.5, 127.0035]]]                       // 되돌아 S1 쪽으로 가는 다른 버스(환승해야 함)
  ]);
  const r = tabSub(Xb, far);
  assert.ok(r); assert.ok(modes(r).indexOf('subway') >= 0);
  assert.strictEqual(nBus(r), 1, '버스 ' + nBus(r) + ' ' + JSON.stringify(modes(r)));
});


// ═════ 2026-10-14 (YJ: "최단시간은 최단시간, 최소환승은 최소환승, 지하철은 지하철 위주(버스 최소), 버스는 버스만") ═════
const LG = (mode, min) => ({ mode, min });
const RT = (totalMin, transfers, legs, accessWalkMin) => ({ totalMin, transfers, legs, accessWalkMin: accessWalkMin || 2 });
t('지하철 탭: 환승이 적어도 버스 위주(버스 112분+지하철 36분)는 버리고, 버스를 덜 타는 지하철 경로를 고른다 (스샷 151분 사례)', () => {
  const busHeavy = RT(131, 2, [LG('bus', 31), LG('walk', 2), LG('bus', 81), LG('walk', 2), LG('subway', 36)]);
  const subHeavy = RT(134, 3, [LG('bus', 28), LG('transfer', 2), LG('subway', 27), LG('transfer', 5), LG('subway', 52), LG('transfer', 4), LG('subway', 2)]);
  const r = mod.pickSubwayTab([busHeavy, subHeavy]);
  assert.strictEqual(r, subHeavy);
});
t('지하철 탭: 버스 없이 걸어서 닿는 지하철 경로(걷기 25분 이내)가 비슷한 시간이면 그것이 우선', () => {
  const walk = RT(70, 1, [LG('walk', 20), LG('subway', 50)], 20);
  const bus = RT(62, 1, [LG('bus', 12), LG('subway', 50)], 2);
  assert.strictEqual(mod.pickSubwayTab([bus, walk]), walk);
});
t('지하철 탭: 너무 오래 걸리는(최단보다 25%·10분 이상) 지하철 경로는 버스를 덜 타도 고르지 않는다', () => {
  const quick = RT(60, 2, [LG('bus', 20), LG('subway', 38)]);
  const slow = RT(100, 1, [LG('bus', 5), LG('subway', 90)]);
  assert.strictEqual(mod.pickSubwayTab([quick, slow]), quick);
});
t('지하철 탭: 버스를 여러 번 갈아타는 경로는 한 번당 10분 가산(같은 버스 시간이면 한 번 타는 쪽)', () => {
  const two = RT(60, 3, [LG('bus', 6), LG('bus', 6), LG('subway', 45)]);
  const one = RT(62, 2, [LG('bus', 14), LG('subway', 45)]);
  assert.strictEqual(mod.pickSubwayTab([two, one]), one);
});
t('지하철 탭: 지하철 구간이 없는 후보는 나오지 않는다', () => {
  assert.strictEqual(mod.pickSubwayTab([RT(30, 0, [LG('bus', 30)])]), null);
  assert.strictEqual(mod.pickSubwayTab([]), null);
});
t('최소환승: 걷기 20분 넘어 빠졌어도(35분 이내) 환승이 더 적고 더 빠르면 그 경로 (평내→종로 사례)', () => {
  const lessBad = { transfers: 2, totalMin: 79, accessWalkMin: 3 };
  const better = { transfers: 1, totalMin: 78, accessWalkMin: 24 };
  assert.strictEqual(mod.pickMinTransfer([lessBad, better]), better);
  const slower = { transfers: 1, totalMin: 85, accessWalkMin: 24 };
  assert.strictEqual(mod.pickMinTransfer([lessBad, slower]), lessBad, '더 느리면 걷기 긴 경로를 쓰지 않는다');
  const far = { transfers: 0, totalMin: 60, accessWalkMin: 53 };
  assert.strictEqual(mod.pickMinTransfer([lessBad, far]), lessBad, '53분 걷는 경로는 여전히 제외');
});
t('탭 마무리: 버스 탭은 지하철 없는 후보 중 가장 빠른 것(송도→강남: 63분 M6405 가 91분 9201 보다 앞)', () => {
  const m6405 = RT(63, 0, [LG('bus', 52)]);
  const b9201 = RT(102, 0, [LG('bus', 91)]);
  const sub = RT(91, 2, [LG('subway', 74)]);
  const out = { minTime: m6405, minTransfer: m6405, minWalk: RT(70, 1, [LG('bus', 17), LG('bus', 49)]), subway: sub, bus: b9201 };
  mod.tabNormalize(out);
  assert.strictEqual(out.bus.totalMin, 63);
  assert.ok(mod.isBusOnlyRoute(out.bus));
});
t('탭 마무리: 버스 탭에는 지하철·열차가 든 경로가 절대 들어가지 않는다', () => {
  const mix = RT(40, 1, [LG('bus', 10), LG('subway', 30)]);
  const train = RT(30, 0, [LG('longdist', 30)]);
  const busy = RT(90, 2, [LG('bus', 40), LG('bus', 40)]);
  const out = { minTime: mix, minTransfer: train, subway: mix, bus: busy };
  mod.tabNormalize(out);
  assert.strictEqual(out.bus, busy);
  assert.ok(mod.isBusOnlyRoute(out.bus) && !out.bus.legs.some((L) => L.mode === 'subway' || L.mode === 'longdist'));
});
t('탭 마무리: 최소환승 탭은 모든 후보 중 환승이 가장 적은 경로(최단시간보다 환승이 많을 수 없다)', () => {
  const fast = RT(60, 1, [LG('subway', 60)]);
  const less = RT(66, 2, [LG('bus', 30), LG('subway', 30)]);
  const out = { minTime: fast, minTransfer: less, subway: fast, bus: RT(80, 3, [LG('bus', 80)]) };
  mod.tabNormalize(out);
  assert.ok(out.minTransfer.transfers <= out.minTime.transfers);
});

// ── 심야버스: 운행시각이 비어도 낮에는 다니지 않는다 (YJ 스샷: 16시에 '심야A21')
t('busSvcNameWindow: 심야A21(마을버스)·N노선·12심야(심야버스)는 야간 창을 받고, 일반 노선은 null', () => {
  const w = mod.busSvcNameWindow;
  assert.deepStrictEqual(w('심야A21', '마을버스'), { s: 1410, e: 300 });
  assert.deepStrictEqual(w('N37', '심야버스'), { s: 1410, e: 300 });
  assert.deepStrictEqual(w('올빼미1', '지선버스'), { s: 1410, e: 300 });
  assert.ok(w('12심야', '심야버스') && w('12심야', '심야버스').s >= 1200);
  assert.strictEqual(w('370', '간선버스'), null);
  assert.strictEqual(w('1302', '직행좌석버스'), null);
  assert.deepStrictEqual(w('새벽A148', '마을버스'), { s: 210, e: 330 });
});
t('심야A21(운행시각 없음, 마을버스)은 낮 14시에는 경로에 없고 새벽 1시에는 나온다', () => {
  const mk = (utcMs) => {
    const sub = mod.buildSubway(B);
    const G = { adj: sub.adj, ST: sub.ST, LN: sub.LN, _baseMs: utcMs };
    const rows = [['11_SEL1', '심야A21', '마을버스', [['N1', Y, 127.0005], ['N2', Y, 127.299]]]].flatMap(([rk, no, rt, pts]) => pts.map((p, i) => ({ route_key: rk, route_no: no, route_type: rt, start_time: null, end_time: null, node_id: p[0], node_nm: p[0], seq: i + 1, lat: p[1], lng: p[2] })));
    const bc = mod.addBus(G, rows, B);
    return mod.dijkstra(G, bc.busCoord, bc.busNm, O[0], O[1], D[0], D[1], 'minTime', { noSubway: true });
  };
  assert.strictEqual(mk(Date.UTC(2026, 9, 14, 5, 30)), null, '14:30 KST 에는 심야버스가 없어야 한다');
  const night = mk(Date.UTC(2026, 9, 13, 16, 0));   // 01:00 KST
  assert.ok(night && nBus(night) >= 1, '01:00 KST 에는 심야버스가 다닌다');
});

// ── 버스 가중(busW): 버스를 덜 타는 지하철 경로를 찾는다
t('dijkstra busW: 버스에 무게를 주면 긴 버스 대신 짧은 버스+지하철(버스 시간이 더 짧은 경로)을 고른다', () => {
  const far = [37.5, 126.97];
  // R7: 출발지 근처에서 곧장 S3(127.20) 앞까지 긴 버스(약 21km). R6: S1(127.003) 앞까지 짧은 버스.
  const Xw = build([
    ['R7', '7', [['L1', 37.5, 126.9705], ['L2', 37.5, 127.198]]],
    ['R6', '6', [['H1', 37.5, 126.9705], ['H2', 37.5, 127.0025]]]
  ]);
  const a = mod.dijkstra(Xw.G, Xw.busCoord, Xw.busNm, far[0], far[1], D[0], D[1], 'minTime', { mustSubway: true });
  const b = mod.dijkstra(Xw.G, Xw.busCoord, Xw.busNm, far[0], far[1], D[0], D[1], 'minTime', { mustSubway: true, busW: 8 });
  assert.ok(a && b, JSON.stringify([!!a, !!b]));
  const busMin = (r) => r.legs.filter((L) => L.mode === 'bus').reduce((x, L) => x + L.min, 0);
  assert.ok(busMin(b) <= busMin(a), '버스 시간 ' + busMin(b) + ' vs ' + busMin(a));
});

console.log(fail ? fail + ' 실패' : '전부 통과', '(엔진 ' + mod.ENGINE_VERSION + ')'); process.exit(fail ? 1 : 0);
