// 지연 의심(추정) 판정 단위 시험 — 모의 열차 위치·KV·BUSAPI 사용, 네트워크 없음.  실행: node test/est_delay.test.js
const fs = require('fs'), assert = require('assert');
let src = fs.readFileSync(require('path').join(__dirname, '..', 'route-v2-worker.js'), 'utf8');
const ei = src.lastIndexOf('\nexport {'); assert.ok(ei > 0); src = src.slice(0, ei) + '\n';
const api = new Function(src + `
return { SUBWAY_BUNDLE, ldDayTypeKST, EST_LINES, EST_OBS_MS, EST_RESET_MS, EST_CLEARED_SHOW_MS,
  estHeadwaySec, estInServiceWindow, estWindowFor, estBaseline, estMedian, EST_BASE_MIN_N, estChain, estGaps, estVerdict, estStep, estPublic, estNewState,
  estimateNotices, estRefreshLine, estimateCached, _resetMem: function(){ _estMem = {at:0,out:null}; } };`)();
const B = api.SUBWAY_BUNDLE;
let pass = 0; const t = (name, fn) => { try { fn(); pass++; console.log('  ok  ', name); } catch (e) { console.log('  FAIL', name, '\n      ', e.message); process.exitCode = 1; } };
const at = (kstStr) => Date.parse(kstStr + '+09:00');   // 'YYYY-MM-DDTHH:MM:SS' (KST)
const WD_NOON = at('2026-10-06T12:10:00');    // 화요일 낮
const WD_NIGHT = at('2026-10-06T23:50:00');
const WD_DAWN = at('2026-10-06T05:40:00');
const SAT_NOON = at('2026-10-10T12:10:00');

console.log('[배차간격·시간대]');
t('9호선 평일 12시 = 시간표 값', () => assert.strictEqual(api.estHeadwaySec(B, 'S09', WD_NOON), B.lines.S09.tt.D['12']));
t('9호선 주말은 W 표', () => assert.strictEqual(api.estHeadwaySec(B, 'S09', SAT_NOON), B.lines.S09.tt.W['12']));
['SBD', 'ARX', 'GJC', 'SUI'].forEach(id => t(id + ' 은 tt 없음 → 보류(null)', () => assert.strictEqual(api.estHeadwaySec(B, id, WD_NOON), null)));
t('낮은 판정 구간', () => assert.strictEqual(api.estInServiceWindow(B, 'S09', WD_NOON), true));
t('심야 23:50 제외(막차는 00:55 라도 23시부터 제외)', () => assert.strictEqual(api.estInServiceWindow(B, 'S09', WD_NIGHT), false));
t('22:30 은 판정 구간', () => assert.strictEqual(api.estInServiceWindow(B, 'S09', at('2026-10-06T22:30:00')), true));
t('막차가 이른 날(주말 lt 1434=23:54)도 막차 60분 전(22:54)까지만', () => { assert.strictEqual(api.estInServiceWindow(B, 'S09', at('2026-10-10T22:50:00')), true); assert.strictEqual(api.estInServiceWindow(B, 'S09', at('2026-10-10T22:58:00')), false); });
t('첫차 직후(05:40) 제외', () => assert.strictEqual(api.estInServiceWindow(B, 'S09', WD_DAWN), false));
t('새벽 01시 제외', () => assert.strictEqual(api.estInServiceWindow(B, 'S09', at('2026-10-07T01:00:00')), false));

console.log('[노선 좌표]');
const chain = api.estChain(B, 'S09');
t('9호선은 한 줄(트리)로 잡힌다', () => assert.ok(chain && chain.n >= 30));
t('9호선 비트리 아닌 노선은 null 이거나 객체', () => { const c = api.estChain(B, 'S02'); assert.ok(c === null || c.n > 0); });
const S9 = Object.keys(B.stations).filter(k => B.stations[k].l === 'S09').sort((a, b) => chain.coord[a] - chain.coord[b]);
const nameOf = id => B.stations[id].n;
// 합성 열차: 좌표(초) 위치마다 가장 가까운 역에 배치
function stationAt(sec) { let best = S9[0]; for (const id of S9) if (Math.abs(chain.coord[id] - sec) < Math.abs(chain.coord[best] - sec)) best = id; return best; }
const total = chain.coord[S9[S9.length - 1]];
function mk(now, gapsSec, dir = '1', opt = {}) {   // 한 방향 열차를 간격 목록대로 배치
  const out = []; let pos = 300; let n = 0;
  const push = (p) => out.push({ subwayNm: '9호선', statnNm: nameOf(stationAt(p)), trainNo: String(9000 + n++ + (dir === '1' ? 0 : 500)), updnLine: dir, recptnDt: new Date(now + 9 * 3600e3 - (opt.ageSec || 20) * 1000).toISOString().slice(0, 19).replace('T', ' '), lstcarAt: '0' });
  push(pos); gapsSec.forEach(g => { pos += g; push(pos); });
  return out;
}
const hw = B.lines.S09.tt.D['12'];
console.log('  (9호선 낮 배차간격 hw=' + hw + '초, 판정 임계값=' + Math.min(hw * 2, hw + 360) + '초, 노선 길이≈' + total + '초)');

console.log('[간격 → 판정]');
const even = Array(6).fill(hw);
t('고른 간격은 good', () => { const g = api.estGaps(mk(WD_NOON, even), chain, WD_NOON); assert.ok(g.dirs, JSON.stringify(g)); assert.strictEqual(api.estVerdict(g, hw).verdict, 'good'); });
t('임계값 이상 벌어지면 bad', () => { const big = Math.min(hw * 2, hw + 360) + 120; const g = api.estGaps(mk(WD_NOON, [hw, hw, big, hw, hw]), chain, WD_NOON); assert.strictEqual(api.estVerdict(g, hw).verdict, 'bad'); });
t('임계값 바로 아래는 good', () => { const small = Math.min(hw * 2, hw + 360) - 120; const g = api.estGaps(mk(WD_NOON, [hw, small, hw, hw, hw]), chain, WD_NOON); assert.strictEqual(api.estVerdict(g, hw).verdict, 'good'); });
t('한 방향만 벌어져도 bad', () => { const a = mk(WD_NOON, even, '0'), b = mk(WD_NOON, [hw, hw * 3, hw, hw], '1'); const g = api.estGaps(a.concat(b), chain, WD_NOON); assert.strictEqual(api.estVerdict(g, hw).verdict, 'bad'); });
t('위치 자료가 5분 넘게 오래되면 보류(stale)', () => assert.strictEqual(api.estGaps(mk(WD_NOON, even, '1', { ageSec: 400 }), chain, WD_NOON).hold, 'stale'));
t('빈 목록은 보류(no-data)', () => assert.strictEqual(api.estGaps([], chain, WD_NOON).hold, 'no-data'));
t('방향당 열차 3대 미만이면 보류(few-trains)', () => assert.strictEqual(api.estGaps(mk(WD_NOON, [hw]), chain, WD_NOON).hold, 'few-trains'));
t('막차 열차가 보이면 보류(last-train)', () => { const l = mk(WD_NOON, even); l[2].lstcarAt = '1'; assert.strictEqual(api.estGaps(l, chain, WD_NOON).hold, 'last-train'); });
t('역 이름 대부분 못 찾으면 보류(unmapped)', () => { const l = mk(WD_NOON, even).map(x => Object.assign(x, { statnNm: '없는역' })); assert.strictEqual(api.estGaps(l, chain, WD_NOON).hold, 'unmapped'); });
t('노선 좌표가 없으면 보류(no-chain)', () => assert.strictEqual(api.estGaps(mk(WD_NOON, even), null, WD_NOON).hold, 'no-chain'));

console.log('[연속 2회 상태 머신]');
const bad = (ts) => ({ verdict: 'bad', obsTs: ts, worst: { dir: '1', gapSec: 1200 }, hwSec: hw });
const good = (ts) => ({ verdict: 'good', obsTs: ts, worst: { dir: '1', gapSec: 300 }, hwSec: hw });
const hold = (r) => ({ verdict: 'hold', reason: r });
const M = 60e3;
t('bad 1회는 의심 아님', () => { const s = api.estStep(null, bad(1), 1 * M); assert.strictEqual(s.phase, 'none'); assert.strictEqual(api.estPublic(s, 1 * M), null); });
t('bad 연속 2회 → 의심', () => { let s = api.estStep(null, bad(1), 1 * M); s = api.estStep(s, bad(2), 3 * M); assert.strictEqual(s.phase, 'suspect'); const p = api.estPublic(s, 3 * M); assert.strictEqual(p.estimated, true); assert.strictEqual(p.suspect, true); assert.ok(/지연 의심 \(도착 간격 기준 추정\)/.test(p.title)); });
t('bad,good,bad 는 연속이 아니라 의심 아님', () => { let s = api.estStep(null, bad(1), 1 * M); s = api.estStep(s, good(2), 3 * M); s = api.estStep(s, bad(3), 5 * M); assert.strictEqual(s.phase, 'none'); });
t('같은 자료(obsTs 동일)는 한 번만 센다', () => { let s = api.estStep(null, bad(5), 1 * M); s = api.estStep(s, bad(5), 3 * M); assert.strictEqual(s.phase, 'none'); assert.strictEqual(s.bad, 1); });
t('의심 후 good 1회는 유지, 연속 2회면 해제', () => { let s = api.estStep(null, bad(1), 1 * M); s = api.estStep(s, bad(2), 3 * M); s = api.estStep(s, good(3), 5 * M); assert.strictEqual(s.phase, 'suspect'); s = api.estStep(s, good(4), 7 * M); assert.strictEqual(s.phase, 'cleared'); const p = api.estPublic(s, 7 * M); assert.strictEqual(p.suspect, false); assert.strictEqual(p.title, '정상 운행 중으로 보여요 (도착 간격 기준)'); });
t('해제 표시는 30분 뒤 사라진다', () => { let s = api.estStep(null, bad(1), 1 * M); s = api.estStep(s, bad(2), 3 * M); s = api.estStep(s, good(3), 5 * M); s = api.estStep(s, good(4), 7 * M); assert.strictEqual(api.estPublic(s, 7 * M + 31 * M), null); });
t('처음부터 good 이면 아무것도 표시하지 않는다(정상 단정 금지)', () => { let s = api.estStep(null, good(1), 1 * M); s = api.estStep(s, good(2), 3 * M); s = api.estStep(s, good(3), 5 * M); assert.strictEqual(api.estPublic(s, 5 * M), null); });
t('보류는 의심을 해제하지 않고 정상으로도 안 바꾼다', () => { let s = api.estStep(null, bad(1), 1 * M); s = api.estStep(s, bad(2), 3 * M); s = api.estStep(s, hold('stale'), 5 * M); assert.strictEqual(s.phase, 'suspect'); assert.strictEqual(s.good, 0); });
t('보류가 10분 넘게 이어지면 의심도 내린다(정상 표시 없이)', () => { let s = api.estStep(null, bad(1), 1 * M); s = api.estStep(s, bad(2), 3 * M); s = api.estStep(s, hold('stale'), 20 * M); assert.strictEqual(s.phase, 'none'); assert.strictEqual(api.estPublic(s, 20 * M), null); });
t('관측이 10분 넘게 끊기면 연속이 아니다', () => { let s = api.estStep(null, bad(1), 1 * M); s = api.estStep(s, bad(2), 30 * M); assert.strictEqual(s.phase, 'none'); assert.strictEqual(s.bad, 1); });

console.log('[estimateNotices — 모의 KV·BUSAPI]');
function mkEnv(listFn, opts = {}) {
  const kv = new Map(); let calls = 0, urls = [];
  const env = { ROWS_KV: { async get(k) { return kv.has(k) ? JSON.parse(kv.get(k)) : null; }, async put(k, v) { kv.set(k, v); } } };
  if (!opts.noBinding) env.BUSAPI = { async fetch(req) { calls++; urls.push(decodeURIComponent(new URL(req.url).searchParams.get('path'))); const r = listFn(); return new Response(JSON.stringify(r), { status: 200 }); } };
  return { env, kv, calls: () => calls, urls: () => urls };
}
const run = async (m, now, official = {}) => { api._resetMem(); return await api.estimateNotices(m.env, undefined, official, now, B); };
(async () => {
  const healthy = () => ({ errorMessage: { code: 'INFO-000' }, realtimePositionList: mk(Date.now(), even) });
  // now 를 고정하고 그 시각에 맞춘 자료를 만든다
  const feed = (gaps, o = {}) => () => ({ errorMessage: { code: 'INFO-000' }, realtimePositionList: mk(cur.now, gaps, '1', o) });
  const cur = { now: WD_NOON };
  let m = mkEnv(feed([hw, hw, 1500, hw, hw]));
  let out = await run(m, cur.now);
  console.log('  1회차 호출수', m.calls(), '요청경로', JSON.stringify(m.urls()));
  t('5개 노선을 한 번씩 호출한다(9호선=시간표, 나머지 4개=기준선 수집)', () => { assert.strictEqual(m.calls(), 5); ['9호선','신분당선','공항철도','경의중앙선','수인분당선'].forEach(n => assert.ok(m.urls().some(u => u === 'realtimePosition/0/200/' + n), n)); });
  t('1회차(bad 1회)는 아직 표시 없음', () => assert.deepStrictEqual(out, {}));
  cur.now += 130e3; out = await run(m, cur.now);
  t('2분 뒤 2회차(bad) → 9호선 지연 의심 표시(estimated:true)', () => { assert.ok(out['9호선'], JSON.stringify(out)); assert.strictEqual(out['9호선'].estimated, true); assert.strictEqual(out['9호선'].suspect, true); assert.strictEqual(m.calls(), 10); });
  t('기준선이 쌓이기 전(여기서는 역 이름도 안 맞음)인 4개 노선에는 아무것도 표시하지 않는다', () => ['신분당선', '공항철도', '경의중앙선', '수인분당선'].forEach(n => assert.strictEqual(out[n], undefined)));
  const callsBefore = m.calls(); cur.now += 30e3; out = await run(m, cur.now);
  t('2분 안에 다시 요청해도 공공 API 는 다시 부르지 않는다', () => assert.strictEqual(m.calls(), callsBefore));
  // 해제
  const feedGood = () => ({ errorMessage: { code: 'INFO-000' }, realtimePositionList: mk(cur.now, even) });
  m.env.BUSAPI.fetch = async (req) => { m.__c = (m.__c || 0) + 1; return new Response(JSON.stringify(feedGood()), { status: 200 }); };
  cur.now += 130e3; await run(m, cur.now); cur.now += 130e3; out = await run(m, cur.now);
  t('정상 간격이 연속 2회면 "정상 운행 중으로 보여요" 로 바뀐다', () => { assert.strictEqual(out['9호선'].suspect, false); assert.strictEqual(out['9호선'].title, '정상 운행 중으로 보여요 (도착 간격 기준)'); });
  // 공식 우선
  m = mkEnv(feed([hw, hw, 1500, hw, hw])); cur.now = WD_NOON;
  out = await run(m, cur.now, { '9호선': { title: '공식', text: '공식 공지' } });
  t('공식 공지가 있는 노선은 추정을 하지 않는다(그 노선은 호출도 안 함)', () => { assert.strictEqual(out['9호선'], undefined); assert.ok(m.urls().every(u => !/9호선/.test(u))); assert.strictEqual(m.calls(), 4); });
  // 보류들
  m = mkEnv(feed([hw, hw, 1500, hw, hw]), { noBinding: true }); out = await run(m, WD_NOON);
  t('BUSAPI 바인딩이 없으면 보류(표시 없음)', () => assert.deepStrictEqual(out, {}));
  m = mkEnv(() => ({ errorMessage: { code: 'ERROR-337', message: 'limit' } })); out = await run(m, WD_NOON);
  const kvState = JSON.parse(m.kv.get('est:v1:S09'));
  t('일일 한도 오류면 보류 + 30분 쉰다(정상 표시 없음)', () => { assert.deepStrictEqual(out, {}); assert.ok(kvState.backoffUntil > WD_NOON); });
  const c0 = m.calls(); await run(m, WD_NOON + 5 * 60e3);
  t('쉬는 동안엔 호출하지 않는다', () => assert.strictEqual(m.calls(), c0));
  m = mkEnv(() => ({ errorMessage: { code: 'INFO-200' }, realtimePositionList: [] })); out = await run(m, WD_NOON);
  t('자료가 없으면 보류(표시 없음)', () => assert.deepStrictEqual(out, {}));
  m = mkEnv(feed([hw, hw, 1500, hw, hw])); out = await run(m, WD_NIGHT);
  t('심야(23:50)에는 어느 노선도 호출·표시하지 않는다', () => { assert.strictEqual(m.calls(), 0); assert.deepStrictEqual(out, {}); });

  console.log('[시간표 없는 노선 — 최근 관측 중앙값을 기준선으로]');
  t('estWindowFor: 첫·막차 자료가 없는 신분당선은 고정 시간(06:30~22:30)', () => {
    assert.strictEqual(api.estWindowFor(B, 'SBD', WD_NOON), true);
    assert.strictEqual(api.estWindowFor(B, 'SBD', at('2026-10-06T06:00:00')), false);
    assert.strictEqual(api.estWindowFor(B, 'SBD', at('2026-10-06T22:40:00')), false);
    assert.strictEqual(api.estWindowFor(B, 'SBD', WD_NIGHT), false);
  });
  t('estWindowFor: 공항철도는 첫·막차 자료로, 9호선도 기존 규칙 그대로', () => {
    assert.strictEqual(api.estWindowFor(B, 'ARX', WD_NOON), true);
    assert.strictEqual(api.estWindowFor(B, 'S09', WD_NIGHT), false);
    assert.strictEqual(api.estWindowFor(B, 'S09', WD_NOON), true);
  });
  t('estMedian', () => { assert.strictEqual(api.estMedian([5, 1, 3]), 3); assert.strictEqual(api.estMedian([1, 2, 3, 100]), 2.5); assert.strictEqual(api.estMedian([]), null); });
  t('estBaseline: 표본 20개 미만이면 null', () => { const st = { hist: Array.from({ length: 19 }, (_, i) => [i * 120e3, 360]) }; assert.strictEqual(api.estBaseline(st, 19 * 120e3), null); });
  t('estBaseline: 20개여도 30분 미만에 몰려 있으면 null', () => { const st = { hist: Array.from({ length: 25 }, (_, i) => [i * 60e3, 360]) }; assert.strictEqual(api.estBaseline(st, 25 * 60e3), null); });
  t('estBaseline: 20개 이상·30분 이상이면 중앙값(이상치에 흔들리지 않음)', () => { const st = { hist: Array.from({ length: 24 }, (_, i) => [i * 120e3, i === 5 ? 3000 : 360]) }; const b = api.estBaseline(st, 24 * 120e3); assert.ok(b); assert.strictEqual(b.sec, 360); });
  t('estBaseline: 3시간 지난 표본은 버린다', () => { const st = { hist: Array.from({ length: 24 }, (_, i) => [i * 120e3, 360]) }; assert.strictEqual(api.estBaseline(st, 24 * 120e3 + 4 * 3600e3), null); });

  const SB = 'SBD', SBchain = api.estChain(B, SB);
  const SBids = Object.keys(B.stations).filter(k => B.stations[k].l === SB).sort((a, b) => SBchain.coord[a] - SBchain.coord[b]);
  const sbAt = (sec) => { let best = SBids[0]; for (const id of SBids) if (Math.abs(SBchain.coord[id] - sec) < Math.abs(SBchain.coord[best] - sec)) best = id; return best; };
  const sbSpan = SBchain.coord[SBids[SBids.length - 1]];
  function mkSb(now, gaps, o = {}) {   // 한 방향 열차를 간격 목록대로
    const out = []; let pos = 100; let n = 0;
    const push = (p) => out.push({ statnNm: B.stations[sbAt(p)].n, trainNo: String(7000 + n++ + (o.salt || 0)), updnLine: '1', lstcarAt: '0', recptnDt: new Date(now + 9 * 3600e3 - 15e3).toISOString().slice(0, 19).replace('T', ' ') });
    push(pos); gaps.forEach(g => { pos += g; push(pos); });
    return out;
  }
  console.log('  (신분당선 노선 길이≈' + sbSpan + '초, 역 ' + SBids.length + '개)');
  const sbMake = (env0) => {
    const kv = new Map(); let calls = 0; const feed = { gaps: [360, 360, 360, 360, 360] };
    const env = { ROWS_KV: { async get(k) { return kv.has(k) ? JSON.parse(kv.get(k)) : null; }, async put(k, v) { kv.set(k, v); } }, BUSAPI: { async fetch(req) { calls++; return new Response(JSON.stringify({ errorMessage: { code: 'INFO-000' }, realtimePositionList: mkSb(feed.now, feed.gaps, { salt: feed.salt }) }), { status: 200 }); } } };
    Object.assign(env, env0 || {});
    return { env, kv, feed, calls: () => calls, st: () => JSON.parse(kv.get('est:v1:SBD')) };
  };
  const refresh = async (m, now) => { m.feed.now = now; m.feed.salt = (m.feed.salt || 0) + 1; let st = JSON.parse(m.kv.get('est:v1:SBD') || 'null') || undefined; return await api.estRefreshLine(m.env, '신분당선', 'SBD', st, now, B); };
  {
    const m = sbMake(); let now = WD_NOON; const holds = [];
    for (let i = 0; i < 25; i++) { const st = await refresh(m, now); holds.push(st.hold); now += 120e3; }
    t('표본이 쌓이는 동안은 baseline-warmup 보류이고 표시도 없다', () => { assert.strictEqual(holds[0], 'baseline-warmup'); assert.strictEqual(holds[10], 'baseline-warmup'); assert.strictEqual(api.estPublic(m.st(), now), null); });
    t('표본 20개·30분 이상이 되면 기준선으로 판정이 시작된다(정상 간격 → good 누적, 의심 없음)', () => { const st = m.st(); assert.strictEqual(holds[24], ''); assert.ok(st.good >= 1); assert.strictEqual(st.source, 'baseline'); assert.strictEqual(st.phase, 'none'); });
    t('기준선은 관측 중앙 간격(≈360초)이다', () => { const b = api.estBaseline(m.st(), now); assert.ok(b); assert.ok(Math.abs(b.sec - 360) <= 60, 'baseline=' + b.sec); });
    const histBefore = m.st().hist.length;
    m.feed.gaps = [360, 360, 1100, 360, 360];
    await refresh(m, now); now += 120e3;
    t('벌어진 첫 관측(bad 1회)은 아직 의심 아님이고 표본에도 넣지 않는다', () => { const st = m.st(); assert.strictEqual(st.phase, 'none'); assert.strictEqual(st.hist.length, histBefore); });
    await refresh(m, now); now += 120e3;
    t('연속 2회 벌어지면 지연 의심(기준선 문구)이고 표본은 계속 안 넣는다', () => { const st = m.st(); assert.strictEqual(st.phase, 'suspect'); assert.strictEqual(st.hist.length, histBefore); const p = api.estPublic(st, now); assert.strictEqual(p.suspect, true); assert.strictEqual(p.baseline, true); assert.ok(/최근 관측 평균/.test(p.text), p.text); assert.ok(/지연 의심 \(도착 간격 기준 추정\)/.test(p.title)); });
    m.feed.gaps = [360, 360, 360, 360, 360];
    await refresh(m, now); now += 120e3;
    t('정상 1회는 의심 유지', () => assert.strictEqual(m.st().phase, 'suspect'));
    await refresh(m, now); now += 120e3;
    t('정상 연속 2회면 해제 → "정상 운행 중으로 보여요"', () => { const p = api.estPublic(m.st(), now); assert.strictEqual(m.st().phase, 'cleared'); assert.strictEqual(p.suspect, false); assert.strictEqual(p.title, '정상 운행 중으로 보여요 (도착 간격 기준)'); });
    const hl0 = m.st().hist.length;
    const sameFeedRefresh = async (callAt) => { m.feed.now = now; return await api.estRefreshLine(m.env, '신분당선', 'SBD', JSON.parse(m.kv.get('est:v1:SBD')), callAt, B); };   // 서울이 같은 위치 자료(recptnDt 동일)를 다시 준 상황
    await sameFeedRefresh(now);
    const hl1 = m.st().hist.length;
    await sameFeedRefresh(now + 5e3);
    await sameFeedRefresh(now + 9e3);
    const hl2 = m.st().hist.length;
    t('같은 위치 자료(obsTs 동일)는 표본으로 한 번만 넣는다', () => { assert.strictEqual(hl1, hl0 + 1, 'hl0=' + hl0 + ' hl1=' + hl1); assert.strictEqual(hl2, hl1, 'hl1=' + hl1 + ' hl2=' + hl2); });
  }
  {
    // 표본이 30분 안에 몰리면 20개를 넘겨도 보류 유지
    const m = sbMake(); let now = WD_NOON;
    for (let i = 0; i < 25; i++) { await refresh(m, now); now += 60e3; }
    t('1분 간격 25개(24분)는 기간이 짧아 보류 유지', () => { assert.strictEqual(m.st().hold, 'baseline-warmup'); });
  }
  {
    // 하루 호출 상한
    const m = sbMake({}); m.env.EST_DAILY_CAP = '3'; let now = WD_NOON; const holds = [];
    for (let i = 0; i < 6; i++) { const st = await refresh(m, now); holds.push(st.hold); now += 120e3; }
    t('하루 상한(3)을 넘으면 보류(budget)하고 서울 API 를 더 부르지 않는다', () => { assert.strictEqual(m.calls(), 3); assert.strictEqual(holds[5], 'budget'); });
  }
  {
    // 시간표가 있는 9호선은 기준선을 쓰지 않는다
    const m = sbMake(); m.env.BUSAPI.fetch = async () => new Response(JSON.stringify({ errorMessage: { code: 'INFO-000' }, realtimePositionList: mk(WD_NOON, even) }), { status: 200 });
    const st = await api.estRefreshLine(m.env, '9호선', 'S09', undefined, WD_NOON, B);
    t('9호선(시간표 있음)은 표본을 모으지 않고 시간표 기준으로 판정', () => { assert.strictEqual(st.source, 'timetable'); assert.strictEqual((st.hist || []).length, 0); assert.strictEqual(st.hwSec, hw); });
  }

  const noKv = await api.estimateNotices({ BUSAPI: {} }, undefined, {}, WD_NOON, B);
  t('KV 바인딩이 없으면 보류', () => assert.deepStrictEqual(noKv, {}));
  console.log('\n통과', pass, '건' + (process.exitCode ? ' — 실패 있음' : ''));
})();
