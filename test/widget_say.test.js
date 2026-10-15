// /widget-say (위젯 응원 멘트) 시험 — 모의 fetch.  실행: node test/widget_say.test.js
const fs = require('fs'), assert = require('assert');
let src = fs.readFileSync(require('path').join(__dirname, '..', 'route-v2-worker.js'), 'utf8');
const ei = src.lastIndexOf('\nexport {'); src = src.slice(0, ei) + '\n';
let wxMode = 'ok', wxBody = { ok: true, temp: 15, rain: 10, txt: '맑음' }, ntceItems = [];
const fakeFetch = async (u) => {
  if (String(u).includes('/weather')) { if (wxMode === 'fail') throw new Error('x'); return new Response(JSON.stringify(wxBody), { status: 200 }); }
  if (String(u).includes('B553766/ntce')) return new Response(JSON.stringify({ response: { header: { resultCode: '00' }, body: { items: { item: ntceItems } } } }), { status: 200 });
  throw new Error('unexpected fetch ' + u);
};
const caches = { default: { async match() { return undefined; }, async put() {} } };
const W = new Function('caches', 'fetch', src + '\nreturn { w: route_v2_worker_default, compose: wsayCompose, V: ENGINE_VERSION };');
const { w, compose, V } = W(caches, fakeFetch);
const env = { DATA_GO_KR_KEY: 'x' };
const ms = (s) => Date.parse(s + '+09:00');
const get = async (q) => JSON.parse(await (await w.fetch(new Request('https://x.test/widget-say' + q), env, { waitUntil() {} })).text());
let pass = 0, fail = 0;
const t = async (n, f) => { try { await f(); pass++; console.log('  ok  ', n); } catch (e) { fail++; console.log('  FAIL', n, '\n      ', String(e.message || e).slice(0, 400)); } };
(async () => {
  await t('버전 s23', () => assert.strictEqual(V, 'route-v2-2026-10-15s23'));
  await t('기본: 출근/퇴근 버튼 글자·두 줄 이하·검증 시간', async () => {
    const a = await get('?kind=morn&baseMs=' + ms('2026-10-14T08:00:00')), b = await get('?kind=eve&baseMs=' + ms('2026-10-14T18:30:00'));
    assert.strictEqual(a.btn, '출근하기'); assert.strictEqual(b.btn, '퇴근하기');
    assert(a.say.length >= 1 && a.say.length <= 2 && b.say.length <= 2 && a.say.every(x => x.length >= 4 && x.length <= 36));
    assert.strictEqual(a.validMin, 90); assert.strictEqual(a.facts.dow, 3);       // 2026-10-14 수요일
    assert(!a.say.join('').includes('undefined'));
  });
  await t('같은 날 같은 종류는 같은 말(여러 번 물어도 바뀌지 않음)', async () => {
    const q = '?kind=morn&baseMs=' + ms('2026-10-14T08:00:00');
    assert.deepStrictEqual((await get(q)).say, (await get(q)).say);
  });
  await t('요일마다 요일 멘트가 있다(월요일 아침 · 금요일 퇴근)', async () => {
    const mon = compose('morn', ms('2026-10-12T08:00:00'), null, []), fri = compose('eve', ms('2026-10-16T18:30:00'), null, []);
    assert(/월요일|한 주|새로운 한 주/.test(mon.say[0]), mon.say[0]); assert(/금요일|주말|한 주 마무리/.test(fri.say[0]), fri.say[0]);
  });
  await t('비가 많이 오면 위로·우산 안내(comfort) — 날씨는 좌표를 줄 때만', async () => {
    wxBody = { ok: true, temp: 12, rain: 80, txt: '비' };
    const r = await get('?kind=morn&lat=37.5&lng=127&baseMs=' + ms('2026-10-14T08:00:00'));
    assert.strictEqual(r.mood, 'comfort'); assert(/우산/.test(r.say[0]), r.say[0]); assert.strictEqual(r.facts.rain, 80);
    const n = await get('?kind=morn&baseMs=' + ms('2026-10-14T08:00:00')); assert.strictEqual(n.facts.rain, null);
  });
  await t('추위·더위·쌀쌀', async () => {
    assert(/추워/.test(compose('morn', ms('2026-10-14T08:00:00'), { temp: 0, rain: 0 }, []).say[0]));
    assert(/더/.test(compose('eve', ms('2026-10-14T18:30:00'), { temp: 33, rain: 0 }, []).say[0]));
    const c = compose('morn', ms('2026-10-14T08:00:00'), { temp: 6, rain: 0 }, []); assert(/겉옷/.test(c.say[1]), c.say[1]);
  });
  await t('날씨 서버가 죽어도 말은 나온다(날씨만 건너뜀)', async () => {
    wxMode = 'fail'; const r = await get('?kind=eve&lat=37.5&lng=127&baseMs=' + ms('2026-10-14T18:30:00')); wxMode = 'ok';
    assert(r.ok && r.say.length >= 1 && r.facts.temp === null);
  });
  await t('공휴일 근무 · 늦은 퇴근', async () => {
    const h = compose('morn', ms('2026-10-09T08:00:00'), null, []);               // 한글날
    assert(/한글날/.test(h.say[0]) && h.mood === 'comfort', h.say[0]);
    const l = compose('eve', ms('2026-10-14T22:10:00'), null, []); assert(/늦게/.test(l.say[0]) && l.mood === 'comfort');
  });
  await t('노선 공지가 있으면 그 노선을 말하고 warn', async () => {
    ntceItems = [{ lineNmLst: '1호선', noftTtl: '1호선 지연', noftCn: '신호장애로 지연', noftOcrnDt: new Date(Date.now() + 9 * 3600e3 - 60e3).toISOString().slice(0, 19), nonstopYn: 'N' }];
    const r = await get('?kind=morn&lines=' + encodeURIComponent('1호선,2호선'));
    assert.strictEqual(r.mood, 'warn'); assert(/1호선/.test(r.say[0]), JSON.stringify(r)); ntceItems = [];
    const ok = await get('?kind=morn&lines=' + encodeURIComponent('2호선')); assert.notStrictEqual(ok.mood, 'warn');
  });
  await t('잘못된 좌표(해외)는 날씨를 묻지 않는다', async () => {
    wxMode = 'fail'; const r = await get('?kind=morn&lat=10&lng=10'); wxMode = 'ok'; assert(r.ok && r.facts.temp === null);
  });
  console.log(pass + ' pass, ' + fail + ' fail'); process.exit(fail ? 1 : 0);
})();
