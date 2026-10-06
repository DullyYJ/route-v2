// 하차 앞당김(optimizeAlight)이 총시간에도 반영되는지 시험.  실행: node test/alight_delta.test.js
// 배경(2026-10-06e): 상계→청평(4호선→버스81→경춘선) totalTime 60분인데 타임라인 끝은 53분이었다.
//   optimizeAlight 가 legs 만 바꾸고 총시간(real)은 그대로 둬서, 하차를 앞당긴 경로는 총시간이 3~7분 길었다.
const fs = require('fs'), assert = require('assert'), path = require('path');
let src = fs.readFileSync(path.join(__dirname, '..', 'route-v2-worker.js'), 'utf8');
const ei = src.lastIndexOf('\nexport {'); assert.ok(ei > 0); src = src.slice(0, ei) + '\n';
const mod = new Function('fetch', 'caches', src + '\nreturn { optimizeAlight, ENGINE_VERSION };')(async () => ({}), undefined);
let fail = 0; const t = (n, f) => { try { f(); console.log('  ok  ', n); } catch (e) { fail++; console.log('  FAIL', n, '\n      ', e.message.split('\n')[0]); } };
const total = (legs) => legs.reduce((a, L) => a + (L.sec || 0), 0);
const mk = () => [
  { mode: 'subway', sec: 280, stopList: ['a', 'b'], coordList: [[37.0, 127.0], [37.0, 127.01]], secList: [0, 280], lineCode: 'S04' },
  { mode: 'bus', sec: 240 + 600, waitSec: 240, line: '81', stopList: ['p0', 'p1', '별내역파라곤스퀘어N동', 'p3'],
    coordList: [[37.001, 127.011], [37.002, 127.012], [37.0030, 127.0130], [37.0045, 127.0150]], secList: [0, 200, 330, 600] },
  { mode: 'walk', sec: 240 },
  { mode: 'subway', sec: 900, from: '별내', stopList: ['별내', 'z'], coordList: [[37.0030, 127.0131], [37.1, 127.1]], secList: [0, 900], lineCode: 'GCC' },
];
t('하차를 앞당기면 반환값이 구간합의 변화와 같다', () => {
  const L = mk(), before = total(L); const d = mod.optimizeAlight(L), after = total(L);
  assert.strictEqual(typeof d, 'number');
  assert.ok(d < 0, '앞당겼으니 줄어야 한다: ' + d);
  assert.ok(Math.abs(after - before - d) < 1e-6, `after-before=${after - before} d=${d}`);
  assert.strictEqual(L[1].stopList.length, 3);
});
t('바꿀 게 없으면 0', () => {
  const L = [{ mode: 'subway', sec: 100, stopList: ['a'], coordList: [[37, 127]] }, { mode: 'walk', sec: 60 }];
  assert.strictEqual(mod.optimizeAlight(L), 0);
  assert.strictEqual(mod.optimizeAlight(null), 0);
});
console.log(fail ? `\n${fail} FAIL` : '\nall pass'); process.exitCode = fail ? 1 : 0;
