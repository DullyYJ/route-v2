// 경로 간선 재탐색(pickEdge)이 '같은 노선' 간선을 고르는지 시험.  실행: node test/pick_edge.test.js
// 배경(2026-10-06f): 버스는 같은 두 정류장 사이를 여러 노선이 지나 (to, kind) 가 같은 간선이 노선 수만큼 있다.
//   다익스트라 뒤 경로를 되짚을 때 find 로 첫 간선을 집어 엉뚱한 노선의 대기·주행시간이 총시간/구간에 들어갔고,
//   버스 경로의 총시간이 타임라인 끝보다 3~6분 길었다(이촌→등촌 버스 탭: 총 72분, 타임라인 끝 69분).
const fs = require('fs'), assert = require('assert'), path = require('path');
let src = fs.readFileSync(path.join(__dirname, '..', 'route-v2-worker.js'), 'utf8');
const ei = src.lastIndexOf('\nexport {'); assert.ok(ei > 0); src = src.slice(0, ei) + '\n';
const mod = new Function('fetch', 'caches', src + '\nreturn { pickEdge, ENGINE_VERSION };')(async () => ({}), undefined);
let fail = 0; const t = (n, f) => { try { f(); console.log('  ok  ', n); } catch (e) { fail++; console.log('  FAIL', n, '\n      ', e.message.split('\n')[0]); } };
const L = [
  { to: 'B|2', w: 50, kind: 'bus', line: 'A' },
  { to: 'B|2', w: 30, kind: 'bus', line: 'B' },
  { to: 'B|2', w: 40, kind: 'bus', line: 'B' },
  { to: 'B|2', w: 99, kind: 'walk', line: undefined },
  { to: 'S|9', w: 10, kind: 'xpress', line: 'X' },
  { to: 'S|9', w: 5, kind: 'xpress', line: 'X' },
];
t('같은 노선의 간선을 고른다 (첫 간선이 아니라)', () => { assert.strictEqual(mod.pickEdge(L, 'B|2', 'bus', 'B').line, 'B'); assert.strictEqual(mod.pickEdge(L, 'B|2', 'bus', 'A').w, 50); });
t('같은 노선이 여럿이면 가중치가 가장 작은 것(다익스트라가 쓴 값)', () => assert.strictEqual(mod.pickEdge(L, 'B|2', 'bus', 'B').w, 30));
t('노선이 안 주어지면 종전처럼 첫 간선', () => assert.strictEqual(mod.pickEdge(L, 'B|2', 'bus', undefined).line, 'A'));
t('그 노선이 없으면 종전처럼 첫 일치 간선으로 되돌아간다', () => assert.strictEqual(mod.pickEdge(L, 'B|2', 'bus', 'Z').line, 'A'));
t('급행 간선은 종전처럼 첫 간선', () => assert.strictEqual(mod.pickEdge(L, 'S|9', 'xpress', 'X').w, 10));
t('종류가 다르면 안 섞인다 / 없으면 undefined', () => { assert.strictEqual(mod.pickEdge(L, 'B|2', 'walk', undefined).w, 99); assert.strictEqual(mod.pickEdge(L, 'B|3', 'bus', 'A'), undefined); assert.strictEqual(mod.pickEdge(undefined, 'B|2', 'bus', 'A'), undefined); });
console.log(fail ? `\n${fail} FAIL` : '\nall pass'); process.exitCode = fail ? 1 : 0;
