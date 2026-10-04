// /line-notices 통합 시험(공식 우선·추정 합치기·/est-status) — 모의 fetch·KV·BUSAPI.  실행: node test/est_line_notices.test.js
const fs = require('fs'), assert = require('assert');
let src = fs.readFileSync(require('path').join(__dirname, '..', 'route-v2-worker.js'), 'utf8');
const ei = src.lastIndexOf('\nexport {'); src = src.slice(0, ei) + '\n';
const W = new Function('caches', 'fetch', src + '\nreturn { w: route_v2_worker_default, SUBWAY_BUNDLE, _reset: function(){ _estMem = {at:0,out:null}; } };');
let ntceItems = [];
const fakeFetch = async (u) => {
  if (String(u).includes('B553766/ntce')) return new Response(JSON.stringify({ response: { header: { resultCode: '00' }, body: { items: { item: ntceItems } } } }), { status: 200 });
  throw new Error('unexpected fetch ' + u);
};
const caches = { default: { async match() { return undefined; }, async put() {} } };
const { w, SUBWAY_BUNDLE: B, _reset } = W(caches, fakeFetch);
const kv = new Map(); let seoulCalls = 0, mode = 'bad';
const hwNow = () => 480;
const env = { DATA_GO_KR_KEY: 'x', ROWS_KV: { async get(k) { return kv.has(k) ? JSON.parse(kv.get(k)) : null; }, async put(k, v) { kv.set(k, v); } },
  BUSAPI: { async fetch(req) { seoulCalls++; return new Response(JSON.stringify(mkList()), { status: 200 }); } } };
// 합성 9호선 열차: bundle 좌표를 쓰지 않고 이름만 필요하므로 역 이름 순서대로 배치(간격은 좌표가 정함)
const S9 = Object.keys(B.stations).filter(k => B.stations[k].l === 'S09');
function mkList() {
  const names = S9.map(k => B.stations[k].n);
  const now = Date.now(); const ts = new Date(now + 9 * 3600e3 - 15e3).toISOString().slice(0, 19).replace('T', ' ');
  // 일정 간격(역 3개마다) 또는 한 곳 크게 벌린 배치
  const idx = mode === 'bad' ? [2, 5, 8, 11, 30, 33] : [2, 5, 8, 11, 14, 17];
  return { errorMessage: { code: 'INFO-000' }, realtimePositionList: idx.map((i, n) => ({ statnNm: names[i], trainNo: String(9100 + n), updnLine: '1', recptnDt: ts, lstcarAt: '0' })) };
}
(async () => {
  // 이 시각이 판정 구간 밖이면 시계를 평일 낮으로 고정
  const realNow = Date.now; const base = Date.parse('2026-10-06T12:10:00+09:00'); let off = base - realNow();
  Date.now = () => realNow() + off;
  const get = async (q = '') => JSON.parse(await (await w.fetch(new Request('https://x.test/line-notices' + q), env, { waitUntil: (p) => p && p.then ? pending.push(p) : 0 })).text());
  const pending = [];
  _reset(); let r = await get(); await Promise.all(pending.splice(0));
  console.log('1회차 응답 lines:', JSON.stringify(r.lines), 'seoulCalls', seoulCalls);
  assert.strictEqual(r.ok, true); assert.deepStrictEqual(r.lines, {});
  off += 130e3; _reset(); r = await get(); await Promise.all(pending.splice(0));
  off += 5e3; _reset(); r = await get(); await Promise.all(pending.splice(0));
  console.log('2회차 이후 lines:', JSON.stringify(r.lines));
  assert.ok(r.lines['9호선'] && r.lines['9호선'].estimated === true && r.lines['9호선'].suspect === true);
  // 공식 공지가 같은 노선에 있으면 공식 우선
  ntceItems = [{ lineNmLst: '9호선', noftTtl: '9호선 지연', noftCn: '9호선 신호장애로 지연', noftOcrnDt: new Date(Date.now() + 9 * 3600e3 - 60e3).toISOString().slice(0, 19), nonstopYn: 'N', noftSeCd: '1' }];
  _reset(); r = await get();
  console.log('공식 포함 lines.9호선:', JSON.stringify(r.lines['9호선']).slice(0, 120));
  assert.ok(r.lines['9호선'] && !r.lines['9호선'].estimated);
  // lines 필터
  ntceItems = []; _reset(); r = await get('?lines=2호선');
  assert.deepStrictEqual(Object.keys(r.lines), []);
  const stj = JSON.parse(await (await w.fetch(new Request('https://x.test/est-status'), env, {})).text());
  console.log('est-status:', JSON.stringify(stj.lines['9호선']), JSON.stringify(stj.lines['신분당선']));
  assert.strictEqual(stj.lines['신분당선'].hold, 'no-timetable'); assert.strictEqual(stj.lines['9호선'].inWindow, true);
  console.log('PASS: /line-notices 통합(공식 우선·추정 합치기·필터) + /est-status');
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
// /est-status
