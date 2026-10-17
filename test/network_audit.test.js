// 전체 노선 점검 시험 — 내장 노선 그래프(SUBWAY_BUNDLE)를 시각표(NT_TT_EMBED)·노선 순서 자료와 대조한다. 2026-10-17
//   배경: 급행 구간에 중간역이 빠진 걸 계기로 '그래프에서 통째로 빠진 역'을 전 노선에서 찾았다(4호선 초지, 경춘선 광운대 …).
//   이 시험은 같은 종류의 구멍이 새로 생기면(시각표엔 있는데 그래프엔 없는 역, 끊긴 노선, 섬처럼 떨어진 역) 실패한다.
//   ※ 한계: 급행(D1 kric_xp)에 들어 있는 '열차가 서는 역'은 여기서 볼 수 없다 — 그건 라이브에서 live_sweep.js 로 본다.
// 실행: node test/network_audit.test.js [엔진파일]
const fs = require('fs'), assert = require('assert'), path = require('path');
let src = fs.readFileSync(process.argv[2] || path.join(__dirname, '..', 'route-v2-worker.js'), 'utf8');
const ei = src.lastIndexOf('\nexport {'); assert.ok(ei > 0); src = src.slice(0, ei) + '\n';
const mod = new Function('fetch', 'caches', src + '\nreturn { SUBWAY_BUNDLE, buildSubway };')(() => { throw new Error('no fetch'); }, {});
const i0 = src.indexOf('var NT_TT_EMBED = String.raw`') + 'var NT_TT_EMBED = String.raw`'.length;
const TT = JSON.parse(src.slice(i0, src.indexOf('`;', i0))).data;
const B = mod.SUBWAY_BUNDLE, ST = B.stations, LN = B.lines;
let fail = 0; const t = (n, f) => { try { f(); console.log('  ok  ', n); } catch (e) { fail++; console.log('  FAIL', n, '\n      ', e.message.split('\n').slice(0, 6).join('\n       ')); } };
const norm = (s) => String(s).replace(/역$/, '').replace(/\(.*\)/, '').replace(/^(대구|부산|광주|대전)_/, '').replace(/[.·\s]/g, '').replace('4.19', '419').trim();

// 알려진 보류(자료가 없어 못 만든 것) — 이 목록이 줄어들면 좋은 일이다. 늘어나면 실패.
const KNOWN_MISSING = new Set(['경의중앙선:서울', '경의중앙선:신촌', '경의중앙선:운천', '경의중앙선:임진강', '대구1호선:대구한의대병원']);
const byLine = {}; for (const id in ST) (byLine[LN[ST[id].l].n] = byLine[LN[ST[id].l].n] || new Set()).add(norm(ST[id].n));
const ttBy = {}; for (const k of Object.keys(TT._REAL_TT)) { const [ln, st] = k.split('|'); (ttBy[ln] = ttBy[ln] || new Set()).add(norm(st)); }

t('시각표에 있는 역은 그래프에도 있다(알려진 보류 5개만 예외)', () => {
  const miss = []; for (const ln in ttBy) { if (!byLine[ln]) continue; for (const s of ttBy[ln]) if (!byLine[ln].has(s) && !KNOWN_MISSING.has(ln + ':' + s)) miss.push(ln + ':' + s); }
  assert.deepStrictEqual(miss, [], '그래프에서 빠진 역: ' + miss.join(', '));
});
t('보류 목록이 낡지 않았다(고쳐진 역이 목록에 남아 있지 않다)', () => {
  const stale = [...KNOWN_MISSING].filter((k) => { const [ln, s] = k.split(':'); return byLine[ln] && byLine[ln].has(s); });
  assert.deepStrictEqual(stale, [], '이미 있는 역: ' + stale.join(', '));
});
t('4호선: 안산 → 초지 → 고잔 으로 이어지고 안산↔고잔 직결은 없다', () => {
  const idOf = (ln, n) => Object.keys(ST).find((id) => LN[ST[id].l].n === ln && ST[id].n === n);
  const a = idOf('4호선', '안산'), c = idOf('4호선', '초지'), g = idOf('4호선', '고잔');
  assert.ok(a && c && g, '세 역');
  assert.ok(B.seg[a + '|' + c] > 0 && B.seg[c + '|' + a] > 0 && B.seg[c + '|' + g] > 0 && B.seg[g + '|' + c] > 0);
  assert.strictEqual(B.seg[a + '|' + g], undefined); assert.strictEqual(B.seg[g + '|' + a], undefined);
  const G = mod.buildSubway(B);   // 초지는 수인분당선·서해선 초지와 환승으로 이어진다
  const x = G.adj['S|' + c].filter((e) => e.kind === 'sub-xfer').map((e) => LN[ST[e.to.slice(2)].l].n).sort();
  assert.deepStrictEqual(x, ['서해선', '수인분당선']);
});
t('경춘선: 광운대가 청량리와 이어진다(1호선 광운대와는 환승)', () => {
  const idOf = (ln, n) => Object.keys(ST).find((id) => LN[ST[id].l].n === ln && ST[id].n === n);
  const k = idOf('경춘선', '광운대'), cl = idOf('경춘선', '청량리');
  assert.ok(k && cl); assert.strictEqual(B.seg[k + '|' + cl], 720);
  const G = mod.buildSubway(B);
  assert.ok(G.adj['S|' + k].some((e) => e.kind === 'sub-xfer' && LN[ST[e.to.slice(2)].l].n === '1호선'));
});
t('노선마다 하나로 이어져 있다(GTX-A 는 개통 구간이 둘이라 예외, 1호선의 인천1호선 중복 역 2개는 보류)', () => {
  const adj = {}; for (const k in B.seg) { const [a, b] = k.split('|'); if (ST[a] && ST[b] && ST[a].l === ST[b].l) (adj[a] = adj[a] || {})[b] = 1; }
  const bad = [];
  for (const L in LN) {
    const ids = Object.keys(ST).filter((id) => ST[id].l === L), seen = {}; let comps = 0, small = [];
    for (const id of ids) { if (seen[id]) continue; comps++; const c = [], q = [id]; seen[id] = 1; while (q.length) { const u = q.pop(); c.push(u); for (const v in (adj[u] || {})) if (!seen[v]) { seen[v] = 1; q.push(v); } } small.push(c); }
    if (comps > 1) { const ok = LN[L].n === 'GTX-A' || (LN[L].n === '1호선' && comps === 2 && small.some((c) => c.length === 2 && c.every((i) => /경인교대입구|작전/.test(ST[i].n)))); if (!ok) bad.push(LN[L].n + ' 조각 ' + small.map((c) => c.length).join('/')); }
  }
  assert.deepStrictEqual(bad, []);
});
t('구간(seg)의 양끝은 모두 있는 역이고 같은 노선 안이면 양방향이다', () => {
  const bad = []; for (const k in B.seg) { const [a, b] = k.split('|'); if (!ST[a] || !ST[b]) { bad.push('없는 역 ' + k); continue; } if (ST[a].l === ST[b].l && B.seg[b + '|' + a] === undefined) bad.push('한쪽만 ' + ST[a].n + '→' + ST[b].n); }
  assert.deepStrictEqual(bad.slice(0, 10), []);
});
console.log(fail ? ('FAIL ' + fail) : 'ALL OK'); process.exit(fail ? 1 : 0);
