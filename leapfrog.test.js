// 갈아탄 노선이 출발 정류장도 지나면 처음부터 타는 쪽으로 합치는지 시험.  실행: node test/leapfrog.test.js
// 배경(2026-10-11): 75번→인천e음89(갈현교입구 환승) 인데 e음89 는 출발 정류장부터 같은 길로 지나간다. 직행이 같거나 더 빠르다.
const fs = require('fs'), assert = require('assert'), path = require('path');
let src = fs.readFileSync(path.join(__dirname, '..', 'route-v2-worker.js'), 'utf8');
const ei = src.lastIndexOf('\nexport {'); assert.ok(ei > 0); src = src.slice(0, ei) + '\n';
const mod = new Function('fetch', 'caches', src + '\nreturn { collapseLeapfrog, ENGINE_VERSION };')(async () => ({}), undefined);
let fail = 0; const t = (n, f) => { try { f(); console.log('  ok  ', n); } catch (e) { fail++; console.log('  FAIL', n, '\n      ', e.message.split('\n')[0]); } };
const pts = { S: [37.58, 126.70], A: [37.581, 126.702], D: [37.582, 126.704], X: [37.583, 126.706], Y: [37.586, 126.71], Z: [37.59, 126.72] };
const row = (rk, id, seq) => ({ route_key: rk, node_id: id, node_nm: id, seq, lat: pts[id][0], lng: pts[id][1] });
const mkG = (live) => ({
  routeStops: { R89: ['S', 'A', 'D', 'X', 'Y', 'Z'].map((id, i) => row('R89', id, i)), R75: ['S', 'A', 'D', 'Y'].map((id, i) => row('R75', id, i)) },
  routeNoOf: { R89: '89', R75: '75' }, routeWait: { R89: 300, R75: 300 }, routeTypeOf: {}, busNm: {},
  live: live || { 'S': { '89': [1000, 1700] } },
  accessSec: { 'S': 60 },
});
const mkLegs = () => [
  { mode: 'bus', line: 'R75', busNo: '75', from: 'S', to: 'D', stopList: ['S', 'A', 'D'], coordList: [pts.S, pts.A, pts.D], secList: [0, 100, 200], waitSec: 300, sec: 500, boardStopId: 'S' },
  { mode: 'walk', sec: 30 },
  { mode: 'bus', line: 'R89', busNo: '89', from: 'X', to: 'Z', stopList: ['X', 'Y', 'Z'], coordList: [pts.X, pts.Y, pts.Z], secList: [0, 200, 500], waitSec: 120, sec: 620, _busXfer: false },
];
t('직행이 환승과 비슷하면 합쳐서 89 한 구간', () => {
  const G = mkG(), L = mkLegs();
  const r = mod.collapseLeapfrog(L, G, 60);
  assert.strictEqual(r.kind, 'collapse');
  assert.strictEqual(L.length, 1);
  assert.strictEqual(L[0].busNo, '89');
  assert.strictEqual(L[0].stopList[0], 'S');
  assert.strictEqual(L[0].stopList[L[0].stopList.length - 1], 'Z');
  assert.ok(r.dxf >= 1, 'dxf=' + r.dxf);
  assert.ok(L[0].secList.length === L[0].stopList.length);
  assert.ok(Math.abs(r.delta - (L[0].sec - 1150)) < 1e-6, String(r.delta));
});
t('환승이 확실히 빠르면(이미 지나간 차를 중간에서 잡음) 그대로 둔다', () => {
  // 직행 첫 차는 460s 에 오지만, 방금 출발정류장을 지난 앞 차(약 -100s)가 환승지점에 650s 쯤 닿아 환승이 더 빠르다
  const G = mkG({ 'S': { '89': [460, 960] } }), L = mkLegs();
  const r = mod.collapseLeapfrog(L, G, 60);
  assert.notStrictEqual(r.kind, 'collapse');
  assert.strictEqual(L.length, 3);
});
t('같은 노선이 출발 정류장을 안 지나면 그대로', () => {
  const G = mkG(); G.routeStops.R89 = ['X', 'Y', 'Z'].map((id, i) => row('R89', id, i));
  const L = mkLegs(); const r = mod.collapseLeapfrog(L, G, 60);
  assert.strictEqual(r.kind, null); assert.strictEqual(L.length, 3);
});
t('순환 노선은 건드리지 않는다', () => {
  const G = mkG(); G.routeNoOf.R89 = '89순환';
  const L = mkLegs(); const r = mod.collapseLeapfrog(L, G, 60);
  assert.strictEqual(r.kind, null); assert.strictEqual(L.length, 3);
});
t('버스 하나뿐이면 0', () => {
  const L = [mkLegs()[0]]; const r = mod.collapseLeapfrog(L, mkG(), 60);
  assert.strictEqual(r.kind, null); assert.strictEqual(r.delta, 0);
  assert.strictEqual(mod.collapseLeapfrog(null, null, 0).delta, 0);
});
t('환승 대기가 실제보다 짧게 잡혀 있으면 끌어올린다', () => {
  const G = mkG({ 'S': { '89': [460, 960] } }), L = mkLegs();
  L[2].waitSec = 20; L[2].sec = 520;
  const r = mod.collapseLeapfrog(L, G, 60);
  assert.strictEqual(r.kind, 'raise');
  assert.ok(L[2].waitSec >= 100 && L[2].waitSec <= 140, String(L[2].waitSec));
  assert.ok(Math.abs(r.delta - (L[2].waitSec - 20)) < 1e-6);
  assert.ok(L.every((x) => isFinite(x.sec)));
});
console.log(fail ? `\n${fail} FAIL` : '\nall pass'); process.exitCode = fail ? 1 : 0;
