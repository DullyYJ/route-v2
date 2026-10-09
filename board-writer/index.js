var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// worker.js
// 2026-10-01: 예전엔 관리 토큰이 소스에 있었고, 같은 값이 공개 앱(www/index.html)의 /react 호출에도
//   들어 있어 누구나 /gen·/gentalk·/news(Gemini 호출·글 생성)를 부를 수 있었다.
//   → 관리 경로는 시크릿 ADMIN_TOKEN 으로만 열리고(없으면 닫힘), 앱이 쓰는 /react 는 토큰 대신
//     IP·전체 시간당 호출 제한으로 막는다.
function adminOk(url, env) {
  const want = env && env.ADMIN_TOKEN;
  return !!want && url.searchParams.get("token") === want;
}
var MSG_PER_IP_HR = 40;      // 한 IP 가 한 시간에 대화로 남길 수 있는 사용자 메시지 수
async function msgAllowed(req, env) {
  try {
    const ip = req.headers.get("CF-Connecting-IP") || "?";
    const hr = Math.floor(Date.now() / 36e5);
    await env.DB.prepare("CREATE TABLE IF NOT EXISTS react_rl (k TEXT, hr INTEGER, n INTEGER, PRIMARY KEY (k, hr))").run();
    await env.DB.prepare("INSERT INTO react_rl (k,hr,n) VALUES (?1,?2,1) ON CONFLICT(k,hr) DO UPDATE SET n = n + 1").bind("msg:" + ip, hr).run();
    const r = await env.DB.prepare("SELECT n FROM react_rl WHERE k=?1 AND hr=?2").bind("msg:" + ip, hr).first();
    return ((r && r.n) || 1) <= MSG_PER_IP_HR;
  } catch (e) { return false; }
}
var REACT_PER_IP_HR = 12;    // 한 IP 가 한 시간에 보낼 수 있는 /react 수
var REACT_ALL_HR = 400;      // 서버 전체 한 시간 상한(Gemini 비용 보호)
async function reactAllowed(req, env) {
  try {
    const ip = req.headers.get("CF-Connecting-IP") || "?";
    const hr = Math.floor(Date.now() / 36e5);
    await env.DB.prepare("CREATE TABLE IF NOT EXISTS react_rl (k TEXT, hr INTEGER, n INTEGER, PRIMARY KEY (k, hr))").run();
    const bump = async (k) => {
      await env.DB.prepare("INSERT INTO react_rl (k,hr,n) VALUES (?1,?2,1) ON CONFLICT(k,hr) DO UPDATE SET n = n + 1").bind(k, hr).run();
      const r = await env.DB.prepare("SELECT n FROM react_rl WHERE k=?1 AND hr=?2").bind(k, hr).first();
      return (r && r.n) || 1;
    };
    if ((await bump("ip:" + ip)) > REACT_PER_IP_HR) return false;
    if ((await bump("all")) > REACT_ALL_HR) return false;
    if (hr % 6 === 0) await env.DB.prepare("DELETE FROM react_rl WHERE hr < ?1").bind(hr - 48).run();
    return true;
  } catch (e) { return false; }
}
// ★ 2026-10-03 (개선안 4·5): 노선별 출퇴근 방 + 지연·혼잡 제보.
//   ★ 2026-10-04: 방의 일상 대화(chat)는 AI 가 채우기도 한다(generateLineTalks, ipk='ai'). 지연·혼잡 제보(delay/crowd)는 실제 사용자 것만 센다.
//   · line_msgs: 노선(또는 버스번호)별 한 줄 대화(chat)와 제보(delay=지연, crowd=혼잡). IP 는 해시(ipk)만 저장한다.
//   · 같은 사람이 같은 노선·역에 같은 제보를 20분 안에 또 보내도 한 번으로 센다(경보 부풀리기 방지).
var LR_PER_IP_HR = 30;
// ★ 2026-10-03: 신고가 서로 다른 3명 이상 모인 글은 보이지 않게 한다(자동 숨김). 신고한 기기 식별 코드도 14일 뒤 같이 지운다.
var LR_HIDE_N = 3;
// ★ 2026-10-10: AI 가 만든 "치맥… 🍗… 🤤" 식 말줄임표 조각 글은 화면에서 가린다(행은 지우지 않음 — 2일 뒤 자동 삭제). 실제 이용자 글(ipk≠'ai')은 대상이 아니다.
var LR_HIDDEN_SQL = " AND id NOT IN (SELECT msg_id FROM line_reports GROUP BY msg_id HAVING COUNT(*) >= " + LR_HIDE_N + ") AND NOT (ipk = 'ai' AND (LENGTH(text) - LENGTH(REPLACE(text, '…', ''))) >= 2)";
var LR_KINDS_OK = ["chat"];   // ★ 2026-10-05 (YJ): 지연·붐벼요 제보 버튼 삭제(악용 우려) — 서버도 일반 대화만 받는다
// ★ 2026-10-03 (익명 정확도 기록): 앱이 예상한 '탑승~하차' 분과 실제로 걸린 분을 목적지 도착 때 한 번 보낸다.
//   저장하는 것: 날짜(일 단위), 예상분, 실제분, 환승 횟수, 노선명, 시간대(시), 평일 여부, 수단 구분, 앱 버전.
//   저장하지 않는 것: 역 이름·좌표·사용자 식별값·IP. IP 는 시간당 횟수 제한에만 쓰고 제한표는 24시간 뒤 지운다. 기록은 1년 뒤 삭제.
var RIDE_PER_IP_HR = 12;
var RIDE_KEEP_DAYS = 365;
var _rideReady = false;
async function ensureRideLog(env) {
  if (_rideReady) return;
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS ride_log (id INTEGER PRIMARY KEY AUTOINCREMENT, day INTEGER NOT NULL, pred REAL NOT NULL, act REAL NOT NULL, xf INTEGER NOT NULL, lines TEXT, hr INTEGER, wk INTEGER, mode TEXT, av TEXT)").run();
  _rideReady = true;
}
async function rideAllowed(req, env) {
  try {
    const ip = req.headers.get("CF-Connecting-IP") || "?";
    const hr = Math.floor(Date.now() / 36e5);
    await env.DB.prepare("CREATE TABLE IF NOT EXISTS react_rl (k TEXT, hr INTEGER, n INTEGER, PRIMARY KEY (k, hr))").run();
    await env.DB.prepare("INSERT INTO react_rl (k,hr,n) VALUES (?1,?2,1) ON CONFLICT(k,hr) DO UPDATE SET n = n + 1").bind("rd:" + ip, hr).run();
    const r = await env.DB.prepare("SELECT n FROM react_rl WHERE k=?1 AND hr=?2").bind("rd:" + ip, hr).first();
    return ((r && r.n) || 1) <= RIDE_PER_IP_HR;
  } catch (e) { return false; }
}
function rideClean(b) {
  const num = (v) => (typeof v === "number" && isFinite(v)) ? v : NaN;
  const pred = num(b.pred), act = num(b.act), xf = num(b.xf), hr = num(b.hr), wk = num(b.wk);
  if (!(pred >= 3 && pred <= 300 && act >= 3 && act <= 300)) return null;
  const ratio = act / pred;
  if (ratio < 0.3 || ratio > 3) return null;
  if (!(xf >= 0 && xf <= 6) || !(hr >= 0 && hr <= 23) || !(wk === 0 || wk === 1)) return null;
  const lines = String(b.lines == null ? "" : b.lines);
  if (lines.length > 40 || !/^[0-9A-Za-z가-힣,·\s\-]*$/.test(lines)) return null;
  const mode = ["sub", "bus", "mix"].indexOf(b.mode) >= 0 ? b.mode : "sub";
  const av = String(b.av || "").slice(0, 16).replace(/[^0-9A-Za-z._\-]/g, "");
  return { pred: Math.round(pred * 10) / 10, act: Math.round(act * 10) / 10, xf: Math.round(xf), hr: Math.round(hr), wk, lines, mode, av };
}
async function rideHandle(req, env, cors) {
  let body = {};
  try { body = await req.json(); } catch (e) {}
  const c = rideClean(body || {});
  if (!c) return new Response(JSON.stringify({ ok: false, error: "invalid" }), { status: 400, headers: cors });
  try {
    await ensureRideLog(env);
    if (!await rideAllowed(req, env)) return new Response(JSON.stringify({ ok: false, error: "rate limited" }), { status: 429, headers: cors });
    const day = Math.floor(Date.now() / 864e5);
    await env.DB.prepare("INSERT INTO ride_log (day, pred, act, xf, lines, hr, wk, mode, av) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)").bind(day, c.pred, c.act, c.xf, c.lines, c.hr, c.wk, c.mode, c.av).run();
    if (Math.random() < 0.02) {   // 가끔 오래된 기록·제한표 정리(1년 / 24시간)
      try {
        await env.DB.prepare("DELETE FROM ride_log WHERE day < ?1").bind(day - RIDE_KEEP_DAYS).run();
        await env.DB.prepare("DELETE FROM react_rl WHERE hr < ?1").bind(Math.floor(Date.now() / 36e5) - 24).run();
      } catch (e) {}
    }
    return new Response(JSON.stringify({ ok: true }), { headers: cors });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 500, headers: cors });
  }
}
var _lrReady = false;
// ★ 2026-10-10 (YJ: 게시판·실시간소통 로딩이 길다): 표는 이미 있다. 예전엔 격리(isolate)가 새로 뜰 때마다
//   표 만들기 3번을 차례로 기다린 뒤에야 읽기를 시작했다(D1 왕복 3번 = 첫 요청이 그만큼 늦음).
//   이제 한 번에 묶어(batch) 응답과 별개로 보내고, 읽기는 바로 시작한다.
var _CTX = null;
var _cmtIdxDone = false;
var _MEM = Object.create(null);
function memGet(k, ttl) { var h = _MEM[k]; return h && Date.now() - h.at < ttl ? h.v : null; }
function memPut(k, v) { _MEM[k] = { at: Date.now(), v: v }; }
var _lrRetry = false;
async function ensureLineRoom(env, wait) {
  if (_lrReady) return;
  _lrReady = true;
  const stmts = [
    env.DB.prepare("CREATE TABLE IF NOT EXISTS line_msgs (id INTEGER PRIMARY KEY AUTOINCREMENT, line TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'chat', nick TEXT, text TEXT, stn TEXT, ipk TEXT, ts INTEGER NOT NULL)"),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_line_msgs ON line_msgs (line, ts)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS line_reports (msg_id INTEGER NOT NULL, ipk TEXT NOT NULL, ts INTEGER NOT NULL, PRIMARY KEY (msg_id, ipk))")
  ];
  const p = (typeof env.DB.batch === "function"
    ? env.DB.batch(stmts)
    : stmts.reduce(function (c, st) { return c.then(function () { return st.run(); }); }, Promise.resolve())
  ).catch(function () { _lrReady = false; });
  try { if (_CTX && !wait) { _CTX.waitUntil(p); return; } } catch (e) {}
  await p;
}
function lrLineOk(line) {
  return typeof line === "string" && line.length >= 1 && line.length <= 24 && /^[0-9A-Za-z가-힣\s\-·()_]+$/.test(line);
}
async function lrIpHash(req) {
  try {
    const ip = req.headers.get("CF-Connecting-IP") || "?";
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("lr|" + ip));
    return Array.from(new Uint8Array(buf)).slice(0, 6).map((b) => b.toString(16).padStart(2, "0")).join("");
  } catch (e) { return "?"; }
}
async function lrAllowed(req, env) {
  try {
    const ip = req.headers.get("CF-Connecting-IP") || "?";
    const hr = Math.floor(Date.now() / 36e5);
    await env.DB.prepare("CREATE TABLE IF NOT EXISTS react_rl (k TEXT, hr INTEGER, n INTEGER, PRIMARY KEY (k, hr))").run();
    await env.DB.prepare("INSERT INTO react_rl (k,hr,n) VALUES (?1,?2,1) ON CONFLICT(k,hr) DO UPDATE SET n = n + 1").bind("lr:" + ip, hr).run();
    const r = await env.DB.prepare("SELECT n FROM react_rl WHERE k=?1 AND hr=?2").bind("lr:" + ip, hr).first();
    return ((r && r.n) || 1) <= LR_PER_IP_HR;
  } catch (e) { return false; }
}
async function lrAlerts(env, lines) {
  const since = Date.now() - 30 * 60 * 1000;
  const out = {};
  for (const ln of lines) out[ln] = { reporters: 0, stations: [] };
  if (!lines.length) return out;
  const ph = lines.map(() => "?").join(",");
  const aP = env.DB.prepare("SELECT line, COUNT(DISTINCT ipk) AS n FROM line_msgs WHERE kind='delay' AND ts > ? AND ts <= ? AND line IN (" + ph + ")" + LR_HIDDEN_SQL + " GROUP BY line").bind(since, Date.now(), ...lines).all();
  const bP = env.DB.prepare("SELECT line, stn, COUNT(DISTINCT ipk) AS n, MAX(ts) AS last FROM line_msgs WHERE kind='delay' AND stn IS NOT NULL AND stn <> '' AND ts > ? AND ts <= ? AND line IN (" + ph + ")" + LR_HIDDEN_SQL + " GROUP BY line, stn ORDER BY n DESC, last DESC").bind(since, Date.now(), ...lines).all();
  const [a, b] = await Promise.all([aP, bP]);
  (a.results || []).forEach((r) => { if (out[r.line]) out[r.line].reporters = r.n; });
  (b.results || []).forEach((r) => { if (out[r.line] && out[r.line].stations.length < 5) out[r.line].stations.push({ stn: r.stn, n: r.n, last: r.last }); });
  return out;
}
var MAX_POSTS = 500;
var NICKS = [
  "회식거절마스터",
  "지하철덕후",
  "지하철폐인",
  "대학원노예",
  "출근지옥러",
  "자취N년차",
  "삼성역출퇴근",
  "판교셔틀버스",
  "여의도금융맨",
  "구로공단아재",
  "성수동힙스터",
  "칼퇴요정",
  "월급루팡꿈나무",
  "환승의달인",
  "급행만타는사람",
  "막차의전설",
  "첫차타는사람",
  "9호선생존자",
  "점심메뉴고민중",
  "퇴사각재는중",
  "신입사원1일차",
  "부장님피하기달인",
  "재택희망자",
  "야근수당러버",
  "주말출근싫어",
  "불금기다림",
  "카페인수혈중",
  "다이어트내일부터",
  "운동간다말만",
  "집이최고야"
];
var LINES = [
  { name: "1호선", stns: ["서울역", "시청", "종각", "구로", "부평", "인천"] },
  { name: "2호선", stns: ["강남", "홍대입구", "신촌", "잠실", "성수", "사당", "건대입구"] },
  { name: "3호선", stns: ["교대", "고속터미널", "압구정", "연신내", "양재"] },
  { name: "4호선", stns: ["사당", "명동", "동대문", "혜화", "서울역"] },
  { name: "5호선", stns: ["여의도", "광화문", "천호", "왕십리", "김포공항"] },
  { name: "7호선", stns: ["가산디지털단지", "건대입구", "상봉", "온수", "논현"] },
  { name: "9호선", stns: ["김포공항", "여의도", "노량진", "신논현", "가양"] },
  { name: "신분당선", stns: ["강남", "판교", "정자", "광교", "양재"] },
  { name: "공항철도", stns: ["서울역", "홍대입구", "김포공항", "검암", "계양"] },
  { name: "수인분당선", stns: ["왕십리", "서울숲", "정자", "인하대", "수원"] },
  { name: "경의중앙선", stns: ["홍대입구", "공덕", "왕십리", "용산", "일산"] },
  { name: "인천1호선", stns: ["부평", "인천시청", "계양", "송도"] },
  { name: "인천2호선", stns: ["검단오류", "주안", "석남", "인천시청"] },
  { name: "김포골드라인", stns: ["김포공항", "걸포북변", "구래", "풍무"] }
];
var CHAT_POSTS = [
  { t: "출근길에 이어폰 안 챙긴 날의 공허함", b: "오늘따라 지하철이 왜 이렇게 긴지\n귀가 심심하니까 남의 통화 소리만 들림\n다들 이어폰은 목숨처럼 챙기자" },
  { t: "회사 탕비실 커피 다 떨어졌을 때 절망감 알지", b: "월요일 아침에 이거 없으면 진짜 힘 안 남\n총무님 언제 채워주시나요 간절합니다" },
  { t: "점심 뭐 먹을지 정하는 게 회사 최대 난제", b: "매일 이 고민 하는데 왜 안 익숙해지지\n오늘도 결국 김치찌개 각인가" },
  { t: "지하철에서 조는데 딱 내릴 역에서 깨는 초능력", b: "알람도 안 맞췄는데 신기하게 눈 떠짐\n근데 가끔 한 정거장 지나쳐서 슬픔" },
  { t: "퇴근하고 집 오면 아무것도 하기 싫음", b: "분명 하고 싶은 거 많았는데\n소파에 앉는 순간 다 리셋됨\n나만 이런 거 아니지?" },
  { t: "다이어트는 항상 내일부터라는 마법의 단어", b: "오늘 저녁도 치킨 시켜버림ㅋㅋ\n내일의 나야 미안해" },
  { t: "주말에 늦잠 자면 오히려 더 피곤한 이유가 뭘까", b: "분명 푹 잤는데 몸이 더 무거움\n적당히 자는 게 답인가봄" },
  { t: "편의점 신상 나오면 일단 사보는 편", b: "이번에 나온 그거 먹어본 사람?\n맛있으면 알려줘 재구매 각 볼게" },
  { t: "회의 중에 딴생각하다 갑자기 이름 불릴 때", b: '심장 철렁하는 거 나만 그런가\n"어떻게 생각하세요?" → 머릿속 백지' },
  { t: "금요일 오후의 그 설레는 기분 뭔지 알지", b: "일은 손에 안 잡히고 마음은 이미 주말\n이 맛에 일주일 버팀" },
  { t: "배달 음식 시키고 기다리는 시간이 제일 행복함", b: "라이더님 지금 어디쯤 오시나 계속 확인\n도착 알림 뜰 때 세상 다 가진 기분" },
  { t: "아침에 5분만 더 자려다 지각할 뻔한 썰", b: "그 5분이 사람 잡는다 진짜\n결국 택시 타고 출근비 만원 순삭" },
  { t: "냉장고에 뭐 있는지 까먹고 또 사오는 사람?", b: "집에 오니 똑같은 게 두 개\n계란 이러다 계란탑 쌓겠음" },
  { t: "노래 하나 꽂히면 일주일 내내 그것만 듣는 편", b: "지금 그 노래 무한반복 중\n질릴 때까지 듣고 갈아탐" },
  { t: "퇴근길에 붕어빵 사면 그날 하루 성공", b: "요즘 세 개 이천원이던데\n비싸도 겨울엔 못 참지" },
  { t: "주말에 집에만 있었는데 왜 이렇게 피곤하지", b: "나가지도 않았는데 방전됨\n집콕도 체력 소모라는 거 인정" },
  { t: "회사 근처 맛집 하나 발견하면 그렇게 뿌듯함", b: "점심 메뉴 하나 늘었다는 안정감\n근데 남한테 알려주긴 싫은 이 마음ㅋㅋ" },
  { t: "택배 오는 날은 아침부터 기분이 좋음", b: "뭐 시켰는지 기억도 안 나는데 설렘\n문 앞에 박스 있으면 그날은 이긴 날" },
  { t: "엘리베이터에서 아는 사람 만나면 어색한 정적", b: "인사는 했는데 그 다음이 문제\n층수만 뚫어져라 쳐다보는 중" },
  { t: "믹스커피가 제일 맛있다는 거 인정하는 사람?", b: "비싼 원두커피보다 이게 더 좋을 때가 있음\n특히 나른한 오후엔 무조건 믹스지" },
  { t: "자기 전에 폰 보다가 시간 순삭되는 마법", b: "10분만 봐야지 했는데 두 시간\n내일 또 피곤하겠네 알면서도 못 끊음" },
  { t: "비 오는 날 부침개 생각나는 건 국룰인가", b: "창밖에 비 오니까 갑자기 당김\n오늘 저녁은 이걸로 정했다" },
  { t: "출근 첫 커피 한 모금의 그 각성 효과", b: "이거 없으면 오전 업무 불가능\n카페인은 직장인의 연료가 맞다" },
  { t: "주말에 뭐 했냐 물으면 딱히 할 말 없는 사람", b: "분명 바빴는데 뭐 했는지 설명이 안 됨\n그냥 쉬었어요로 퉁치는 중" },
  { t: "퇴근 후 운동 가려다 결국 집으로 직행", b: "헬스장 등록만 하고 유령회원 됨\n의지가 약한 게 아니라 몸이 무거운 거야" }
];
var POOLS = {
  // 새벽 0~5시: 드묾, 감성/야근/첫차
  dawn: [
    { t: "새벽 {stn}역 근처인데 세상이 너무 조용하다", b: "야근 끝나고 걸어가는 중\n낮에 그렇게 붐비던 거리가 텅 비어있으니까 기분이 이상하네\n다들 어디선가 자고 있겠지", cat: "일상" },
    { t: "첫차 기다리는 사람 있음?", b: "{line} 첫차 기다리는 중인데 플랫폼에 나 포함 세 명 있음\n다들 무슨 사연으로 이 시간에 나와있는 걸까\n괜히 동지애 느껴진다", cat: "일상" },
    { t: "야근 끝. 택시비가 아까워서 첫차 기다림", b: "새벽까지 일한 것도 서러운데 택시비 3만원은 도저히 못 쓰겠어서\n{stn}역 앞 편의점에서 컵라면 먹으면서 버티는 중\n이게 사는 건가 싶다가도 라면은 맛있네", cat: "일상" },
    { t: "새벽 지하철은 왜 이렇게 감성적이냐", b: "창밖에 어둠뿐인데 괜히 노래 들으면서 센치해짐\n낮에 못 하던 생각들이 다 몰려온다\n내일의 나야 미안해 오늘도 늦게 잔다", cat: "일상" },
    { t: "이 시간에 깨어있는 사람 나뿐인가", b: "잠이 안 와서 그냥 폰만 보는 중\n첫차 뜨면 그날 어디라도 갔다올까 싶기도 하고\n다들 잘 자요", cat: "일상" },
    { t: "새벽 근무 끝나고 집 가는 길", b: "남들 출근할 때 퇴근하는 삶 벌써 몇 년째인지\n그래도 텅 빈 {line} 앉아서 가는 맛에 버틴다\n교대 근무자들 다들 힘내요", cat: "일상" }
  ],
  // 평일 출근길 6~9시
  mornRushWd: [
    { t: "{line} 오늘따라 왜 이렇게 사람 많냐", b: "평소보다 한 대 늦게 탔더니 지옥이다\n{stn}에서 겨우 탔는데 문에 낀 줄 알았음\n내일부터 10분 일찍 나온다 진짜", cat: "일상" },
    { t: "{stn}역에서 뛰는 사람들 보면 나도 모르게 같이 뜀", b: "분명 다음 열차 금방 오는데\n앞사람이 뛰니까 나도 반사적으로 뛰고 있음 ㅋㅋ\n출근길 단체 달리기 무엇", cat: "일상" },
    { t: "출근길 지하철에서 자리 나면 그날 운세 좋은 거임", b: "{stn}에서 앉았다\n오늘 뭔가 잘 풀릴 것 같은 예감\n다들 오늘 하루 화이팅", cat: "일상" },
    { t: "환승 구간에서 길 막는 사람들 진짜 뭐냐", b: "{stn} 환승통로 한가운데서 폰 보면서 천천히 걷는 사람들\n뒤에 수백 명이 밀려오는 게 안 보이나\n제발 한쪽으로 비켜서 봐요", cat: "일상" },
    { t: "급행 탈까 완행 탈까 매일 고민함", b: "급행은 빠른데 사람이 미어터지고\n완행은 앉아갈 수 있는데 15분 더 걸리고\n다들 뭐 타고 다님?", cat: "질문" },
    { t: "오늘 {line} 지연 있었음?", b: "{stn}에서 5분 넘게 안 와서 지각 직전까지 감\n앱에는 정상운행이라는데 체감은 아니었음\n나만 그랬나", cat: "질문" },
    { t: "출근길에 커피 못 사면 하루가 안 시작됨", b: "{stn}역 앞 카페 줄이 너무 길어서 그냥 왔는데\n지금 머리가 안 돌아감\n회사 커피머신은 왜 맛이 없을까", cat: "일상" },
    { t: "만원 지하철에서 백팩 앞으로 메는 거 국룰 아니냐", b: "뒤에 백팩 그대로 메고 타는 사람 때문에 계속 찍힘\n본인은 모르겠지만 뒤는 지옥임\n다들 앞으로 멥시다", cat: "일상" }
  ],
  // 주말 아침
  mornWe: [
    { t: "주말 아침 지하철 이 여유 뭐냐", b: "평일엔 전쟁터인 {line}이 텅텅 비었음\n앉아서 창밖 보면서 가니까 여행 가는 기분\n주말 아침 일찍 나온 보람 있다", cat: "일상" },
    { t: "토요일 아침부터 어디 가는 사람들 많네", b: "{stn}역인데 등산복 부대가 잔뜩이다\n다들 부지런하시네 나는 놀러 가는 건데\n주말은 역시 아침부터 움직여야 김", cat: "일상" },
    { t: "주말 출근하는 사람 여기 붙어라", b: "{line} 타고 회사 가는 중\n놀러 가는 사람들 사이에서 나만 노트북 가방\n수당이라도 두둑하면 좋겠다", cat: "일상" },
    { t: "아침 일찍 {stn} 왔는데 벌써 사람 많음", b: "맛집 오픈런 하려고 왔는데 이미 줄 서 있음 ㄷㄷ\n다들 정보력이 대단하다\n주말엔 부지런한 자가 다 먹는구나", cat: "일상" }
  ],
  // 평일 오전 9~11시
  forenoonWd: [
    { t: "오전 회의 3개 연속인 사람 있음?", b: "출근하자마자 회의실 순회 중\n내 일은 대체 언제 하라는 건지\n회의를 위한 회의는 이제 그만", cat: "일상" },
    { t: "출근하고 두 시간 지났는데 벌써 퇴근 마려움", b: "모니터 보는데 눈에 하나도 안 들어옴\n점심시간만 기다리는 중\n다들 오전 어떻게 버팀?", cat: "일상" },
    { t: "오전에 타는 지하철은 평화롭네", b: "늦은 출근이라 {line} 탔는데 자리 널널\n러시아워 피하니까 삶의 질이 다르다\n시차출퇴근제 전국 확대 기원", cat: "일상" },
    { t: "재택 하다가 오랜만에 사무실 나왔더니 적응 안 됨", b: "지하철 타는 것부터가 노동이었다는 걸 잊고 있었음\n{stn}역 인파 뚫고 오니까 이미 지침\n재택이 그립다", cat: "일상" }
  ],
  // 주말 오전
  forenoonWe: [
    { t: "주말 오전 카페에서 여유 부리는 중", b: "{stn}역 근처 카페 창가 자리 잡음\n브런치에 커피에 이게 사는 거지\n평일의 나에게 주는 보상", cat: "일상" },
    { t: "오늘 나들이 가기 좋은 날씨네", b: "{line} 타고 교외로 나가는 중\n주말엔 역시 어디든 나가야 함\n집에만 있으면 주말이 순삭됨", cat: "일상" },
    { t: "주말 늦잠 자다가 하루 다 감", b: "일어나니까 11시\n뭐라도 해야 할 것 같아서 일단 나옴\n{stn} 근처 갈만한 데 추천 좀", cat: "질문" }
  ],
  // 점심 11~14시
  lunch: [
    { t: "점심 메뉴 정하는 게 제일 어려운 일임", b: "회사 근처 식당 다 질렸음\n오늘도 결국 국밥 아니면 김치찌개겠지\n다들 오늘 뭐 먹음?", cat: "질문" },
    { t: "{stn}역 근처 직장인 점심 웨이팅 실화냐", b: "12시 땡 치자마자 나왔는데 이미 줄이 건물 밖까지\n점심시간 1시간으로는 부족하다\n1시간 반으로 늘려주면 안 되나", cat: "일상" },
    { t: "점심 혼밥 하는 사람 많아진 듯", b: "오늘 혼자 먹으러 갔는데 1인석이 꽉 참\n혼밥이 편할 때가 있음 눈치 안 보고\n다들 혼밥 어디까지 가능함?", cat: "일상" },
    { t: "점심 먹고 산책하는 게 하루 유일한 낙", b: "{stn} 근처 한 바퀴 돌고 커피 사서 들어가는 코스\n이 20분이 오후를 버티게 해줌\n식후 산책 하는 사람 개추", cat: "일상" },
    { t: "구내식당 vs 나가서 사먹기", b: "구내식당은 싸고 빠른데 맛이 아쉽고\n나가면 맛있는데 시간과 돈이…\n영원한 딜레마다", cat: "질문" }
  ],
  // 평일 오후 14~17시
  afternoonWd: [
    { t: "오후 3시 졸음은 과학이다", b: "점심 먹고 나면 어김없이 눈이 감김\n커피를 마셔도 소용없음\n낮잠 제도 도입이 시급합니다", cat: "일상" },
    { t: "갑자기 잡힌 오후 회의 때문에 계획 다 틀어짐", b: "오늘 일찍 끝내고 칼퇴하려 했는데\n4시 회의라니 이게 무슨 소리야\n칼퇴는 다음 생에", cat: "일상" },
    { t: "오후에 지하철 타면 세상 한가하다", b: "외근 나와서 {line} 탔는데 자리가 텅텅\n이 시간대만 다니면 지하철 탈만 한데\n러시아워가 문제야", cat: "일상" },
    { t: "퇴근까지 두 시간, 벌써 가방 쌌음", b: "마음은 이미 집에 가 있음\n일은 손에 안 잡히고 시계만 보는 중\n다들 마지막 두 시간 어떻게 버팀?", cat: "일상" }
  ],
  // 주말 오후
  afternoonWe: [
    { t: "주말 오후 {stn} 사람 진짜 많다", b: "약속 있어서 나왔는데 발 디딜 틀이 없음\n다들 약속이 여기였냐\n그래도 오랜만에 나오니까 좋긴 하다", cat: "일상" },
    { t: "주말에 전시 보러 다니는 사람 있음?", b: "오늘 {stn} 근처 전시 갔다 왔는데 생각보다 좋았음\n주말에 이런 문화생활 하나씩 하면 한 주가 리셋되는 느낌\n추천할만한 전시 있으면 공유 좀", cat: "질문" },
    { t: "일요일 오후만 되면 마음이 싱숭생숭", b: "아직 반나절 남았는데 벌써 월요일 걱정 중\n이 시간을 즐기지 못하는 내가 싫다\n일요일 오후 증후군 나만 있는 거 아니지?", cat: "일상" }
  ],
  // 평일 퇴근길 17~20시
  eveRushWd: [
    { t: "퇴근길 {line} 지옥철 실화냐", b: "{stn}에서 탔는데 숨을 못 쉬겠음\n세 대 보내고 겨우 탐\n다들 무사귀환 하시길", cat: "일상" },
    { t: "칼퇴 성공한 날은 지하철도 즐겁다", b: "6시 정각에 나와서 {line} 탔음\n사람 많아도 기분이 좋으니까 견딜만 함\n칼퇴는 최고의 복지다", cat: "일상" },
    { t: "퇴근길에 폰 배터리 1%면 진짜 불안함", b: "{stn}까지 40분 남았는데 배터리가 간당간당\n노래도 못 듣고 멍때리는 중\n보조배터리 챙길걸", cat: "일상" },
    { t: "저녁 약속 있는 날 퇴근길은 왜 이리 설레냐", b: "{stn2}에서 친구 만나기로 함\n같은 지하철인데 회사 갈 때랑 기분이 이렇게 다름\n목적지가 중요한 거였어", cat: "일상" },
    { t: "환승 두 번 하는 퇴근길, 이직하면 나아질까", b: "집까지 도어투도어 1시간 20분\n환승할 때마다 영혼이 갈려나감\n출퇴근 거리도 연봉이다 진짜", cat: "일상" },
    { t: "{stn}역 퇴근시간 에스컬레이터 줄 무엇", b: "에스컬레이터 타려는 줄이 플랫폼 끝까지 이어짐\n계단으로 올라가는 게 훨씬 빠른데 다들 왜 기다리지\n오늘도 계단으로 운동했다 치자", cat: "일상" }
  ],
  // 주말 저녁
  eveWe: [
    { t: "주말 저녁 집 가는 길, 아쉽다", b: "하루 종일 잘 놀고 {line} 타고 귀가 중\n내일 하루 더 남았다는 게 유일한 위안\n주말은 왜 이렇게 빠르냐", cat: "일상" },
    { t: "{stn} 근처 저녁 먹을 곳 추천 좀", b: "가족들이랑 외식하려는데 웨이팅 없는 곳 없나\n주말 저녁은 어딜 가나 만석이네\n숨은 맛집 아시는 분?", cat: "질문" },
    { t: "주말 저녁 지하철엔 피곤한 얼굴들뿐", b: "다들 하루 종일 놀았는지 꾸벅꾸벅 졸고 있음\n나도 그 중 하나\n잘 놀았다는 증거겠지", cat: "일상" }
  ],
  // 평일 밤 20~24시
  nightWd: [
    { t: "야근 끝나고 타는 지하철은 유독 조용하다", b: "9시 넘어서 {line} 탔는데 다들 지쳐 보임\n낮의 소음이 없으니까 오히려 마음이 편하네\n야근러들 다들 수고했어요", cat: "일상" },
    { t: "회식 끝나고 막차 시간 계산하는 중", b: "부장님은 3차 가자는데 막차가 40분 남았음\n지금 일어나야 {stn} 환승 가능\n탈출 각 재는 중", cat: "일상" },
    { t: "밤에 타는 지하철에서 하루를 돌아봄", b: "오늘 하루도 정신없이 지나갔네\n창문에 비친 내 얼굴 보니까 피곤이 그대로 보임\n다들 오늘 하루 수고 많았어요", cat: "일상" },
    { t: "퇴근이 늦어서 저녁을 집 근처에서 해결함", b: "{stn}역 앞 분식집에서 김밥에 라면\n늦은 시간이라 그런지 유독 맛있음\n소소하지만 확실한 행복", cat: "일상" },
    { t: "막차 놓칠 뻔한 사람의 전력질주", b: "{stn} 계단을 인생 최고 속도로 뛰어내려감\n문 닫히기 3초 전에 탑승 성공\n심장이 아직도 뛴다 ㅋㅋ", cat: "일상" }
  ],
  // 주말 밤
  nightWe: [
    { t: "주말 밤 지하철엔 이야기가 많다", b: "다들 어디서 뭘 하고 왔는지 표정이 다양함\n웃는 사람, 조는 사람, 통화하는 사람\n주말 밤 특유의 분위기가 있음", cat: "일상" },
    { t: "내일 출근 생각에 잠이 안 옴", b: "일요일 밤마다 반복되는 불면\n주말이 끝났다는 걸 몸이 거부하는 중\n다들 일요일 밤 어떻게 보냄?", cat: "일상" },
    { t: "주말 마지막 밤에는 야식이 국룰", b: "치킨 시켜놓고 기다리는 중\n다이어트는 내일부터 하기로 함 (매주 반복)\n주말의 마무리는 역시 야식이지", cat: "일상" }
  ]
};
var WEATHER_POOLS = {
  rain: [
    { t: "비 오는 날 지하철역 입구 우산 정체 실화냐", b: "{stn}역 출구에서 다들 우산 펴느라 병목현상\n뒤에서 밀려오는데 나갈 수가 없음\n비 오는 날 출구는 전쟁터다", cat: "일상" },
    { t: "우산 안 챙긴 날에만 꼭 비가 옴", b: "아침에 하늘 멀쩡했는데 지금 쏟아지는 중\n{stn}역에서 편의점 우산 사야 하나 고민\n집에 편의점 우산만 다섯 개다", cat: "일상" },
    { t: "비 오는 날 지하철 냄새 나만 신경 쓰임?", b: "젖은 우산이랑 사람들 습기가 합쳐져서\n특유의 꿉꿉한 냄새가 남\n창문이라도 열고 싶다", cat: "일상" },
    { t: "빗소리 들으면서 퇴근하는 것도 나쁘지 않네", b: "지상 구간에서 창밖에 비 내리는 거 보는 중\n노래 틀어놓으니까 뮤직비디오가 따로 없음\n비 오는 날의 낭만은 실내에서만 유효함", cat: "일상" },
    { t: "장마철 지하철 에어컨+습기 조합 최악이다", b: "춥긴 한데 꿉꿉하고 끈적임\n겉옷을 입을 수도 벗을 수도 없는 상태\n장마 빨리 끝나라", cat: "일상" }
  ],
  snow: [
    { t: "눈 오니까 지하철이 정답이다", b: "도로는 벌써 거북이걸음이라는데\n{line}은 그런 거 없이 정시 도착\n눈 오는 날 차 끌고 나온 사람들 존버하세요", cat: "일상" },
    { t: "첫눈 오는 거 지하철 지상구간에서 봄", b: "창밖에 눈 내리는 거 보니까 갑자기 기분 좋아짐\n옆자리 사람도 폰 내려놓고 창밖 보는 중\n다 같은 마음이구나", cat: "일상" },
    { t: "눈길에 {stn}역까지 걸어가는 게 고행이다", b: "빙판길에 펭귄처럼 뒤뚱뒤뚱 걷는 중\n오늘 몇 명 넘어지는 거 봤는지 모름\n다들 조심히 다니세요", cat: "일상" }
  ],
  hot: [
    { t: "오늘 {temp}도 실화냐 밖에 나가면 익는다", b: "역까지 5분 걷는데 등이 다 젖음\n지하철 에어컨이 유일한 구원\n여름엔 지하가 최고다", cat: "일상" },
    { t: "폭염에 지하철 계단 올라가면 사우나 직행", b: "{stn}역 출구 계단에서 이미 체력 소진\n지상으로 나가는 순간 훅 끼치는 열기\n다들 물 챙겨 다니세요", cat: "일상" },
    { t: "더위 때문에 약냉방칸 vs 일반칸 논쟁 중", b: "나는 무조건 일반칸파, 시원해야 살 것 같음\n근데 춥다는 사람도 이해는 감\n다들 어느 칸 타심?", cat: "질문" }
  ],
  cold: [
    { t: "한파에 지하철 기다리는 5분이 50분 같다", b: "플랫폼에 바람 들이치는데 발이 얼어붙는 줄\n{line} 도착 안내만 뚫어져라 보는 중\n겨울엔 스크린도어 있는 역이 최고다", cat: "일상" },
    { t: "추운 날 지하철 히터 자리는 명당이다", b: "좌석 아래 히터 나오는 자리 앉으면 엉덩이가 따뜻함\n내릴 때가 아쉬울 정도\n겨울 지하철의 숨은 낙", cat: "일상" },
    { t: "영하 날씨엔 목도리가 생존템이다", b: "오늘 목도리 안 하고 나왔다가 후회 중\n{stn}까지 걸어가는데 목이 시려서 혼남\n내일부터 무조건 챙긴다", cat: "일상" }
  ]
};
var NEWS_FEEDS = [
  { cat: "사회\xB7정치", badge: "일상", urls: [
    "https://news.google.com/rss/headlines/section/topic/NATION?hl=ko&gl=KR&ceid=KR:ko",
    "https://www.yna.co.kr/rss/politics.xml",
    "https://www.yna.co.kr/rss/society.xml"
  ] },
  { cat: "경제\xB7주식", badge: "정보", urls: [
    "https://news.google.com/rss/headlines/section/topic/BUSINESS?hl=ko&gl=KR&ceid=KR:ko",
    "https://www.yna.co.kr/rss/economy.xml"
  ] },
  { cat: "연예", badge: "일상", urls: [
    "https://news.google.com/rss/headlines/section/topic/ENTERTAINMENT?hl=ko&gl=KR&ceid=KR:ko",
    "https://www.yna.co.kr/rss/entertainment.xml"
  ] },
  { cat: "스포츠", badge: "일상", urls: [
    "https://news.google.com/rss/headlines/section/topic/SPORTS?hl=ko&gl=KR&ceid=KR:ko",
    "https://www.yna.co.kr/rss/sports.xml"
  ] },
  { cat: "IT", badge: "정보", urls: [
    "https://news.google.com/rss/headlines/section/topic/TECHNOLOGY?hl=ko&gl=KR&ceid=KR:ko",
    "https://rss.etnews.com/Section901.xml"
  ] }
];
var _gemStat = { ok: 0, fail: 0, last: "", model: "", ctxRej: 0 };
// ★ 2026-10-05: Gemini 무료 한도 대응. 모델마다 하루 한도가 따로라서, flash-lite 가 429(한도)면 다음 모델로 넘어간다.
//   한도에 걸린 모델은 20분(404 면 6시간) 동안 건너뛴다 → 한도 난 뒤에도 20분마다 헛호출을 쏟아붓지 않는다.
// ★ 2026-10-10 (YJ: 게시글·댓글·소통방이 하루 만에 멈춘다 / 소통방 문장이 "치맥… 🍗… 🤤" 처럼 깨진다):
//   원인① 무료 키의 gemini-2.5-flash-lite 는 하루 약 20회뿐이라 오후 몇 시간 만에 소진 → 다음 날 오후까지 429. (다른 gemini 모델은 이 키에서 404)
//   원인② temperature 1.15 가 flash-lite 에서 말줄임표 조각을 낳았다.
//   → ⓐ 쿼터가 따로 잡히는 Gemma(gemma-3-27b-it 등, 무료 하루 수천 회)를 예비 모델로 추가하고, 소통방 대량 생성은 Gemma 를 먼저 쓴다.
//     ⓑ 404/429 외의 400·403 도 멈추지 않고 다음 모델로 넘어간다. ⓒ ListModels 로 이 키에서 실제 쓸 수 있는 모델을 찾아 목록에 보탠다(bw_diag 'gemmodels' 에 기록).
var GEM_MODELS = ["gemini-2.5-flash-lite", "gemini-flash-lite-latest", "gemini-2.5-flash", "gemini-2.0-flash", "gemma-3-27b-it", "gemma-3-12b-it"];
var GEM_BULK_ORDER = ["gemma-3-27b-it", "gemma-3-12b-it", "gemini-2.5-flash-lite", "gemini-flash-lite-latest", "gemini-2.5-flash", "gemini-2.0-flash"];   // 소통방(대량) — Gemini 쿼터는 게시판용으로 아낀다
var _gemDownUntil = {};
var _gemLast = { status: 0, model: "", tried: "" };
var _gemUse = {};          // 이 실행에서 성공 호출한 모델별 횟수(끝나면 bw_diag 'gemuse' 로 기록 → 하루 예산 계산)
var _gemExtra = [];        // ListModels 로 찾은 추가 모델
var _gemDiscAt = 0;
function gemOrder(base) {
  const out = base.slice();
  _gemExtra.forEach((m) => { if (out.indexOf(m) < 0) out.push(m); });
  return out;
}
__name(gemOrder, "gemOrder");
async function gemDiscover(env) {
  if (Date.now() - _gemDiscAt < 3 * 3600e3 || !env.GEMINI_KEY) return;
  _gemDiscAt = Date.now();
  try {
    const r = await fetchT("https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key=" + env.GEMINI_KEY, 8e3, { method: "GET" });
    if (!r.ok) { await bwDiag(env, "gemmodels", { http: r.status }); return; }
    const d = await r.json();
    const names = (d.models || []).filter((m) => (m.supportedGenerationMethods || []).indexOf("generateContent") >= 0).map((m) => String(m.name || "").replace(/^models\//, ""));
    const usable = names.filter((n) => /^(gemini-[\d.]+-flash(-lite)?|gemini-flash(-lite)?-latest|gemma-3-(27b|12b|4b)-it)$/.test(n));
    usable.forEach((n) => { if (GEM_MODELS.indexOf(n) < 0 && _gemExtra.indexOf(n) < 0) _gemExtra.push(n); });
    await bwDiag(env, "gemmodels", { n: names.length, use: usable.join(",").slice(0, 400) });
  } catch (e) { await bwDiag(env, "gemmodels", { err: String((e && e.message) || e).slice(0, 80) }); }
}
__name(gemDiscover, "gemDiscover");
async function flushGemUse(env) {
  const keys = Object.keys(_gemUse);
  if (!keys.length) return;
  const snap = _gemUse; _gemUse = {};
  await bwDiag(env, "gemuse", snap);
}
__name(flushGemUse, "flushGemUse");
// 최근 24시간 동안 Gemini(gemini-*) 모델을 부른 횟수 — 소통방이 게시판 몫까지 써 버리지 않게 예산을 가른다
async function geminiUsed24h(env) {
  let n = 0;
  try {
    const rs = await env.DB.prepare("SELECT v FROM bw_diag WHERE k='gemuse' AND ts > ?1").bind(Date.now() - 24 * 3600e3).all();
    (rs.results || []).forEach((r) => { try { const o = JSON.parse(r.v); Object.keys(o).forEach((m) => { if (m.indexOf("gemini-") === 0) n += o[m] | 0; }); } catch (e) {} });
  } catch (e) {}
  Object.keys(_gemUse).forEach((m) => { if (m.indexOf("gemini-") === 0) n += _gemUse[m]; });
  return n;
}
__name(geminiUsed24h, "geminiUsed24h");
var GEMINI_TALK_BUDGET = 8;   // 소통방이 24시간에 쓸 수 있는 gemini-* 호출 수(무료 한도 ≈20 중 나머지는 게시글·댓글 몫)
async function gemFetch(env, ms, init, order) {
  let last = null, attempted = 0;
  const tried = [];
  for (const m of gemOrder(order || GEM_MODELS)) {
    if ((_gemDownUntil[m] || 0) > Date.now()) continue;
    attempted++;
    let r;
    try {
      r = await fetchT("https://generativelanguage.googleapis.com/v1beta/models/" + m + ":generateContent?key=" + env.GEMINI_KEY, ms, init);
    } catch (e) {
      _gemDownUntil[m] = Date.now() + 30e3;
      tried.push(m.replace("gemini-", "") + ":timeout");
      continue;
    }
    tried.push(m.replace("gemini-", "") + ":" + r.status);
    if (r.ok) { _gemStat.model = m; _gemUse[m] = (_gemUse[m] || 0) + 1; _gemLast = { status: 200, model: m, tried: tried.join(",") }; return r; }
    last = r;
    // ★ 2026-10-05: 503(과부하)도 다음 모델로 넘어간다 — 16:00 에 flash-lite 가 503 이라 13개 방이 비었다. 5xx 는 1분만 쉰다.
    if (r.status === 429) _gemDownUntil[m] = Date.now() + 20 * 60e3;
    else if (r.status === 404) _gemDownUntil[m] = Date.now() + 6 * 3600e3;
    else if (r.status >= 500) _gemDownUntil[m] = Date.now() + 60e3;
    else _gemDownUntil[m] = Date.now() + 30 * 60e3;   // 400·403 등: 이 모델은 30분 쉬고 다음 모델을 시도한다(Gemma 가 지원 안 하는 옵션 등)
  }
  _gemLast = { status: last ? last.status : (attempted ? 504 : 429), model: "", tried: tried.join(",") };
  return last || { ok: false, status: attempted ? 504 : 429, json: async () => ({}), text: async () => "" };
}
__name(gemFetch, "gemFetch");
function fetchT(url, ms, opts) {
  const o = opts || { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", "Accept": "application/rss+xml, application/xml, text/xml, */*" }, redirect: "follow" };
  return Promise.race([
    fetch(url, o),
    new Promise(function(_, rej) {
      setTimeout(function() {
        rej(new Error("timeout"));
      }, ms);
    })
  ]);
}
__name(fetchT, "fetchT");
var NEWSFEED_SRC = [
  { cat: "사회", url: "https://www.yna.co.kr/rss/society.xml" },
  { cat: "정치", url: "https://www.yna.co.kr/rss/politics.xml" },
  { cat: "경제", url: "https://www.yna.co.kr/rss/economy.xml" },
  { cat: "연예", url: "https://www.yna.co.kr/rss/entertainment.xml" },
  { cat: "스포츠", url: "https://www.yna.co.kr/rss/sports.xml" },
  { cat: "IT", url: "https://rss.etnews.com/Section901.xml" }
];
function _unesc(t) {
  return String(t).replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim();
}
__name(_unesc, "_unesc");
function parseItemsFull(xml) {
  const out = [];
  const re = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = re.exec(xml)) !== null && out.length < 30) {
    const blk = m[1];
    const tm = blk.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/);
    const lm = blk.match(/<link>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/link>/);
    const dm = blk.match(/<pubDate>([\s\S]*?)<\/pubDate>/);
    const sm = blk.match(/<description>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/);
    if (!tm || !lm) continue;
    let t = _unesc(tm[1]);
    const cut = t.lastIndexOf(" - ");
    if (cut > 10) t = t.slice(0, cut).trim();
    const l = _unesc(lm[1]);
    let d = 0;
    if (dm) {
      const p = Date.parse(dm[1].trim());
      if (!isNaN(p)) d = p;
    }
    let s = "";
    if (sm) {
      s = _unesc(sm[1].replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
      if (s.length > 320) s = s.slice(0, 320) + "…";
    }
    if (t.length >= 8 && l.indexOf("http") === 0) out.push({ t, l, d, s });
  }
  return out;
}
__name(parseItemsFull, "parseItemsFull");
function parseTitles(xml) {
  const out = [];
  const re = /<item>[\s\S]*?<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/g;
  let m;
  while ((m = re.exec(xml)) !== null && out.length < 12) {
    let t = m[1].replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim();
    const cut = t.lastIndexOf(" - ");
    if (cut > 10) t = t.slice(0, cut).trim();
    if (t.length >= 8 && t.length <= 90) out.push(t);
  }
  return out;
}
__name(parseTitles, "parseTitles");
async function fetchHeadlines(feed, debug) {
  const tries = [];
  for (const u of feed.urls) {
    try {
      const r = await fetchT(u, 6e3);
      if (!r.ok) {
        tries.push({ url: u, status: r.status });
        continue;
      }
      const xml = await r.text();
      const titles = parseTitles(xml);
      tries.push({ url: u, status: r.status, titles: titles.length });
      if (titles.length) {
        return debug ? { titles, tries } : titles;
      }
    } catch (e) {
      tries.push({ url: u, error: e.message });
    }
  }
  return debug ? { titles: [], tries } : [];
}
__name(fetchHeadlines, "fetchHeadlines");
function tplRegex(t) {
  const esc = t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp("^" + esc.replace(/\\\{line\\\}|\\\{stn2?\\\}|\\\{temp\\\}/g, ".+") + "$");
}
__name(tplRegex, "tplRegex");
function rnd(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}
__name(rnd, "rnd");
function rndInt(a, b) {
  return a + Math.floor(Math.random() * (b - a + 1));
}
__name(rndInt, "rndInt");
function kstNow() {
  return new Date(Date.now() + 9 * 3600 * 1e3);
}
__name(kstNow, "kstNow");
// ══════════════════════════════════════════════════════════════════════
// ★ 2026-10-05 (YJ): 글·댓글·대화가 '오늘이 무슨 날인지'와 어긋나는 문제 — 개천절 대체공휴일(월요일)인데 일요일 밤에 "낼 월요일 출근"이라고
//   쓰고, 게시판엔 "내일부터 월요일 시작"이라고 썼다. 요일 이름과 쉬는 날 여부를 따로 계산하던 것이 원인(슬롯 라벨은 '월요일 (평일)').
//   고친 것: ① 공휴일 표(대체공휴일 포함)로 오늘·내일·다음 출근일·가까운 공휴일을 계산(dayCtx) ② 모든 Gemini 프롬프트에 그 사실과 계절·날씨를
//   넣는다(ctxBlock) ③ 템플릿(정해진 문구)과 Gemini 결과 모두 요일·휴일·계절·기온·비/눈과 어긋나면 버린다(ctxReject).
//   공휴일 표는 매년 갱신해야 한다 — 표에 없는 해는 고정일 공휴일(신정·삼일절·어린이날·현충일·광복절·개천절·한글날·성탄절)만 적용한다.
//   임시공휴일이 생기면 HOLIDAY_NAMES 에 한 줄 추가.
// ══════════════════════════════════════════════════════════════════════
var HOLIDAY_NAMES = {
  "2026-01-01": "신정", "2026-02-16": "설날 연휴", "2026-02-17": "설날", "2026-02-18": "설날 연휴", "2026-03-01": "삼일절", "2026-03-02": "삼일절 대체공휴일",
  "2026-05-05": "어린이날", "2026-05-24": "부처님오신날", "2026-05-25": "부처님오신날 대체공휴일", "2026-06-03": "지방선거일", "2026-06-06": "현충일",
  "2026-08-15": "광복절", "2026-08-17": "광복절 대체공휴일", "2026-09-24": "추석 연휴", "2026-09-25": "추석", "2026-09-26": "추석 연휴",
  "2026-10-03": "개천절", "2026-10-05": "개천절 대체공휴일", "2026-10-09": "한글날", "2026-12-25": "성탄절",
  // 2027 — 미리 계산한 값(확정 공고가 나오면 확인)
  "2027-01-01": "신정", "2027-02-05": "설날 연휴", "2027-02-06": "설날", "2027-02-07": "설날 연휴", "2027-02-08": "설날 대체공휴일", "2027-03-01": "삼일절",
  "2027-05-05": "어린이날", "2027-05-13": "부처님오신날", "2027-06-06": "현충일", "2027-08-15": "광복절", "2027-08-16": "광복절 대체공휴일",
  "2027-09-14": "추석 연휴", "2027-09-15": "추석", "2027-09-16": "추석 연휴", "2027-10-03": "개천절", "2027-10-04": "개천절 대체공휴일",
  "2027-10-09": "한글날", "2027-10-11": "한글날 대체공휴일", "2027-12-25": "성탄절", "2027-12-27": "성탄절 대체공휴일"
};
var HOLIDAY_FIXED = { "01-01": "신정", "03-01": "삼일절", "05-05": "어린이날", "06-06": "현충일", "08-15": "광복절", "10-03": "개천절", "10-09": "한글날", "12-25": "성탄절" };
var HOLIDAY_TABLE_YEARS = { "2026": 1, "2027": 1 };
var HOLIDAYS = Object.keys(HOLIDAY_NAMES);
var DOW_KO = ["일", "월", "화", "수", "목", "금", "토"];
function _p2(n) { return ("0" + n).slice(-2); }
function ymdOf(d) { return d.getUTCFullYear() + "-" + _p2(d.getUTCMonth() + 1) + "-" + _p2(d.getUTCDate()); }
// ★ 2026-10-09: 공휴일 단일 출처 — 엔진(route-v2)의 /holidays 가 매일 새벽 정부 특일 API 등을 대조해 갱신한다.
//   여기 표(HOLIDAY_NAMES)는 그 자료를 못 받을 때의 예비다. 받은 자료에 있는 해는 그것만 믿는다(대체공휴일·임시공휴일 포함).
var HOLIDAY_LIVE = null, HOLIDAY_LIVE_AT = 0, HOLIDAY_LIVE_TRY = 0;
// 같은 계정의 워커끼리는 workers.dev 주소로 부를 수 없어(404) 엔진을 직접 부르지 않는다. 대신 갱신 워크플로(refresh-holidays.yml)가 KV 에 올릴 때
// D1(subway-db)의 holidays_live 표에도 같은 JSON 을 넣어 두고, 여기서는 그것을 읽는다.
async function holRefresh(env) {
  const now = Date.now();
  if (now - HOLIDAY_LIVE_AT < 6 * 3600e3 || now - HOLIDAY_LIVE_TRY < 10 * 60e3) return;
  HOLIDAY_LIVE_TRY = now;
  try {
    if (!env || !env.DB) return;
    await env.DB.prepare("CREATE TABLE IF NOT EXISTS holidays_live (k TEXT PRIMARY KEY, v TEXT NOT NULL, ts INTEGER)").run();
    const row = await env.DB.prepare("SELECT v FROM holidays_live WHERE k = 'nt:holidays:v1'").first();
    if (!row || !row.v) { await bwDiag(env, "holidays", { ok: false, bad: "nodata" }); return; }
    const o = JSON.parse(row.v);
    if (!o || !o.years || typeof o.years !== "object") { await bwDiag(env, "holidays", { ok: false, bad: "shape" }); return; }
    const yrs = {};
    for (const y in o.years) { const ye = o.years[y]; if (ye && ye.dates && typeof ye.dates === "object") yrs[y] = ye.dates; }
    if (!Object.keys(yrs).length) { await bwDiag(env, "holidays", { ok: false, bad: "empty" }); return; }
    HOLIDAY_LIVE = yrs; HOLIDAY_LIVE_AT = now;
    await bwDiag(env, "holidays", { ok: true, src: o.src, ver: o.version, years: Object.keys(yrs) });
  } catch (e) { try { await bwDiag(env, "holidays", { ok: false, err: String(e && e.message || e).slice(0, 120) }); } catch (e2) {} /* 예비 표를 그대로 쓴다 */ }
}
__name(holRefresh, "holRefresh");
function holidayName(ymd) {
  const ly = HOLIDAY_LIVE && HOLIDAY_LIVE[ymd.slice(0, 4)];
  if (ly) return ly[ymd] || "";
  if (HOLIDAY_NAMES[ymd]) return HOLIDAY_NAMES[ymd];
  if (HOLIDAY_TABLE_YEARS[ymd.slice(0, 4)]) return "";
  return HOLIDAY_FIXED[ymd.slice(5)] || "";
}
__name(holidayName, "holidayName");
function isRestDay(kst) {
  const day = kst.getUTCDay();
  if (day === 0 || day === 6) return true;
  return !!holidayName(ymdOf(kst));
}
__name(isRestDay, "isRestDay");
function dayShift(kst, n) { return new Date(kst.getTime() + n * 86400e3); }
function dayInfo(d) {
  const dow = d.getUTCDay(), ymd = ymdOf(d), hol = holidayName(ymd);
  return { ymd: ymd, dow: dow, m: d.getUTCMonth() + 1, d: d.getUTCDate(), md: (d.getUTCMonth() + 1) * 100 + d.getUTCDate(), hol: hol, rest: dow === 0 || dow === 6 || !!hol };
}
__name(dayInfo, "dayInfo");
function dayCtx(kst) {
  const t = dayInfo(kst), tm = dayInfo(dayShift(kst, 1)), y = dayInfo(dayShift(kst, -1));
  let nw = null, nm = null, i;
  for (i = 1; i <= 14 && !nw; i++) { const x = dayInfo(dayShift(kst, i)); if (!x.rest) { nw = x; nw.after = i; } }   // 다음 출근·등교일
  for (i = 1; i <= 7 && !nm; i++) { const x = dayInfo(dayShift(kst, i)); if (x.dow === 1) { nm = x; nm.after = i; } }   // 다음 월요일(오늘 제외)
  const hols = [];
  for (i = 1; i <= 14; i++) { const x = dayInfo(dayShift(kst, i)); if (x.hol && x.dow >= 1 && x.dow <= 5) { x.after = i; hols.push(x); } }   // 평일에 낀 공휴일
  return { t: t, tm: tm, y: y, nw: nw, nm: nm, hols: hols, hw: !!(t.hol && t.dow >= 1 && t.dow <= 5) };
}
__name(dayCtx, "dayCtx");
function seasonText(md) {
  if (md >= 301 && md <= 320) return "초봄(아직 쌀쌀, 꽃샘추위)";
  if (md >= 321 && md <= 430) return "봄(벚꽃철, 일교차 큼)";
  if (md >= 501 && md <= 531) return "늦봄·초여름(신록, 낮엔 더움)";
  if (md >= 601 && md <= 620) return "초여름(더워지는 중)";
  if (md >= 621 && md <= 720) return "장마철(덥고 습함)";
  if (md >= 721 && md <= 820) return "한여름(무더위·열대야)";
  if (md >= 821 && md <= 920) return "늦여름~초가을(늦더위 남아 있음)";
  if (md >= 921 && md <= 1020) return "가을(선선함, 단풍이 들기 시작, 일교차 큼)";
  if (md >= 1021 && md <= 1120) return "늦가을(쌀쌀, 단풍·낙엽, 겨울옷 꺼내는 시기)";
  if (md >= 1121 && md <= 1220) return "초겨울(추워지는 중, 첫눈·붕어빵 철)";
  return "한겨울(추위)";
}
__name(seasonText, "seasonText");
function tempWord(t) {
  if (t <= -5) return "매우 추움(한파)";
  if (t <= 2) return "한겨울 추위";
  if (t <= 9) return "춥다";
  if (t <= 15) return "쌀쌀하다";
  if (t <= 21) return "선선하고 활동하기 좋다";
  if (t <= 25) return "포근하거나 약간 따뜻하다";
  if (t <= 29) return "덥다";
  return "무더위(폭염)";
}
__name(tempWord, "tempWord");
function skyWord(w) {
  const c = w.code || 0;
  if (c === 0) return "맑음";
  if (c <= 3) return "구름 조금~흐림(비·눈 없음)";
  if (c === 45 || c === 48) return "안개";
  if (c >= 51 && c <= 57) return "이슬비(비 옴)";
  if (c >= 61 && c <= 67) return "비 옴";
  if (c >= 71 && c <= 77 || c === 85 || c === 86) return "눈 옴";
  if (c >= 80 && c <= 82) return "소나기(비 옴)";
  if (c >= 95) return "천둥번개·비";
  return "보통(비·눈 없음)";
}
__name(skyWord, "skyWord");
var DAY_RULES = "규칙: ① 요일·휴일을 정확히. 쉬는 날(주말·공휴일)에는 '출근길·등교·회사·수업·월요병' 같은 말을 오늘의 일상으로 쓰지 마라(휴일 출근·특근·알바를 일부러 말하는 경우만 가능). ② 내일이 쉬는 날이면 '내일 출근·내일 월요일·월요병' 금지, 내일이 평일이면 '내일도 쉼' 금지. 월요일이어도 공휴일이면 월요일 출근 얘기 금지. ③ 계절·기온에 안 맞는 소재 금지(가을에 장마·빙수·한겨울 패딩 같은 것). ④ 비·눈이 안 오면 비·눈 얘기 금지, 비가 오면 '날씨 좋다' 금지. ⑤ 오늘이 평일 공휴일이면 '주말' 대신 '휴일·공휴일'이라고 말한다.";
function ctxBlock(kst, w, wcat) {
  const c = dayCtx(kst), t = c.t, tm = c.tm;
  const dn = function(x) { return x.m + "월 " + x.d + "일 " + DOW_KO[x.dow] + "요일"; };
  const kindOf = function(x) { return x.hol ? (x.dow >= 1 && x.dow <= 5 ? x.hol + "이라 평일이지만 쉬는 날(출근·등교 없음)" : x.hol + "(쉬는 날)") : x.dow === 0 || x.dow === 6 ? "주말(쉬는 날)" : "평일(출근·등교하는 날)"; };
  const today = "오늘: " + dn(t) + " — " + kindOf(t);
  const tomo = "내일: " + DOW_KO[tm.dow] + "요일 — " + kindOf(tm);
  const nw = c.nw ? "다음 출근·등교일: " + (c.nw.after === 1 ? "내일" : c.nw.after + "일 뒤") + " " + DOW_KO[c.nw.dow] + "요일" : "";
  const up = c.hols.length ? "가까운 공휴일: " + c.hols.slice(0, 2).map(function(h) { return h.m + "/" + h.d + "(" + DOW_KO[h.dow] + ") " + h.hol + " — " + h.after + "일 뒤"; }).join(", ") : "";
  const wx = w ? "서울 현재 " + w.temp + "도(" + tempWord(w.temp) + "), 하늘: " + skyWord(w) : "날씨 정보 없음(날씨 얘기는 하지 마라)";
  return "\n[날짜·계절·날씨 — 사실이다. 이와 어긋나는 말은 쓰지 마라]\n" + [today, tomo, nw, up, "계절: " + seasonText(t.md), wx].filter(Boolean).join("\n") + "\n" + DAY_RULES;
}
__name(ctxBlock, "ctxBlock");
// 평일 공휴일에 '주말'이라고 쓴 것은 '휴일'로 바꾼다(이번 주말·다음 주말처럼 다른 주말을 가리키는 말은 그대로).
function holFix(text, kst) {
  const s = String(text == null ? "" : text);
  if (!dayCtx(kst).hw) return s;
  return s.replace(/(이번 |다음 |담 |지난 |다가오는 )?주말/g, function(m, pre) { return pre ? m : "휴일"; });
}
__name(holFix, "holFix");
// 계절어 — [정규식, [[시작 MMDD, 끝 MMDD], ...]] 이 기간 밖에서 나오면 어색하다
var SEASON_RULES = [
  [/장마/, [[615, 731]]], [/폭염|열대야|무더위|찜통|삼복|복날/, [[601, 915]]], [/빙수|물놀이|워터파크|해수욕/, [[501, 930]]],
  [/에어컨/, [[501, 1015]]], [/모기/, [[601, 1010]]], [/히터/, [[1020, 415]]], [/붕어빵|호빵|군고구마/, [[1001, 430]]],
  [/패딩|목도리|장갑|핫팩|털장화/, [[1020, 415]]], [/한파|혹한/, [[1115, 315]]], [/첫눈|눈사람|폭설|눈길|빙판/, [[1101, 331]]],
  [/벚꽃|꽃구경/, [[320, 515]]], [/황사/, [[301, 531]]], [/단풍|낙엽/, [[925, 1205]]], [/은행잎/, [[1001, 1130]]],
  [/크리스마스|산타|캐롤/, [[1115, 1231]]], [/송년|연말/, [[1201, 1231]]], [/새해|신년|새해복/, [[1226, 131]]],
  [/개강/, [[225, 325], [825, 925]]], [/종강/, [[610, 705], [1205, 1231]]], [/방학/, [[620, 831], [1215, 229]]],
  [/수능/, [[1001, 1130]]], [/중간고사/, [[405, 505], [1005, 1031]]], [/기말고사/, [[601, 701], [1201, 1231]]]
];
// 명절·기념일어 — 그 공휴일 앞뒤 10일 안에서만
var HOLIDAY_WORDS = [
  [/추석|한가위|귀성|귀경/, ["추석"]], [/설날|세배|세뱃돈/, ["설날"]], [/명절/, ["추석", "설날"]], [/개천절/, ["개천절"]], [/한글날/, ["한글날"]],
  [/어린이날/, ["어린이날"]], [/광복절/, ["광복절"]], [/삼일절/, ["삼일절"]], [/현충일/, ["현충일"]], [/부처님오신날|석가탄신일/, ["부처님오신날"]]
];
function _inRange(md, r) { return r[0] <= r[1] ? (md >= r[0] && md <= r[1]) : (md >= r[0] || md <= r[1]); }
// 어긋나는 점이 있으면 이유(짧은 문자열), 없으면 "" — 템플릿을 고를 때와 Gemini 결과를 거를 때 모두 쓴다.
function ctxReject(text, kst, w, cOpt) {
  const s = String(text == null ? "" : text);
  if (!s) return "";
  const c = cOpt || dayCtx(kst), t = c.t, tm = c.tm;
  let m;
  const NEG = /아니|없|안 ?(가|해|하|간|나|와|갈)|쉬|쉰|휴일|공휴일|연휴|대체|노는|놀|부럽/;
  // 내일이 쉬는 날인데 내일 출근·월요일·수업 얘기
  const re1 = /(내일|낼)[^.!?\n]{0,10}?(출근|등교|월요|월욜|회사|학교|수업|일가|일 가|근무|야근|지각|개강|일 해|일해)/g;
  while ((m = re1.exec(s))) { if (tm.rest && !NEG.test(s.slice(m.index, m.index + m[0].length + 8))) return "내일은 쉬는 날인데 출근·월요일 얘기"; }
  // 내일이 평일인데 내일도 쉰다고
  if (!tm.rest && /(내일|낼)(도|까지)? ?(하루 더 )?(쉬는|쉰다|쉼|휴일|공휴일|연휴)/.test(s) && !/안 ?쉬|못 ?쉬/.test(s)) return "내일은 평일인데 쉰다고 함";
  // '내일 X요일'·'오늘 X요일' 이 실제와 다름
  m = /(내일|낼)(부터|은|도|이)?\s*([일월화수목금토])(요일|욜)/.exec(s);
  if (m && DOW_KO.indexOf(m[3]) !== tm.dow) return "내일 요일이 틀림";
  m = /오늘\s*(은|도)?\s*([일월화수목금토])(요일|욜)/.exec(s);
  if (m && DOW_KO.indexOf(m[2]) !== t.dow) return "오늘 요일이 틀림";
  // 요일 이름 — 어제·오늘·내일 요일이 아니면 '이번·다음·지난' 같은 말이 붙어야 한다(화요일에 "금요일 오후의 설렘" 같은 글 방지)
  if (!/이번|다음|담주|담 |지난|저번|주 /.test(s)) {
    const reD = /([일월화수목금토])(요일|욜)/g;
    while ((m = reD.exec(s))) { const d = DOW_KO.indexOf(m[1]); if (d !== t.dow && d !== tm.dow && d !== c.y.dow) return "요일 안 맞음:" + m[1]; }
    if (/불금/.test(s) && t.dow !== 5 && t.dow !== 4) return "불금인데 금요일이 아님";
  }
  // 다음 월요일이 공휴일인데 '담주 월요일'
  if (c.nm && c.nm.rest && /(담|다음)\s*주?\s*(월요일|월욜|월요)/.test(s)) return "다음 월요일은 휴일";
  // 월요병 — 다음 출근일이 월요일(또는 오늘이 근무하는 월요일)일 때만
  if (/월요병/.test(s)) {
    const ok = (t.dow === 1 && !t.rest) || (c.nw && c.nw.dow === 1 && c.nw.after <= 3);
    if (!ok) return "월요병인데 다음 출근일이 월요일이 아님";
  }
  // 쉬는 날에 출퇴근·수업 일상
  if (t.rest && /출근길|퇴근길|출근 ?시간|퇴근 ?시간|출근 ?러시|퇴근 ?러시|등굣길|하굣길|등교|급식|1교시|야자|지옥철|월급루팡/.test(s) && !/휴일|공휴일|주말|특근|알바|내일|낼|담|다음|연휴|어제|지난|부럽|쉬/.test(s)) return "쉬는 날에 출퇴근 얘기";
  // 월요일이 공휴일인데 평소 월요일처럼 말함
  if (t.dow === 1 && t.rest && /월요일|월욜|월요병/.test(s) && !/휴일|공휴일|대체|쉬|연휴|개천절|담|다음|지난/.test(s)) return "휴일인 월요일을 평소 월요일처럼 말함";
  // 평일인데 '오늘 주말/휴일'
  if (!t.rest && /(오늘|지금)[^.!?\n]{0,6}(주말|휴일|공휴일|연휴)/.test(s) && !/내일|낼|담|다음|이번|언제|처럼|같/.test(s)) return "평일에 휴일 얘기";
  // 계절어
  for (let i = 0; i < SEASON_RULES.length; i++) {
    if (SEASON_RULES[i][0].test(s) && !SEASON_RULES[i][1].some(function(r) { return _inRange(t.md, r); })) return "계절 안 맞음:" + SEASON_RULES[i][0].source.slice(0, 8);
  }
  // 명절·기념일어
  for (let i = 0; i < HOLIDAY_WORDS.length; i++) {
    if (!HOLIDAY_WORDS[i][0].test(s)) continue;
    let near = false;
    for (let k = -10; k <= 10 && !near; k++) { const h = holidayName(ymdOf(dayShift(kst, k))); if (h && HOLIDAY_WORDS[i][1].some(function(n) { return h.indexOf(n) >= 0; })) near = true; }
    if (!near) return "기념일 안 맞음:" + HOLIDAY_WORDS[i][0].source.slice(0, 8);
  }
  // 기온·날씨
  if (w && typeof w.temp === "number") {
    if (w.temp >= 24 && /한파|패딩|핫팩|목도리|장갑|붕어빵|호빵|군고구마|히터/.test(s)) return "기온이 높은데 추위 얘기";
    if (w.temp <= 10 && /폭염|열대야|무더위|찜통|땀 ?(뻘뻘|줄줄|범벅)|에어컨 ?(빵빵|세|켜)|빙수|덥다|더워|더운/.test(s)) return "기온이 낮은데 더위 얘기";
    const cat = weatherCat(w);
    if (cat !== "rain" && /비\s?(가\s?)?(오|와|옴|온다|내려|내리|쏟)|빗길|빗소리|장대비|소나기|우산/.test(s)) return "비가 안 오는데 비 얘기";
    if (cat !== "snow" && /눈\s?(이\s?)?(오|와|옴|온다|내려|내리)|첫눈|폭설/.test(s)) return "눈이 안 오는데 눈 얘기";
    if ((cat === "rain" || cat === "snow") && /맑|화창|햇빛|햇살|날씨 ?(가 )?(너무 |진짜 )?좋/.test(s)) return "비·눈이 오는데 맑다고 함";
  }
  return "";
}
__name(ctxReject, "ctxReject");
function pickPool(kst) {
  const h = kst.getUTCHours();
  const weekend = isRestDay(kst);
  if (h < 6) return { key: "dawn", prob: 0.15, extra: 0 };
  if (h < 9) return weekend ? { key: "mornWe", prob: 0.5, extra: 0 } : { key: "mornRushWd", prob: 1, extra: 0.4 };
  if (h < 11) return weekend ? { key: "forenoonWe", prob: 0.6, extra: 0 } : { key: "forenoonWd", prob: 0.7, extra: 0 };
  if (h < 14) return { key: "lunch", prob: 0.9, extra: 0.2 };
  if (h < 17) return weekend ? { key: "afternoonWe", prob: 0.7, extra: 0 } : { key: "afternoonWd", prob: 0.7, extra: 0 };
  if (h < 20) return weekend ? { key: "eveWe", prob: 0.7, extra: 0 } : { key: "eveRushWd", prob: 1, extra: 0.4 };
  return weekend ? { key: "nightWe", prob: 0.7, extra: 0 } : { key: "nightWd", prob: 0.8, extra: 0 };
}
__name(pickPool, "pickPool");
var _wxCache = { at: 0, v: null };
async function getWeather() {
  // ★ 2026-10-05: 10분 캐시 — 글·댓글·대화·반응이 모두 날씨를 쓰게 됐다(호출이 몰리지 않게). 실패하면 3시간 안의 옛 값을 쓴다.
  if (_wxCache.v && Date.now() - _wxCache.at < 10 * 60e3) return _wxCache.v;
  try {
    const u = "https://api.open-meteo.com/v1/forecast?latitude=37.57&longitude=126.98&current=temperature_2m,weather_code&timezone=Asia%2FSeoul";
    const r = await fetch(u, { signal: AbortSignal.timeout(5e3) });
    if (!r.ok) throw new Error("http");
    const d = await r.json();
    if (!d || !d.current) throw new Error("nodata");
    _wxCache = { at: Date.now(), v: { temp: Math.round(d.current.temperature_2m), code: d.current.weather_code || 0 } };
    return _wxCache.v;
  } catch (e) {
    return (_wxCache.v && Date.now() - _wxCache.at < 3 * 3600e3) ? _wxCache.v : null;
  }
}
__name(getWeather, "getWeather");
function weatherCat(w) {
  if (!w) return null;
  const c = w.code;
  if (c >= 51 && c <= 67 || c >= 80 && c <= 82 || c >= 95) return "rain";
  if (c >= 71 && c <= 77 || c === 85 || c === 86) return "snow";
  if (w.temp >= 30) return "hot";
  if (w.temp <= 0) return "cold";
  return null;
}
__name(weatherCat, "weatherCat");
function fill(s, ctx) {
  return s.replace(/\{line\}/g, ctx.line).replace(/\{stn\}/g, ctx.stn).replace(/\{stn2\}/g, ctx.stn2).replace(/\{temp\}/g, ctx.temp);
}
__name(fill, "fill");
// ══════════════════════════════════════════════════════════════════════
// ★ 2026-09-24: 게시글도 실시간소통(generateTalks/geminiTalks)처럼 Gemini로
//   먼저 새 글을 시도한다. 그동안 게시글은 CHAT_POSTS(25개)+POOLS(슬롯당 3~8개)
//   뿐인 고정 템플릿이라 실시간소통보다 훨씬 빨리 소재가 바닥났다.
//   GEMINI_KEY가 없거나 호출이 실패하면 기존 템플릿 경로로 100% 그대로 폴백한다
//   (generatePosts 안의 기존 분기는 손대지 않음 — 기존 동작 보존).
// ══════════════════════════════════════════════════════════════════════
async function geminiPosts(env, n, recentTitles, kst, w, wcat, topics, hotWords) {
  if (!env.GEMINI_KEY || n <= 0) return null;
  try {
    // ★ 2026-10-03: '맑음! 왠지 ○○ 땡기네' 틀이 거의 매 글에 나왔다(붕어빵·뻥튀기·솜사탕 반복).
    //   원인: 프롬프트에 기온·날씨를 매번 넣고, 소재 지시가 없어 모델이 같은 틀로 수렴.
    //   → 날씨는 비·눈·폭염·한파처럼 특이할 때만 알려주고, 글마다 서로 다른 소재(topics)를 배정한다.
    const wtxt = (wcat === "rain" ? "비 옴" : wcat === "hot" ? "폭염" : wcat === "cold" ? "한파" : wcat === "snow" ? "눈 옴" : "");
    const avoid = recentTitles.slice(0, 60).join(" / ") || "(없음)";
    const tp = (topics && topics.length) ? topics.slice(0, n) : [];
    const topicTxt = tp.length ? "\n각 글의 소재(순서대로 하나씩, 반드시 이 소재로): " + tp.map(function(t, i) { return (i + 1) + ") " + t; }).join(" ") : "";
    const hotTxt = (hotWords && hotWords.length) ? "\n최근 너무 많이 쓴 단어(이번엔 쓰지 마): " + hotWords.join(", ") : "";
    const prompt = "너는 한국 지하철\xB7버스로 출퇴근\xB7통학하는 사람들이 모인 온라인 커뮤니티 게시판에 글을 쓰는 여러 명의 평범한 이용자다.\n지금: " + slotLabel(kst) + (wtxt ? ", 날씨: " + wtxt : "") + ctxBlock(kst, w, wcat) + topicTxt + hotTxt + "\n서로 다른 사람이 쓴 것처럼, 짧은 게시글 " + n + "개를 새로 써라.\n규칙:\n1. 실제 커뮤니티 게시글투 — 제목은 15~40자, 본문은 2~4문장(줄바꿈은 \\n으로 구분), 반말\xB7편한 말투, 가끔 ㅋㅋ\xB7ㅠㅠ\xB7줄임말.\n2. 지하철\xB7버스\xB7통근\xB7통학뿐 아니라 카페\xB7음식\xB7운동\xB7취미\xB7날씨\xB7계절 등 생활 소재도 섞어라.\n3. 아래 '최근에 나온 글 제목'과 겹치는 주제\xB7표현\xB7문장 틀은 피하고 매번 새로운 각도로 써라. 특히 \"날씨 한마디 + 왠지 ○○ 땡긴다\" 같은 공식 금지, 글마다 문장 구조와 첫 단어를 다르게: " + avoid + "\n4. 날씨\xB7기온\xB7요일 언급은 꼭 필요할 때만, 전체 글의 1/5 이하로. 숫자 기온을 제목에 쓰지 마라.\n5. 정치\xB7선거\xB7혐오\xB7욕설\xB7실존인물 비방 금지. 역\xB7노선 이름은 자유롭게 지어내도 됨.\nJSON 배열만 출력: [{\"t\":\"제목\",\"b\":\"본문\"}]";
    const r = await gemFetch(env, 12e3, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.95, topP: 0.95, maxOutputTokens: 4e3 } })
    });
    if (!r.ok) return null;
    const d = await r.json();
    let txt = "";
    try {
      txt = d.candidates[0].content.parts.map((p) => p.text || "").join("");
    } catch (e) {
      return null;
    }
    const arr = parseJsonArr(txt);
    if (!arr || !arr.length) return null;
    const rej = [];
    const out = arr.filter((x) => x && x.t && x.b && !aiJunk(x.t)).map((x) => ({ t: holFix(String(x.t).slice(0, 60), kst), b: holFix(String(x.b).slice(0, 400), kst) }))
      .filter((x) => { const why = ctxReject(x.t + "\n" + x.b, kst, w); if (why) { rej.push("ctx:" + why); return false; } return true; }).slice(0, n);
    out.rej = rej;
    return out;
  } catch (e) {
    return null;
  }
}
__name(geminiPosts, "geminiPosts");

// ══════════════════════════════════════════════════════════════════════
// ★ 2026-10-03: 6개월(183일) 중복 금지 원장 (post_ledger)
//   YJ 지시: "최소 6개월 동안 중복되는 말이나 게시글은 올라오면 안 돼".
//   기존엔 ① 제목이 '완전히 같은지'만 ② 최근 60일(그나마 posts 500개 상한 안)에서만 봤다 —
//   그래서 '맑음! 왠지 ○○ 땡기네'처럼 제목만 조금씩 다른 같은 틀이 매일 올라왔다.
//   원장은 posts 의 500개 상한과 무관하게 183일치를 따로 보관하고, 아래 네 가지를 막는다.
//     ① 정규화 제목 동일  ② 역·숫자·날씨·요일을 지운 '골격' 동일
//     ③ 글자 2-gram 유사도 높음(제목 0.5↑ / 제목+본문 0.55↑)
//     ④ 같은 단어 포화 — 최근 10일 제목에 이미 3번 쓴 단어(붕어빵·왠지 같은 것)는 당분간 금지
//   원장이 비어 있으면 현재 posts 로 한 번 채운다(마이그레이션).
// ══════════════════════════════════════════════════════════════════════
var LEDGER_DAYS = 183;
var _ledgerReady = false;
async function ensureLedger(env) {
  if (_ledgerReady) return;
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS post_ledger (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, title TEXT NOT NULL, body TEXT)").run();
  await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_post_ledger_ts ON post_ledger(ts)").run();
  const c = await env.DB.prepare("SELECT COUNT(*) AS n FROM post_ledger").first();
  if (c && c.n === 0) {
    await env.DB.prepare("INSERT INTO post_ledger (ts, title, body) SELECT ts, title, substr(body,1,160) FROM posts").run();
  }
  _ledgerReady = true;
}
__name(ensureLedger, "ensureLedger");
var _STN_RE = null;
function stnRe() {
  if (_STN_RE) return _STN_RE;
  const set = {};
  LINES.forEach(function(L) { set[L.name] = 1; L.stns.forEach(function(x) { set[x] = 1; }); });
  const words = Object.keys(set).sort(function(a, b) { return b.length - a.length; });
  _STN_RE = new RegExp(words.join("|"), "g");
  return _STN_RE;
}
// 골격: 역·노선·숫자·날씨·시간대·요일·기호를 지운 글자열
var _FRAME_STRIP = /(맑음|맑은|맑고|맑다|흐림|흐린|비오는|비가|눈오는|날씨|기온|오늘은|오늘|어제|내일|아침|점심|저녁|새벽|오전|오후|퇴근길|출근길|퇴근|출근|월요일|화요일|수요일|목요일|금요일|토요일|일요일|월욜|화욜|수욜|목욜|금욜|불금|주말|평일|지하철|버스)/g;
function skelText(t) {
  return String(t == null ? "" : t)
    .replace(stnRe(), "")
    .replace(/[0-9]+/g, "")
    .replace(_FRAME_STRIP, "")
    .replace(/[^가-힣a-zA-Z]/g, "")
    .replace(/[ㅋㅎㅠㅜ]/g, "")
    .toLowerCase();
}
__name(skelText, "skelText");
function bigrams(t) {
  const set = {};
  const n = t.length;
  if (n < 2) { if (n === 1) set[t] = 1; return set; }
  for (let i = 0; i < n - 1; i++) set[t.substr(i, 2)] = 1;
  return set;
}
__name(bigrams, "bigrams");
function jaccard(a, b) {
  let inter = 0, na = 0, nb = 0;
  for (const k in a) { na++; if (b[k]) inter++; }
  for (const k in b) nb++;
  const uni = na + nb - inter;
  return uni ? inter / uni : 0;
}
__name(jaccard, "jaccard");
var _TOK_STOP = {};
"지하철 버스 사람 진짜 너무 정말 다들 이번 우리 요즘 역시 그냥 오랜 하루 오늘 내일 어제 아침 점심 저녁 새벽 퇴근 출근 날씨 이제 지금 계속 완전 갑자 혹시 다음 마지 처음 하나 그리 하지 그래 근데 그런 이런 저런 어떤 모든 같은 아직 다시 결국 가끔 자주 항상 매일 같이 많이 조금 열차 환승 승강 이용 승객 운행".split(" ").forEach(function(w) { _TOK_STOP[w] = 1; });
// 제목 → 어간 토큰(앞 2글자). 조사·어미 때문에 '붕어빵을/붕어빵이'가 갈라지지 않게 앞 2글자로 묶는다.
function titleToks(title) {
  const out = [];
  String(title || "").replace(stnRe(), " ").replace(/[0-9]+/g, " ").split(/[^가-힣]+/).forEach(function(w) {
    if (w.length < 2) return;
    const k = w.slice(0, 2);
    if (_TOK_STOP[k] || _TOK_STOP[w]) return;
    out.push(k);
  });
  return out;
}
__name(titleToks, "titleToks");
// 글머리 4글자(역·숫자 제거) — "오늘 날씨 N도!"처럼 같은 첫머리가 계속 반복되는 걸 막는 용도
function openerKey(t) {
  return String(t || "").replace(stnRe(), "").replace(/[0-9]+/g, "").replace(/[^가-힣]/g, "").slice(0, 4);
}
var OPENER_MAX = 2;
function normExact(t) {
  return String(t).replace(/[\s.,!?~…·ㅋㅎㅠㅜ()]/g, "");
}
async function loadLedger(env) {
  await ensureLedger(env);
  const cut = Date.now() - LEDGER_DAYS * 24 * 3600 * 1e3;
  try { await env.DB.prepare("DELETE FROM post_ledger WHERE ts < ?").bind(cut).run(); } catch (e) {}
  const rs = await env.DB.prepare("SELECT ts, title, body FROM post_ledger WHERE ts >= ? ORDER BY id DESC LIMIT 20000").bind(cut).all();
  const rows = rs.results || [];
  const idx = { exact: {}, skel: {}, items: [], tokCount: {}, openCount: {} };
  const tokCut = Date.now() - 10 * 24 * 3600 * 1e3;
  rows.forEach(function(r) { ledgerAdd(idx, r.title, r.body, r.ts >= tokCut); });
  return { idx, rows };
}
__name(loadLedger, "loadLedger");
function ledgerAdd(idx, title, body, recent) {
  idx.exact[normExact(title)] = 1;
  const sk = skelText(title);
  if (sk) idx.skel[sk] = 1;
  idx.items.push({ tb: bigrams(sk), fb: bigrams(skelText(String(title) + " " + String(body || ""))) });
  if (recent) {
    const seenHere = {};
    titleToks(title).forEach(function(k) { if (!seenHere[k]) { seenHere[k] = 1; idx.tokCount[k] = (idx.tokCount[k] || 0) + 1; } });
    const ok = openerKey(title);
    if (ok.length >= 3) idx.openCount[ok] = (idx.openCount[ok] || 0) + 1;
  }
}
__name(ledgerAdd, "ledgerAdd");
var TOK_SATURATION = 3;
// 중복이면 사유 문자열, 아니면 null
function titleSane(t, b) {
  // 깨진 글 차단(실제로 "estranho...", "핑계 대고  }+" 같은 제목이 올라온 적 있음)
  const s = String(t || "") + " " + String(b || "");
  if (/[{}\[\]<>|\\]/.test(s)) return false;
  if (/[A-Za-z]{5,}/.test(s)) return false;
  if (/\s{2,}/.test(String(t || ""))) return false;
  if (String(t || "").replace(/[^가-힣]/g, "").length < 4) return false;
  return true;
}
__name(titleSane, "titleSane");
function ledgerDupReason(idx, title, body) {
  if (!titleSane(title, body)) return "garbled";
  if (idx.exact[normExact(title)]) return "same-title";
  const sk = skelText(title);
  if (sk && idx.skel[sk]) return "same-skeleton";
  const tb = bigrams(sk), fb = bigrams(skelText(String(title) + " " + String(body || "")));
  for (let i = 0; i < idx.items.length; i++) {
    const it = idx.items[i];
    if (sk.length >= 4 && jaccard(tb, it.tb) >= 0.5) return "similar-title";
    if (jaccard(fb, it.fb) >= 0.55) return "similar-body";
  }
  const ok = openerKey(title);
  if (ok.length >= 3 && (idx.openCount[ok] || 0) >= OPENER_MAX) return "opener-repeated:" + ok;
  const toks = titleToks(title), seenHere = {};
  for (let j = 0; j < toks.length; j++) {
    const k = toks[j];
    if (seenHere[k]) continue;
    seenHere[k] = 1;
    if ((idx.tokCount[k] || 0) >= TOK_SATURATION) return "word-saturated:" + k;
  }
  return null;
}
__name(ledgerDupReason, "ledgerDupReason");
function hotTokens(idx) {
  return Object.keys(idx.tokCount).filter(function(k) { return idx.tokCount[k] >= 2; }).sort(function(a, b) { return idx.tokCount[b] - idx.tokCount[a]; }).slice(0, 25);
}
__name(hotTokens, "hotTokens");
// 글마다 다른 소재를 배정해 같은 틀로 수렴하지 않게 한다
var POST_TOPICS = [
  "이어폰·헤드폰 고르는 법", "만원 지하철에서 가방 메는 법", "자리 양보 경험", "환승 통로 걷는 속도 차이", "편의점 신상 후기",
  "회사 점심 메뉴 정하기 스트레스", "학교·학원 끝나고 귀가", "출근길 팟캐스트·오디오북 추천", "책·웹툰 읽다 내릴 역 놓친 이야기", "카페 자리 전쟁",
  "운동 시작했다가 사흘 만에 포기", "러닝·헬스 후기", "자취 요리 실패담", "배달음식 vs 집밥", "반려동물 이야기",
  "넷플릭스·드라마 정주행 후기", "게임 이야기(모바일·콘솔)", "월요병 극복법", "연차 쓰는 날의 아침", "야근 후 귀가길 감성",
  "알바 첫 출근 기억", "취업 준비하는 요즘 일상", "시험기간 도서관 풍경", "팀 회식 문화 이야기", "상사·동료와의 소소한 에피소드",
  "스마트폰 배터리 절약", "충전기·보조배터리 분실담", "교통카드·티머니 잔액 부족 사건", "스크린도어 광고 감상", "버스 기사님 친절 사연",
  "지하철 졸다가 종점까지 간 이야기", "앉아서 가기 위한 나만의 요령", "환승 할인 알뜰 팁", "막차 놓친 날", "새벽 첫차 풍경",
  "비 오는 날 우산 이야기", "미세먼지·마스크 고민", "계절 옷차림 고민", "제철 음식 얘기", "동네 빵집·맛집 발견",
  "퇴근 후 취미생활(그림·악기·뜨개질)", "주말 나들이 코스", "여행 계획·다녀온 후기", "중고거래 후기", "이사·자취방 구하기",
  "월급날·월말 지갑 사정", "재밌는 안내방송 문구", "역 근처 길냥이", "출근길 마주치는 단골 얼굴들", "플랫폼 벤치에서 본 장면",
  "에스컬레이터 에티켓", "지하철 소리 에티켓", "지하철에서 본 독특한 패션", "하루 걸음 수 챙기기", "카톡 읽씹 고민",
  "SNS 피드 구경", "새로 산 물건 자랑", "커피·차 취향", "이번 주 소소한 행복", "학생 시절 통학 추억",
  "어릴 적 지하철 타던 기억", "공연·전시 다녀온 후기", "영화관 다녀온 후기", "아침형 인간 도전기", "수면 부족 해결법",
  "점심시간 산책 코스", "회사 근처 숨은 장소", "도시락 싸기 도전", "다이어트 중 유혹"
];
function pickTopics(n) {
  return POST_TOPICS.slice().sort(function() { return Math.random() - 0.5; }).slice(0, n);
}
__name(pickTopics, "pickTopics");
async function generatePosts(env) {
  const kst = kstNow();
  const dc = dayCtx(kst);
  const slot = pickPool(kst);
  let count = 0;
  if (Math.random() < slot.prob) count++;
  if (slot.extra && Math.random() < slot.extra) count++;
  if (count === 0) return { made: 0, slot: slot.key };
  const w = await getWeather();
  const wcat = weatherCat(w);
  let recent = [];
  // ★ 2026-09-27 (YJ 지시로 실측 점검 중 발견): 아래 D1 조회가 실패하면 catch가 아무 말 없이
  //   삼켜서 recent=[]로 계속 진행했다 — 그러면 이번 주기는 '최근 글이 하나도 없는 것처럼'
  //   동작해 중복방지(seen/recent 검사)가 통째로 꺼진 채로 새 글을 만들게 된다. 실제로
  //   "칼퇴 성공한 날은 지하철도 즐겁다"(id 2107→2108) 같은 완전히 동일한 제목이 20분
  //   간격(크론 주기와 일치)으로 두 번 올라온 걸 실측 확인했는데, 이 조용한 폴백이
  //   유력한 원인이다(다른 스킵 조건들처럼 조용히 넘어가는 대신, 여기선 중복방지 없이
  //   글을 쓰느니 이번 주기를 건너뛰는 게 낫다 — 09-22 방침과 같은 방향).
  let recentOk = false;
  let ledger = null;
  try {
    ledger = await loadLedger(env);
  } catch (e) {
    // ★ 원장을 못 읽으면 6개월 중복 검사를 못 하므로 이번 주기는 쓰지 않는다(조용히 중복을 만드는 것보다 낫다)
    console.log("[board-writer][posts] 원장 로드 실패, 이번 주기는 건너뜀:", e.message);
    return { made: 0, slot: slot.key, skipped: "ledger-failed" };
  }
  try {
    // ★ 2026-09-22: 150개 → 500개(MAX_POSTS 전체) — 여기까지는 이미 배포돼 있던 수정.
    // ★ 2026-09-24: 개수(500개) 창 → 60일(시간) 창으로 다시 전환.
    //   템플릿 풀이 CHAT_POSTS+POOLS 합쳐 90개 안팎뿐이라, 글이 활발히 쌓이는
    //   시기엔 최근 500개 '안'에 90개 템플릿이 전부 들어차버린다 — 그러면 그 뒤로는
    //   매 주기 '신선한 템플릿 없음'으로 계속 건너뛰기만 반복하고, 새 글이 영원히
    //   안 올라온다(오래된 글이 밀려나려면 새 글이 계속 들어와야 하는데, 새 글이
    //   안 만들어지니 창이 절대 안 비워지는 순환). 시간 창은 며칠만 지나도
    //   오래된 글이 자연히 '다시 써도 되는' 상태로 풀려서 이 교착을 막는다.
    //   (아래 geminiPosts 추가로 템플릿 풀 자체도 사실상 무한해지지만, Gemini가
    //   실패/미설정일 때의 템플릿 폴백 경로를 위해 이 안전장치는 그대로 둔다.)
    const cut = Date.now() - 60 * 24 * 3600 * 1e3;
    const rs = await env.DB.prepare("SELECT title FROM posts WHERE ts > ? ORDER BY id DESC LIMIT 2000").bind(cut).all();
    recent = (rs.results || []).map((r) => r.title);
    // ★ 템플릿 재사용 검사·프롬프트 회피 목록도 원장(183일)을 기준으로 한다
    ledger.rows.forEach(function(r) { if (recent.indexOf(r.title) < 0) recent.push(r.title); });
    recentOk = true;
  } catch (e) {
    console.log("[board-writer][posts] recent-titles 조회 실패, 이번 주기는 건너뜀:", e.message);
  }
  if (!recentOk) return { made: 0, slot: slot.key, skipped: "recent-fetch-failed" };
  const norm = /* @__PURE__ */ __name(function(s) {
    return String(s).replace(/[\s.,!?~…·ㅋㅎㅠㅜ()]/g, "");
  }, "norm");
  const seen = {};
  recent.forEach(function(t) {
    var k = norm(t);
    if (k) seen[k] = 1;
  });
  // ★ 2026-09-24: Gemini(설정돼 있으면)로 먼저 새 글을 시도한다. 실패/미설정이면
  //   아래 기존 분기(CHAT_POSTS 60% / POOLS·WEATHER_POOLS 40%)로 그대로 폴백한다.
  let aiPosts = null, aiAsked = 0;
  try {
    // 후보를 넉넉히(필요한 수의 3배, 최대 9) 받아 원장 검사를 통과한 것만 쓴다
    const want = Math.min(9, count * 3);
    aiAsked = want;
    aiPosts = await geminiPosts(env, want, ledger.rows.slice(0, 60).map(function(r) { return r.title; }), kst, w, wcat, pickTopics(want), hotTokens(ledger.idx));
  } catch (e) {
    aiPosts = null;
  }
  if (!aiPosts) { try { await gemDiscover(env); } catch (e) {} }
  let made = 0, kinds = [], rejected = (aiPosts && aiPosts.rej) ? aiPosts.rej.slice() : [];
  const aiQ = aiPosts ? aiPosts.slice() : [];
  for (let i = 0; i < count; i++) {
    let title = "", body = "", kind = "", usedStn = "";
    let aiCand = null;
    while (aiQ.length) {
      const c = aiQ.shift();
      if (!c || !c.t) continue;
      const why = seen[norm(c.t)] ? "same-title" : ledgerDupReason(ledger.idx, c.t, c.b);
      if (!why) { aiCand = c; break; }
      rejected.push(why);
    }
    if (aiCand) {
      kind = "ai";
      title = aiCand.t;
      body = aiCand.b;
    } else if (Math.random() < 0.6) {
      kind = "chat";
      var order = CHAT_POSTS.slice().sort(() => Math.random() - 0.5);
      var pick = null;
      for (const c of order) {
        if (!seen[norm(c.t)] && !ctxReject(holFix(c.t + "\n" + c.b, kst), kst, w, dc)) {
          pick = c;
          break;
        }
      }
      // ★ 2026-09-22: 예전엔 신선한 글이 없으면 rnd(CHAT_POSTS)로 '무조건' 아무거나
      //   골라서 이미 썼던 글을 그대로 다시 올렸다(YJ 제보 원인 1). 억지로 반복해서
      //   보여주느니, 이번 주기엔 그냥 건너뛴다 — 20분 뒤 다음 주기에 다시 시도된다.
      if (!pick) { continue; }
      title = holFix(pick.t, kst);
      body = holFix(pick.b, kst);
    } else {
      kind = "daily:" + slot.key;
      let pool = POOLS[slot.key] || POOLS.lunch;
      if (wcat && WEATHER_POOLS[wcat] && Math.random() < 0.35) {
        pool = WEATHER_POOLS[wcat];
        kind = "weather:" + wcat;
      }
      const L = rnd(LINES);
      const stn = rnd(L.stns);
      let stn2 = rnd(L.stns);
      if (stn2 === stn) stn2 = L.stns[(L.stns.indexOf(stn) + 1) % L.stns.length];
      const ctx = { line: L.name, stn, stn2, temp: w ? String(w.temp) : "30" };
      usedStn = stn;   // ★ 2026-09-27: 아래 제목 중복 태그가 이 값을 그대로 쓰게 한다(본문과 항상 같은 역이 되도록)
      let tpl = null;
      const ord2 = pool.slice().sort(() => Math.random() - 0.5);
      for (const cand of ord2) {
        const rx = tplRegex(cand.t);
        if (!recent.some((t) => rx.test(t || "")) && !ctxReject(holFix(fill(cand.t, ctx) + "\n" + fill(cand.b, ctx), kst), kst, w, dc)) {
          tpl = cand;
          break;
        }
      }
      // ★ 2026-09-22: 여기도 동일 — 억지 rnd(pool) 반복 대신 이번엔 건너뛴다(YJ 제보 원인 2).
      if (!tpl) { continue; }
      title = holFix(fill(tpl.t, ctx), kst);
      body = holFix(fill(tpl.b, ctx), kst);
    }
    if (!title) continue;
    if (seen[norm(title)]) {
      if (kind.indexOf("daily:") === 0 || kind.indexOf("weather:") === 0) {
        // ★ 2026-09-27 (YJ 지시로 실측 확인 중 발견): 여기서 붙이던 구분용 역명이 본문을
        //   채운 역(usedStn/ctx.stn)과 무관하게 새로 무작위로 뽑혀서, 실제로 제목엔
        //   "(김포공항)"인데 본문은 "인천시청 계단을..."처럼 서로 다른 역이 나오는 글이
        //   production에 실제로 올라간 걸 확인함(id 2112·2113). 구분 태그는 반드시
        //   이 글이 실제로 쓴 역(usedStn)이어야 본문과 어긋나지 않는다.
        var s2 = usedStn || rnd(rnd(LINES).stns);
        if (title.indexOf(s2) < 0) title = title + " (" + s2 + ")";
        if (seen[norm(title)]) continue;
      } else continue;
    }
    {
      // ★ 템플릿 글도 같은 원장 검사를 통과해야 한다(AI 글은 위에서 이미 통과)
      const why2 = kind === "ai" ? null : ledgerDupReason(ledger.idx, title, body);
      if (why2) { rejected.push(why2); continue; }
    }
    seen[norm(title)] = 1;
    const nick = rnd(NICKS);
    const views = rndInt(15, 350);
    const likes = rndInt(0, Math.max(1, Math.floor(views / 25)));
    try {
      const info = await env.DB.prepare("SELECT name FROM pragma_table_info('posts')").all();
      const cols = (info.results || []).map((r) => r.name);
      const data = {
        nick,
        title,
        body,
        cat: "잡담",
        ts: Date.now(),
        views,
        likes,
        lols: 0,
        sads: 0,
        link: ""
      };
      const use = Object.keys(data).filter((k) => cols.indexOf(k) >= 0);
      if (!use.length) throw new Error("posts 테이블 컬럼 불일치");
      const sql = "INSERT INTO posts (" + use.join(",") + ") VALUES (" + use.map(() => "?").join(",") + ")";
      await env.DB.prepare(sql).bind(...use.map((k) => data[k])).run();
      try {
        await env.DB.prepare("INSERT INTO post_ledger (ts, title, body) VALUES (?, ?, ?)").bind(data.ts, title, String(body).slice(0, 160)).run();
        ledgerAdd(ledger.idx, title, body, true);
      } catch (e) {
        console.log("[board-writer] 원장 기록 실패:", e.message);
      }
      made++;
      kinds.push(kind);
    } catch (e) {
      console.log("[board-writer] INSERT 실패:", e.message);
    }
  }
  try {
    await env.DB.prepare("DELETE FROM posts WHERE id NOT IN (SELECT id FROM posts ORDER BY id DESC LIMIT " + MAX_POSTS + ")").run();
  } catch (e) {
  }
  const pres = { made, slot: slot.key, weather: wcat || "normal", kinds, rejected };
  await bwDiag(env, "posts", { day: dc.t.ymd + (dc.t.hol ? ":" + dc.t.hol : ""), slot: slot.key, count: count, made: made, kinds: kinds, asked: aiAsked, aiGot: aiPosts ? aiPosts.length : 0, rej: rejected.slice(0, 4).map((x) => String(x).slice(0, 32)), gem: _gemLast });
  return pres;
}
__name(generatePosts, "generatePosts");

// ══════════════════════════════════════════════════════════════════════
// ★ 2026-10-03: 글 댓글도 서버가 만들어 모든 사용자에게 똑같이 보여준다 (generateComments)
//   그동안 서버 글(isServer)의 댓글은 앱이 기기마다 템플릿으로 따로 붙였다(기기마다 다르고, 원장은 30일).
//   · 최근 36시간 안의 글 중 댓글이 적은 글에 사이클마다 최대 10개를 붙인다.
//   · 댓글 시각(ts)은 다음 19분 안에 흩뿌려 저장하고, GET /comments 는 ts<=지금 인 것만 내려준다.
//   · 6개월 중복 금지: 채팅(talks)과 같은 talk_ledger 를 쓴다 — 채팅·댓글을 통틀어 같은 말이 183일 안에 다시 안 나온다.
//     (3글자 미만 추임새는 제외 — 위 talk_ledger 설명 참고)
//   · Gemini 가 없거나 실패하면 이번 주기는 댓글을 안 만든다(템플릿 반복으로 중복을 만들지 않기 위해).
// ══════════════════════════════════════════════════════════════════════
var CMT_TARGET_MAX = 12;       // 글당 서버 댓글 상한
var CMT_PER_CYCLE = 10;        // 한 사이클에 새로 붙이는 최대 댓글 수
async function geminiComments(env, posts, perPost, kst, w, wcat) {
  if (!env.GEMINI_KEY || !posts.length) return null;
  try {
    const list = posts.map(function(p) { return "[" + p.id + "] 제목: " + p.title + "\n본문: " + String(p.body || "").slice(0, 160).replace(/\n/g, " / "); }).join("\n\n");
    const personas = NICKS.slice().sort(() => Math.random() - 0.5).slice(0, 12).join(", ");
    const prompt = "한국 지하철\xB7버스 이용자 커뮤니티 게시판의 글에 달리는 댓글을 쓴다. 지금: " + slotLabel(kst) + ctxBlock(kst, w, wcat) + "\n아래 글마다 서로 다른 사람이 단 것처럼 댓글을 " + perPost + "개씩 써라.\n" + list + "\n규칙:\n1. 그 글의 내용에 직접 반응(공감\xB7되묻기\xB7농담\xB7경험담\xB7추천). 글 제목을 그대로 따라 쓰지 마라.\n2. 5~40자, 반말\xB7편한 말투, ㅋㅋ\xB7ㅠㅠ 가끔. 같은 문장 틀\xB7같은 첫 단어 반복 금지(특히 \"ㅇㅈ\", \"공감\", \"맞아요\"로만 시작하지 말 것).\n3. 닉네임은 이 중에서: " + personas + "\n4. 정치\xB7혐오\xB7욕설\xB7실존인물 비방 금지.\nJSON 배열만 출력: [{\"p\":글번호,\"n\":\"닉\",\"t\":\"댓글\"}]";
    const r = await gemFetch(env, 12e3, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.95, topP: 0.95, maxOutputTokens: 4e3 } })
    });
    if (!r.ok) return null;
    const d = await r.json();
    let txt = "";
    try {
      txt = d.candidates[0].content.parts.map((p) => p.text || "").join("");
    } catch (e) {
      return null;
    }
    const arr = parseJsonArr(txt);
    if (!arr) return null;
    const ids = {};
    posts.forEach(function(p) { ids[p.id] = 1; });
    return arr.filter((x) => x && x.p != null && ids[parseInt(x.p, 10)] && x.n && x.t).map((x) => ({ post_id: parseInt(x.p, 10), nick: String(x.n).slice(0, 16), text: holFix(String(x.t).slice(0, 80).trim(), kst) })).filter((x) => !aiJunk(x.text) && !ctxReject(x.text, kst, w));
  } catch (e) {
    return null;
  }
}
__name(geminiComments, "geminiComments");
async function generateComments(env) {
  const kst = kstNow();
  const cols = await getCols(env, "comments");
  if (!cols.length) return { made: 0, skipped: "no-comments-table" };
  const cut = Date.now() - 36 * 3600e3;
  const ps = await env.DB.prepare("SELECT id, title, body FROM posts WHERE ts > ? ORDER BY id DESC LIMIT 14").bind(cut).all();
  const posts = ps.results || [];
  if (!posts.length) return { made: 0, skipped: "no-recent-posts" };
  const cnt = {};
  const cs = await env.DB.prepare("SELECT post_id, COUNT(*) AS n FROM comments WHERE post_id IN (" + posts.map(function() { return "?"; }).join(",") + ") GROUP BY post_id").bind(...posts.map(function(p) { return p.id; })).all();
  (cs.results || []).forEach(function(r) { cnt[r.post_id] = r.n; });
  // 댓글이 적은 글을 우선, 같으면 최신 글 우선. 새 글일수록 목표 개수를 높게(3~12) 잡는다.
  const cand = posts.map(function(p, i) { return { p: p, n: cnt[p.id] || 0, want: Math.max(3, CMT_TARGET_MAX - i) }; })
    .filter(function(x) { return x.n < x.want; })
    .sort(function(a, b) { return a.n - b.n; })
    .slice(0, 5);
  if (!cand.length) return { made: 0, skipped: "enough" };
  const cw = await getWeather();
  const gen = await geminiComments(env, cand.map(function(x) { return x.p; }), 3, kst, cw, weatherCat(cw));
  if (!gen || !gen.length) { await bwDiag(env, "comments", { skipped: "gemini-none", gem: _gemLast }); return { made: 0, skipped: "gemini-none" }; }
  let kept;
  try {
    const clean = gen.filter(function(g) { return g.text && !containsBadWord(g.text) && !containsBadWord(g.nick); });
    kept = await talkLedgerFilter(env, clean);
  } catch (e) {
    console.log("[board-writer][comments] 원장 처리 실패, 이번 주기는 건너뜀:", e.message);
    return { made: 0, skipped: "ledger-failed" };
  }
  // 글마다 상한을 넘기지 않게 자르고, 한 사이클 총량도 제한
  const per = {};
  kept = kept.filter(function(g) {
    const have = (cnt[g.post_id] || 0) + (per[g.post_id] || 0);
    if (have >= CMT_TARGET_MAX) return false;
    per[g.post_id] = (per[g.post_id] || 0) + 1;
    return true;
  }).slice(0, CMT_PER_CYCLE);
  const SPAN = 19 * 60e3;
  let made = 0;
  for (const g of kept) {
    const ts = Date.now() + 20e3 + Math.floor(Math.random() * SPAN);
    try {
      const data = { post_id: g.post_id, nick: g.nick, body: g.text, ts };
      const use = Object.keys(data).filter((k) => cols.indexOf(k) >= 0);
      await env.DB.prepare("INSERT INTO comments (" + use.join(",") + ") VALUES (" + use.map(() => "?").join(",") + ")").bind(...use.map((k) => data[k])).run();
      made++;
    } catch (e) {
      console.log("[board-writer] 댓글 INSERT 실패:", e.message);
      break;
    }
  }
  await bwDiag(env, "comments", { made: made, asked: gen.length, kept: kept.length, gem: _gemLast });
  return { made, asked: gen.length, kept: kept.length };
}
__name(generateComments, "generateComments");
var MAX_TALKS = 400;
function talkCount(kst) {
  const h = kst.getUTCHours();
  const weekend = isRestDay(kst);
  let n;
  if (h < 6) n = rndInt(8, 20);
  else if (h < 9) n = weekend ? rndInt(40, 70) : rndInt(140, 200);
  else if (h < 11) n = weekend ? rndInt(50, 80) : rndInt(80, 120);
  else if (h < 14) n = weekend ? rndInt(70, 110) : rndInt(130, 190);
  else if (h < 17) n = weekend ? rndInt(60, 100) : rndInt(80, 120);
  else if (h < 20) n = weekend ? rndInt(70, 110) : rndInt(140, 200);
  else if (h < 23) n = rndInt(70, 110);
  else n = rndInt(20, 40);
  return n;
}
__name(talkCount, "talkCount");
function slotLabel(kst) {
  const h = kst.getUTCHours();
  const c = dayCtx(kst), t = c.t;
  let tm;
  if (h < 6) tm = "새벽";
  else if (h < 9) tm = "출근 시간";
  else if (h < 11) tm = "오전";
  else if (h < 14) tm = "점심시간";
  else if (h < 17) tm = "오후";
  else if (h < 20) tm = "퇴근 시간";
  else tm = "밤";
  // ★ 2026-10-05: '월요일 (평일)'로 나가던 개천절 대체공휴일 — 날짜·요일·공휴일 이름·쉬는 날 여부를 함께 적는다. 쉬는 날이면 '출근 시간'은 '이른 아침'.
  if (t.rest && tm === "출근 시간") tm = "이른 아침";
  if (t.rest && tm === "퇴근 시간") tm = "저녁 무렵";
  return t.m + "월 " + t.d + "일 " + DOW_KO[t.dow] + "요일" + (t.hol ? "(" + t.hol + ")" : "") + " " + tm + (t.rest ? " (쉬는 날)" : " (평일)");
}
__name(slotLabel, "slotLabel");
var TALK_DIALOGS = {
  rush: [
    ["{stn} 지금 사람 터짐", "ㄹㅇ 방금 두 대 보냄", "다들 힘내라…", "급행은 좀 낫냐", "급행이 더 심함 ㅋㅋ", "오늘따라 왜 이럼"],
    ["{line} 또 지연이냐", "안내방송 나옴?", "앞 열차 간격 조정이래", "맨날 간격 조정 ㅋㅋ", "지각이다 지각"],
    ["자리 앉은 사람 오늘 운세 무엇", "부럽다", "나는 세 정거장째 서있음", "{stn}쯤 되면 좀 빠짐", "거기까지가 고비지"],
    ["에어컨 빵빵한 칸 찾음", "몇 번째 칸?", "중간쯤이 시원함", "약냉방칸은 피해라", "ㅇㅈ 거긴 사우나"]
  ],
  lunch: [
    ["점심 뭐 먹지", "국밥 ㄱ?", "어제도 국밥이었잖아 ㅋㅋ", "그럼 돈까스", "{stn} 근처 돈까스 맛집 있음?", "역 3번출구 쪽에 하나 있음"],
    ["웨이팅 30분이래…", "다른 데 가자", "이 시간에는 어딜 가나 똑같음", "편의점 도시락 각", "그것도 나쁘지 않지"],
    ["식후 커피는 국룰", "아아 vs 라떼", "이 날씨엔 무조건 아아", "인정", "커피 없인 오후 못 버팀"]
  ],
  day: [
    ["오후 되니까 졸리다", "커피 마셨는데도 잠옴", "3시가 제일 고비", "퇴근까지 세 시간…", "파이팅"],
    ["외근 나왔는데 지하철 한산해서 좋다", "이 시간이 꿀이지", "앉아서 가는 지하철 오랜만", "부럽", "러시아워만 피하면 살만함"]
  ],
  evening: [
    ["칼퇴 성공", "부럽다 난 아직 회사", "오늘은 일찍 들어가서 쉬어야지", "{stn}쪽 벌써 붐빔?", "붐비기 시작함 서둘러"],
    ["저녁 약속 가는 길", "뭐 먹으러 감?", "고기 먹으러 ㅋㅋ", "좋겠다 난 집밥", "집밥이 최고임 사실"],
    ["퇴근길 노래 추천 좀", "요즘 차트 틀어놓으면 무난함", "팟캐스트도 괜찮음", "내일 출근 생각하면 벌써 피곤", "그 생각은 내일 하자"]
  ],
  night: [
    ["이제 집 가는 사람?", "야근 끝났다…", "수고했어요", "막차 시간 확인들 하셈", "아직 여유 있음"],
    ["오늘 하루 순삭", "내일이 벌써 무섭다", "자기 전에 뭐라도 하나 하자", "치맥 각인데", "참아라 ㅋㅋ"]
  ],
  dawn: [
    ["이 시간에 깨있는 사람 있음?", "야근 끝나고 집 가는 중", "고생했다 진짜", "첫차까지 버틴다", "다들 무사귀가"],
    ["새벽 지하철은 조용해서 좋음", "약간 감성적이 됨", "노래 들으면서 가는 중", "푹 쉬어요 다들"]
  ],
  weekendNight: [
    ["주말 잘 보냈냐", "ㅇㅇ 하루 순삭", "나는 집에서 뒹굴", "그것도 완벽한 주말이지", "내일 걱정은 내일 하자"],
    ["일요일 밤 특유의 싱숭생숭함", "이 기분 뭔지 다 알잖아 ㅋㅋ", "야식이나 시키자", "치킨 콜?", "살은 주말에 안 찐다는 설"],
    ["주말 마무리 뭐함?", "넷플 보는 중", "나는 일찍 잘 준비", "부지런하네", "내일을 위한 투자임"]
  ],
  weekendDay: [
    ["주말인데 다들 어디 감?", "{stn} 나들이 중", "날씨 좋아서 나옴", "집이 최고인 사람도 있음 ㅋㅋ", "그것도 인정"],
    ["주말 지하철 여유롭다", "평일이랑 완전 다름", "앉아서 가는 게 이렇게 좋은 거였나", "주말엔 시간도 천천히 가는 느낌"]
  ],
  rain: [
    ["비 쏟아진다", "우산 없는데 ㅠㅠ", "편의점 우산 사셈", "집에 편의점 우산만 다섯 개임 ㅋㅋ", "{stn} 출구 우산 정체 심함"],
    ["비 오니까 지하철이 꿉꿉하네", "습기 장난 아님", "그래도 버스보다 낫다", "ㅇㅈ 도로 막힐 듯"]
  ],
  hot: [
    ["밖에 {temp}도 실화냐", "익는다 익어", "지하철 에어컨이 구원임", "내리기 싫다 ㅋㅋ", "물 챙겨 다니셈"],
    ["등에 땀 줄줄", "오늘 최고기온 몇 도래?", "{temp}도 넘는대", "여름 싫다…", "겨울엔 여름이 그리울걸"]
  ],
  cold: [
    ["플랫폼 개추움", "발 얼겠다", "히터 자리 앉으면 천국", "그 자리 경쟁 치열함 ㅋㅋ", "목도리 필수"],
    ["한파에 지하철 기다리는 거 고문임", "스크린도어 있는 역이 최고", "{line}은 좀 나은 편", "겨울아 빨리 가라"]
  ]
};
function pickDialogKey(kst, wcat) {
  if (wcat === "rain") return Math.random() < 0.5 ? "rain" : null;
  if (wcat === "hot") return Math.random() < 0.4 ? "hot" : null;
  if (wcat === "cold") return Math.random() < 0.4 ? "cold" : null;
  return null;
}
__name(pickDialogKey, "pickDialogKey");
function slotDialogKey(kst) {
  const h = kst.getUTCHours();
  const weekend = isRestDay(kst);
  if (h < 6) return "dawn";
  if (weekend) return h < 18 ? "weekendDay" : "weekendNight";
  if (h < 9) return "rush";
  if (h < 14) return "lunch";
  if (h < 17) return "day";
  if (h < 20) return "evening";
  return "night";
}
__name(slotDialogKey, "slotDialogKey");
function _slotTopicsBase(kst) {
  const h = kst.getUTCHours();
  const we = isRestDay(kst);
  if (h < 6) return { ok: "새벽 감성, 야간 알바\xB7야근 귀가, 잠 안 옴, 첫차 기다림", no: "점심 메뉴, 퇴근 러시" };
  if (we) {
    if (h < 11) return { ok: "주말 늦잠, 브런치, 나들이 준비, 약속 잡기", no: "출근, 수업, 회사, 학교" };
    if (h < 14) return { ok: "주말 점심, 나들이 중, 카페, 약속\xB7데이트", no: "회사, 수업, 야근" };
    if (h < 18) return { ok: "주말 오후 나들이, 카페, 쇼핑, 집콕, 낮잠", no: "점심 메뉴 고르기(지남), 회사, 수업" };
    return { ok: "주말 저녁 귀가, 저녁 약속, 일요일 밤 월요병, 야식", no: "점심, 출근, 수업" };
  }
  if (h < 9) return { ok: "출근\xB7등교 러시, 지각 위기, 만원 지하철\xB7버스, 아침잠, 1교시 걱정", no: "점심 메뉴, 퇴근" };
  if (h < 11) return { ok: "오전 수업\xB7업무, 회의, 졸림, 커피 수혈, 과제 마감", no: "퇴근, 하교" };
  if (h < 14) return { ok: "점심 메뉴, 학식\xB7구내식당, 급식, 식후 커피\xB7산책", no: "출근 러시, 퇴근 러시" };
  if (h < 17) return { ok: "오후 슬럼프, 졸림, 간식, 남은 수업\xB7업무, 퇴근\xB7하교 카운트다운, 야자\xB7학원 걱정", no: "점심 메뉴 얘기(이미 지남), 아침 출근" };
  if (h < 20) return { ok: "퇴근\xB7하교 러시, 저녁 메뉴, 저녁 약속, 학원 이동, 지옥철", no: "점심 메뉴, 아침 출근" };
  return { ok: "야근, 과제\xB7시험공부, 야자 끝 귀가, 하루 마무리, 내일 걱정, 휴식", no: "점심 메뉴, 출근 러시" };
}
__name(_slotTopicsBase, "_slotTopicsBase");
function slotTopics(kst) {
  const r = _slotTopicsBase(kst);
  const c = dayCtx(kst), h = kst.getUTCHours();
  let ok = r.ok, no = r.no;
  if (c.hw) ok = ok.replace(/주말/g, "휴일");
  if (c.t.rest && h >= 18) {
    // 쉬는 날 저녁: 내일도 쉬면 월요병·출근 걱정 금지, 내일이 평일이면 휴일의 마지막 저녁
    ok = ok.replace("일요일 밤 월요병", c.tm.rest ? "내일도 쉬는 날이라 느긋한 저녁" : "휴일 마지막 저녁, 내일 출근·등교 걱정");
    if (c.tm.rest) no += ", 월요병, 내일 출근·등교";
  } else if (!c.t.rest && h >= 20 && c.tm.rest) {
    ok = ok.replace("내일 걱정", "내일 쉬는 날이라 여유(약속·한잔·야식·늦잠 계획)");
    no += ", 월요병, 내일 출근·등교";
  }
  if (c.t.rest) no += ", 오늘 출근·등교하는 것처럼 말하기";
  return { ok: ok, no: no };
}
__name(slotTopics, "slotTopics");
// ★ 2026-10-10: 모델 출력에서 JSON 배열만 뽑는다(Gemma 는 앞뒤에 설명을 붙이기도 한다) / 말줄임표 조각·이모지 범벅 같은 깨진 문장 판별
function parseJsonArr(txt) {
  let t = String(txt || "").replace(/```json|```/g, "").trim();
  try { const a = JSON.parse(t); if (Array.isArray(a)) return a; } catch (e) {}
  const i = t.indexOf("["), j = t.lastIndexOf("]");
  if (i >= 0 && j > i) { try { const a = JSON.parse(t.slice(i, j + 1)); if (Array.isArray(a)) return a; } catch (e) {} }
  return null;
}
__name(parseJsonArr, "parseJsonArr");
function aiJunk(text) {
  const t = String(text || "");
  const ell = (t.match(/…|\.{3,}/g) || []).length;
  const emo = (t.match(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu) || []).length;
  if (ell >= 2) return true;                 // "치맥… 🍗… 🤤" 같은 조각
  if (emo >= 2) return true;                 // 이모지 거의 안 쓰는 방이다
  if (t.replace(/[\s.,!?~…·ㅋㅎㅠㅜ]/g, "").length < 2) return true;   // 의미 있는 글자가 없음
  return false;
}
__name(aiJunk, "aiJunk");
var PERSONA_ROLES = ["직장인", "대학생", "고등학생", "취준생", "알바생", "대학원생", "신입사원"];
async function geminiTalks(env, n, recentTalks, kst, w, wcat, room, order) {
  if (!env.GEMINI_KEY) { _gemStat.fail++; _gemStat.last = "nokey"; return null; }
  try {
    const personas = NICKS.slice().sort(() => Math.random() - 0.5).slice(0, 8);
    recentTalks.slice(-5).forEach((t) => {
      if (t.nick && personas.indexOf(t.nick) < 0) personas.push(t.nick);
    });
    const ctx = recentTalks.slice(-20).map((t) => t.nick + ": " + t.text).join("\n") || "(대화 시작)";
    const wtxt = w ? "기온 " + w.temp + "도" + (wcat === "rain" ? ", 비" : wcat === "hot" ? ", 폭염" : wcat === "cold" ? ", 한파" : wcat === "snow" ? ", 눈" : ", 맑은 편") : "보통";
    const tp = slotTopics(kst);
    // ★ 2026-10-04 노선별 방: 그 노선 이용자 입장에서 말하되, 실시간 운행 상황은 지어내지 않는다(지연·혼잡은 이용자 제보 기능이 따로 다룬다).
    const lineRule = room ? "\n이 방은 '" + room.name + "' 이용자 방이다. 이 노선을 자주 타는 사람들의 말투와 일상(자주 가는 역: " + room.stns.join("\xB7") + ")으로 쓴다. 이 노선의 지금 운행 상황(지연\xB7사고\xB7고장\xB7운행중단\xB7얼마나 붐비는지)을 사실처럼 말하거나 지어내지 마라." + " 이 대화는 앞으로 약 6시간에 걸쳐 올라가니 특정 시각·식사 시간·'지금 막'을 단정하지 말고 " + (kst.getUTCHours() >= 20 ? "자정을 넘기는 표현(내일 아침 등)도 피한다." : "시간대가 조금 바뀌어도 어색하지 않게 쓴다.") : "";
    const personaStr = personas.map(function(p, i) {
      return p + "(" + PERSONA_ROLES[i % PERSONA_ROLES.length] + ")";
    }).join(", ");
    const prompt = "너는 한국의 지하철\xB7버스로 출퇴근하고 등하교하는 사람들이 모인 실시간 단체 오픈채팅방을 재현한다. 진짜 카톡 오픈채팅처럼 자연스럽게." + lineRule + "\n지금: " + slotLabel(kst) + ", 날씨: " + wtxt + ctxBlock(kst, w, wcat) + "\n방금 전 대화:\n" + ctx + "\n\n이 흐름을 자연스럽게 이어서 채팅 " + n + "개를 써라.\n참여자(역할 고정): " + personaStr + "\n규칙:\n1. 진짜 사람처럼. 완결된 문장 말고 실제 채팅투 — 짧게 툭툭, 오타틱한 줄임말(ㄱㄱ,ㅇㅇ,ㅇㅈ,ㄹㅇ,ㅋㅋ,ㅠ,ㄷㄷ,담,낼,걍,넘,쫌), 한 명이 두세 줄 연달아 치기도 함.\n2. 서로 진짜 대화. 앞사람 말에 대답/맞장구/되묻기/딴지/부러움/투정. 각자 혼잣말 나열 절대 금지.\n3. 직장인은 회사\xB7야근\xB7상사\xB7월급, 학생은 수업\xB7과제\xB7시험\xB7급식 얘기로 서로 티키타카 (부러워하거나 놀리거나).\n4. 지금 시간대 얘기만: " + tp.ok + ". 금지: " + tp.no + '\n5. 방금 전 대화에 나온 말\xB7소재는 절대 반복하지 마. 새 메시지에끼리도 같은 말 반복 금지.\n6. 가끔 새 화제를 누가 툭 던져서 주제가 자연스럽게 바뀌어도 됨.\n7. 정치 편들기\xB7욕설\xB7혐오\xB7실존인물 비방 금지. 이모지는 쓰지 않는다.\n8. 모든 채팅은 말이 되는 한 문장 이상. "…"로 끊긴 단어 조각이나 단어만 나열한 줄 금지.\nJSON 배열만: [{"n":"닉","t":"채팅내용","d":지연초(3~15)}]';
    const r = await gemFetch(env, 25e3, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.9, topP: 0.95, maxOutputTokens: 8e3 } })
    }, order || GEM_BULK_ORDER);
    if (!r.ok) { _gemStat.fail++; _gemStat.last = "http " + r.status; return null; }
    const d = await r.json();
    let txt = "";
    try {
      txt = d.candidates[0].content.parts.map((p) => p.text || "").join("");
    } catch (e) {
      _gemStat.fail++; _gemStat.last = "noparts"; return null;
    }
    const arr = parseJsonArr(txt);
    if (!arr || !arr.length) { _gemStat.fail++; _gemStat.last = "parse"; if (_gemLast.model) _gemDownUntil[_gemLast.model] = Date.now() + 15 * 60e3; return null; }
    _gemStat.ok++;
    return arr.filter((x) => x && x.n && x.t).map((x) => ({ nick: String(x.n).slice(0, 16), text: holFix(String(x.t).slice(0, 120), kst), d: Math.max(3, Math.min(90, parseInt(x.d, 10) || 20)) }))
      .filter((m) => { if (aiJunk(m.text)) { _gemStat.junk = (_gemStat.junk || 0) + 1; return false; } const why = ctxReject(m.text, kst, w); if (why) { _gemStat.ctxRej++; return false; } return true; }).slice(0, n);
  } catch (e) {
    _gemStat.fail++; _gemStat.last = "ex " + String((e && e.message) || e).slice(0, 40);
    return null;
  }
}
__name(geminiTalks, "geminiTalks");
function fallbackTalks(n, kst, w, wcat, room) {
  const out = [];
  const L = room || rnd(LINES);
  const ctx = { line: L.name, stn: rnd(L.stns), stn2: "", temp: w ? String(w.temp) : "30" };
  const dc = dayCtx(kst);
  let guard = 0;
  // ★ 2026-10-05: 정해진 대사도 오늘 날짜·계절·날씨와 맞는 것만 쓴다(일요일 밤 대사가 월요일 휴일에 나오는 일 방지). 맞는 게 없으면 덜 만든다.
  while (out.length < n && guard++ < 60) {
    let key = pickDialogKey(kst, wcat) || slotDialogKey(kst);
    const pool = TALK_DIALOGS[key] || TALK_DIALOGS.day;
    const dlg = rnd(pool);
    const lines = dlg.map((line) => holFix(fill(line, ctx), kst));
    if (ctxReject(lines.join("\n"), kst, w, dc)) continue;
    const who = NICKS.slice().sort(() => Math.random() - 0.5).slice(0, rndInt(3, 5));
    lines.forEach((text, i) => {
      if (out.length >= n) return;
      out.push({ nick: who[i % who.length], text: text, d: rndInt(6, 45) });
    });
  }
  return out.slice(0, n);
}
__name(fallbackTalks, "fallbackTalks");

// ══════════════════════════════════════════════════════════════════════
// ★ 2026-10-03: 실시간소통(talks) 6개월(183일) 중복 금지 원장 (talk_ledger)
//   YJ 지시: 사용자 모두가 같은 대화를 보게 하고(GET /talks), 그 대화에서도 같은 말이
//   6개월 안에 다시 나오면 안 된다. 기존엔 '최근 400줄'만 봐서 약 1시간이면 같은 말이 돌아왔다.
//   · 키 = 역·노선·숫자·기호·ㅋㅎㅠㅜ·자모(ㅇㅈ 등)를 지운 한글/영문 글자열(앞 60자)
//   · 키가 3글자 미만인 짧은 추임새("ㅇㅈ", "ㄹㅇ", "ㅋㅋ 맞음")는 6개월 규칙에서 제외한다
//     (제외하지 않으면 추임새가 한 번씩 쓰이고 나면 채팅이 말라 버린다). 이런 것은 기존
//     '최근 400줄' 검사만 받는다.
//   · 원장을 못 읽거나 쓰지 못하면 이번 주기는 대화를 만들지 않는다(조용히 중복을 만들지 않기 위해).
// ══════════════════════════════════════════════════════════════════════
var TALK_LEDGER_DAYS = 183;
var _talkLedgerReady = false;
var _talkLedgerPurgedAt = 0;
async function ensureTalkLedger(env) {
  if (_talkLedgerReady) return;
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS talk_ledger (k TEXT PRIMARY KEY, ts INTEGER NOT NULL)").run();
  await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_talk_ledger_ts ON talk_ledger(ts)").run();
  _talkLedgerReady = true;
}
__name(ensureTalkLedger, "ensureTalkLedger");
function talkKey(text) {
  return String(text == null ? "" : text)
    .replace(stnRe(), "")
    .replace(/[0-9]+/g, "")
    .replace(/[^가-힣a-zA-Z]/g, "")
    .toLowerCase()
    .slice(0, 60);
}
__name(talkKey, "talkKey");
async function talkLedgerFilter(env, msgs) {
  await ensureTalkLedger(env);
  const now = Date.now();
  if (now - _talkLedgerPurgedAt > 3600e3) {
    _talkLedgerPurgedAt = now;
    try { await env.DB.prepare("DELETE FROM talk_ledger WHERE ts < ?").bind(now - TALK_LEDGER_DAYS * 24 * 3600e3).run(); } catch (e) {}
  }
  const keyed = msgs.map(function(m) { return { m: m, k: talkKey(m.text) }; });
  const uniq = {};
  keyed.forEach(function(x) { if (x.k.length >= 3) uniq[x.k] = 1; });
  const keys = Object.keys(uniq);
  const have = {};
  for (let i = 0; i < keys.length; i += 90) {
    const part = keys.slice(i, i + 90);
    const rs = await env.DB.prepare("SELECT k FROM talk_ledger WHERE k IN (" + part.map(function() { return "?"; }).join(",") + ")").bind(...part).all();
    (rs.results || []).forEach(function(r) { have[r.k] = 1; });
  }
  const batchSeen = {};
  const kept = [];
  const toMark = [];
  keyed.forEach(function(x) {
    if (x.k.length < 3) { kept.push(x.m); return; }
    if (have[x.k] || batchSeen[x.k]) return;
    batchSeen[x.k] = 1;
    toMark.push(x.k);
    kept.push(x.m);
  });
  for (let i = 0; i < toMark.length; i += 50) {
    const stmts = toMark.slice(i, i + 50).map(function(k) {
      return env.DB.prepare("INSERT OR IGNORE INTO talk_ledger (k, ts) VALUES (?, ?)").bind(k, now);
    });
    await env.DB.batch(stmts);
  }
  return kept;
}
__name(talkLedgerFilter, "talkLedgerFilter");
async function generateTalks(env) {
  const kst = kstNow();
  const n = talkCount(kst);
  if (n === 0) return { made: 0, reason: "dawn-quiet" };
  const w = await getWeather();
  const wcat = weatherCat(w);
  let recent = [];
  try {
    // ★ 2026-09-22: 60개 → 400개(MAX_TALKS 전체). Gemini 프롬프트용 문맥은 아래에서
    //   어차피 slice(-20)/slice(-5)로 최근 것만 잘라 쓰므로 영향 없고, 반복 방지용
    //   _seenT 판정만 훨씬 더 오래 전 대화까지 기억하게 된다(YJ 제보: 채팅이
    //   같은 말을 반복함 — 특히 Gemini 실패 시 폴백 대사가 60개짜리 창 밖으로
    //   밀려나자마자 아무 방지 없이 재사용됐다).
    const rs = await env.DB.prepare("SELECT nick, text FROM talks ORDER BY id DESC LIMIT " + MAX_TALKS).all();
    recent = (rs.results || []).reverse();
  } catch (e) {
  }
  let script = [];
  let usedAi = false;
  const BATCH = 40;
  let ctxTalks = recent.slice();
  let remaining = n;
  let batches = 0;
  while (remaining > 0 && batches < 6) {
    const take = Math.min(BATCH, remaining);
    const part = await geminiTalks(env, take, ctxTalks, kst, w, wcat);
    if (part && part.length) {
      usedAi = true;
      script = script.concat(part);
      ctxTalks = ctxTalks.concat(part.map(function(p) {
        return { nick: p.nick, text: p.text };
      })).slice(-30);
      remaining -= part.length;
    } else {
      break;
    }
    batches++;
  }
  if (script.length < n) {
    const fb = fallbackTalks(n - script.length, kst, w, wcat);
    script = script.concat(fb);
  }
  const _normT = /* @__PURE__ */ __name(function(s) {
    return String(s).replace(/[\s.,!?~…·ㅋㅎㅠㅜzZ]/g, "");
  }, "_normT");
  const _seenT = {};
  recent.forEach(function(t) {
    const k = _normT(t.text);
    if (k) _seenT[k] = 1;
  });
  script = script.filter(function(m) {
    const k = _normT(m.text);
    if (!k || _seenT[k]) return false;
    _seenT[k] = 1;
    return true;
  });
  try {
    script = await talkLedgerFilter(env, script);
  } catch (e) {
    console.log("[board-writer][talks] 원장 처리 실패, 이번 주기는 건너뜀:", e.message);
    return { made: 0, skipped: "ledger-failed" };
  }
  const SPAN = 19 * 60;
  const perMsg = script.length ? SPAN / script.length : 8;
  let cols = [];
  try {
    const info = await env.DB.prepare("SELECT name FROM pragma_table_info('talks')").all();
    cols = (info.results || []).map((r) => r.name);
  } catch (e) {
  }
  let made = 0;
  let ts = Date.now() + rndInt(2, 6) * 1e3;
  for (const msg of script) {
    var gap = Math.max(3, perMsg * (0.6 + Math.random() * 0.8));
    ts += Math.floor(gap * 1e3);
    try {
      const data = { nick: msg.nick, text: msg.text, ts };
      const use = Object.keys(data).filter((k) => cols.indexOf(k) >= 0);
      if (!use.length) break;
      const sql = "INSERT INTO talks (" + use.join(",") + ") VALUES (" + use.map(() => "?").join(",") + ")";
      await env.DB.prepare(sql).bind(...use.map((k) => data[k])).run();
      made++;
    } catch (e) {
      console.log("[board-writer] talk INSERT 실패:", e.message);
      break;
    }
  }
  try {
    await env.DB.prepare(
      "DELETE FROM talks WHERE id NOT IN (SELECT id FROM talks ORDER BY id DESC LIMIT " + MAX_TALKS + ")"
    ).run();
  } catch (e) {
  }
  return { made, planned: n, ai: usedAi, weather: wcat || "normal" };
}
__name(generateTalks, "generateTalks");
// ══════════════════════════════════════════════════════════════════════
// ★ 2026-10-04 (YJ): 노선별 실시간소통 — 각 호선 방에 AI 가 대화를 올린다. 이용자가 많은 노선일수록 글이 많다.
//   · 방별 비중(w)은 대략적인 노선 이용 규모다. 한 주기(20분)의 전체 줄 수(talkCount)를 비중대로 나눈다.
//   · 저장은 line_msgs(kind='chat', ipk='ai'). 지연·혼잡 제보(kind delay/crowd)는 만들지 않는다 → 경보 집계(lrAlerts)에 섞이지 않는다.
//   · 대화 내용에서도 그 노선의 '지금 운행 상황'을 지어내지 않도록 프롬프트에서 막는다(geminiTalks 의 lineRule).
//   · 전체 탭(GET /talks)은 이 방들의 대화를 시간순으로 모아서 내려준다. AI 글은 2일 뒤 지운다(실제 이용자 글은 14일).
//   · 6개월 중복 원장(talkLedgerFilter)은 방 구분 없이 함께 쓴다.
// ══════════════════════════════════════════════════════════════════════
var LR_MAX_AI_ROOMS = 9;
var LR_AI_ROOMS = [
  { name: "2호선", w: 10, stns: ["강남", "홍대입구", "신촌", "잠실", "성수", "사당", "건대입구"] },
  { name: "1호선", w: 6, stns: ["서울역", "시청", "종각", "구로", "부평", "인천"] },
  { name: "5호선", w: 6, stns: ["여의도", "광화문", "천호", "왕십리", "김포공항"] },
  { name: "3호선", w: 5.5, stns: ["교대", "고속터미널", "압구정", "연신내", "양재"] },
  { name: "4호선", w: 5.5, stns: ["사당", "명동", "동대문", "혜화", "서울역"] },
  { name: "7호선", w: 5.5, stns: ["가산디지털단지", "건대입구", "상봉", "온수", "논현"] },
  { name: "9호선", w: 4, stns: ["김포공항", "여의도", "노량진", "신논현", "가양"] },
  { name: "6호선", w: 3.5, stns: ["공덕", "이태원", "합정", "월드컵경기장", "신내"] },
  { name: "수인분당선", w: 3.5, stns: ["왕십리", "서울숲", "정자", "인하대", "수원"] },
  { name: "경의중앙선", w: 3, stns: ["홍대입구", "공덕", "왕십리", "용산", "일산"] },
  { name: "8호선", w: 2.5, stns: ["잠실", "천호", "가락시장", "복정", "암사"] },
  { name: "신분당선", w: 2, stns: ["강남", "판교", "정자", "광교", "양재"] },
  { name: "공항철도", w: 1.5, stns: ["서울역", "홍대입구", "김포공항", "검암", "계양"] },
  { name: "인천1호선", w: 1.5, stns: ["부평", "인천시청", "계양", "송도"] },
  { name: "김포골드라인", w: 1.5, stns: ["김포공항", "걸포북변", "구래", "풍무"] },
  { name: "경춘선", w: 1, stns: ["청량리", "상봉", "평내호평", "가평", "춘천"] },
  { name: "GTX-A", w: 1, stns: ["수서", "성남", "동탄", "운정", "서울역"] },
  { name: "인천2호선", w: 1, stns: ["검단오류", "주안", "석남", "인천시청"] }
];
async function generateLineTalks(env) {
  const kst = kstNow();
  const total = talkCount(kst);
  if (total === 0) return { made: 0, reason: "dawn-quiet" };
  await ensureLineRoom(env);
  const w = await getWeather();
  const wcat = weatherCat(w);
  const wsum = LR_AI_ROOMS.reduce((a, r) => a + r.w, 0);
  // ★ 2026-10-05 (YJ): 호선 방이 비어 보이는 문제 — 두 가지를 고쳤다.
  //   ① 호선마다 시간당 최소 글 수(낮 9개, 새벽 2개)를 보장한다. 작은 호선은 가중치만으로는 회차마다 0~1개라 방이 비었다.
  //   ② 글을 '앞으로 4시간치' 미리 만들어 미래 시각(ts)으로 넣는다(화면은 ts<=지금 인 글만 보여 준다).
  //      방마다 "아직 안 나온 글"이 목표의 35% 밑으로 줄었을 때만 AI 를 부른다 → AI 호출이 회차×방 수에서 방당 1~2시간에 한 번으로 준다
  //      (전에는 매 20분마다 방마다 불러서 하루 한도를 몇 시간 만에 다 쓰고, 그 뒤엔 몇 개 안 되는 정형 문구가 중복 검사에 걸려 방이 비었다).
  const nowMs = Date.now();
  const floorPerHour = kst.getUTCHours() < 5 ? 2 : 6;
  const HORIZON_MIN = 360;
  const haveMap = {};
  try {
    const hs = await env.DB.prepare("SELECT line, COUNT(*) AS n, MAX(ts) AS mx FROM line_msgs WHERE kind='chat' AND ts > ?1 GROUP BY line").bind(nowMs).all();
    (hs.results || []).forEach((r) => { haveMap[r.line] = { n: r.n || 0, mx: r.mx || 0 }; });
  } catch (e) {}
  const plan = [];
  for (const room of LR_AI_ROOMS) {
    const perHour = Math.max(floorPerHour, total * 3 * room.w / wsum);
    const target = Math.round(perHour * HORIZON_MIN / 60);
    const have = (haveMap[room.name] && haveMap[room.name].n) || 0;
    if (target < 1 || have >= target * 0.35) continue;
    plan.push({ room, k: Math.min(60, Math.max(1, target - have)), perHour, ratio: have / target, startTs: Math.max(nowMs, (haveMap[room.name] && haveMap[room.name].mx) || 0) });
  }
  // ★ 2026-10-05: 한 회차에 AI 를 부르는 방은 가장 비어 있는 9개까지 — 나머지는 다음 회차(20분 뒤). Gemini 가 한꺼번에 몰려 과부하·한도에 걸리는 것을 줄인다.
  plan.sort((a, b) => a.ratio - b.ratio);
  if (plan.length > LR_MAX_AI_ROOMS) plan.length = LR_MAX_AI_ROOMS;
  _gemStat.ok = 0; _gemStat.fail = 0; _gemStat.last = ""; _gemStat.ctxRej = 0; _gemStat.junk = 0;
  // ★ 2026-10-10: Gemma 먼저, gemini-* 는 하루 예산(GEMINI_TALK_BUDGET) 안에서만 — 게시글·댓글이 쓸 한도를 남긴다
  let talkOrder = GEM_BULK_ORDER;
  const usedG = await geminiUsed24h(env);
  if (usedG >= GEMINI_TALK_BUDGET) talkOrder = GEM_BULK_ORDER.filter((m) => m.indexOf("gemma-") === 0);
  if (plan.length) await gemDiscover(env);
  const scripts = [];
  let usedAi = 0;
  for (let i = 0; i < plan.length; i += 3) {
    const part = await Promise.all(plan.slice(i, i + 3).map(async (p) => {
      let recent = [];
      try {
        const rs = await env.DB.prepare("SELECT nick, text FROM line_msgs WHERE line=?1 AND kind='chat' ORDER BY id DESC LIMIT 30").bind(p.room.name).all();
        recent = (rs.results || []).reverse();
      } catch (e) {}
      let script = [];
      if (p.k >= 4) {
        const g = await geminiTalks(env, Math.min(p.k, 60), recent, kst, w, wcat, p.room, talkOrder);
        if (g && g.length) { script = g; usedAi++; }
      }
      if (script.length < p.k) script = script.concat(fallbackTalks(p.k - script.length, kst, w, wcat, p.room));
      const seen = {};
      recent.forEach((t) => { seen[String(t.text).replace(/[\s.,!?~…·ㅋㅎㅠㅜzZ]/g, "")] = 1; });
      script = script.filter((m) => {
        const k = String(m.text).replace(/[\s.,!?~…·ㅋㅎㅠㅜzZ]/g, "");
        if (!k || seen[k] || containsBadWord(m.text) || containsBadWord(m.nick)) return false;
        seen[k] = 1;
        return true;
      });
      script.forEach((m) => { m.line = p.room.name; });
      return script;
    }));
    part.forEach((sc) => sc.forEach((m) => scripts.push(m)));
  }
  let kept;
  try {
    kept = await talkLedgerFilter(env, scripts);
  } catch (e) {
    console.log("[board-writer][linetalks] 원장 처리 실패, 이번 주기는 건너뜀:", e.message);
    await bwDiag(env, "linetalks", { err: "ledger-failed", m: String((e && e.message) || e).slice(0, 80) });
    return { made: 0, skipped: "ledger-failed" };
  }
  const byLine = {};
  kept.forEach((m) => { (byLine[m.line] = byLine[m.line] || []).push(m); });
  const stmts = [];
  const planBy = {};
  plan.forEach((p) => { planBy[p.room.name] = p; });
  for (const ln of Object.keys(byLine)) {
    const arr = byLine[ln];
    const pl = planBy[ln];
    const gapSec = Math.max(20, Math.min(900, 3600 / Math.max(1, pl ? pl.perHour : 9)));   // 글 사이 평균 간격(초). 이미 예약된 마지막 글 뒤부터 이어 붙인다
    let ts = (pl ? pl.startTs : nowMs) + rndInt(2, 6) * 1e3;
    for (const m of arr) {
      ts += Math.floor(gapSec * (0.6 + Math.random() * 0.8) * 1e3);
      stmts.push(env.DB.prepare("INSERT INTO line_msgs (line,kind,nick,text,stn,ipk,ts) VALUES (?1,'chat',?2,?3,NULL,'ai',?4)").bind(ln, m.nick, m.text, ts));
    }
  }
  let made = 0, insErr = "";
  for (let i = 0; i < stmts.length; i += 50) {
    try { await env.DB.batch(stmts.slice(i, i + 50)); made += Math.min(50, stmts.length - i); }
    catch (e) { insErr = String((e && e.message) || e).slice(0, 80); console.log("[board-writer][linetalks] INSERT 실패:", e.message); break; }
  }
  const res = { made, planned: total, rooms: Object.keys(byLine).length, planRooms: plan.length, scripts: scripts.length, kept: kept.length, aiRooms: usedAi, gem: { ok: _gemStat.ok, fail: _gemStat.fail, last: _gemStat.last, model: _gemStat.model, rej: _gemStat.ctxRej, junk: _gemStat.junk || 0, tried: _gemLast.tried, usedG: usedG }, weather: wcat || "normal" };
  if (insErr) res.insErr = insErr;
  await bwDiag(env, "linetalks", res);
  await flushGemUse(env);
  return res;
}
__name(generateLineTalks, "generateLineTalks");
// 진단 기록 — 서버 로그를 볼 수 없어서 D1 에 남긴다(최근 3일치만 유지). 조회: SELECT * FROM bw_diag ORDER BY ts DESC
var _bwDiagReady = false, _bwDiagPurgedAt = 0;
async function bwDiag(env, k, v) {
  try {
    if (!_bwDiagReady) { await env.DB.prepare("CREATE TABLE IF NOT EXISTS bw_diag (ts INTEGER NOT NULL, k TEXT, v TEXT)").run(); _bwDiagReady = true; }
    const now = Date.now();
    await env.DB.prepare("INSERT INTO bw_diag (ts, k, v) VALUES (?1, ?2, ?3)").bind(now, k, JSON.stringify(v).slice(0, 600)).run();
    if (now - _bwDiagPurgedAt > 6 * 3600e3) { _bwDiagPurgedAt = now; await env.DB.prepare("DELETE FROM bw_diag WHERE ts < ?1").bind(now - 3 * 24 * 3600e3).run(); }
  } catch (e) {}
}
__name(bwDiag, "bwDiag");
var REACT_FALLBACK = [
  "ㅇㅈ",
  "ㄹㅇ?",
  "ㅋㅋㅋ 맞음",
  "오 그래?",
  "헐 진짜?",
  "나도 그 생각함",
  "그건 좀 부럽네",
  "고생이 많다",
  "자세히 좀 ㅋㅋ",
  "어디쪽인데?",
  "인정합니다"
];
async function generateReaction(env, userNick, userText, line) {
  let recent = [];
  try {
    const rs = line
      ? await env.DB.prepare("SELECT nick, text FROM line_msgs WHERE line=?1 AND kind='chat' AND ts <= ?2 ORDER BY ts DESC, id DESC LIMIT 12").bind(line, Date.now()).all()
      : await env.DB.prepare("SELECT nick, text FROM talks WHERE ts <= ? ORDER BY ts DESC, id DESC LIMIT 12").bind(Date.now()).all();   // 아직 화면에 안 나온(미래 시각) 줄은 문맥에서 뺀다
    recent = (rs.results || []).reverse();
  } catch (e) {
  }
  const kst = kstNow();
  const rw = await getWeather();
  let replies = null;
  if (env.GEMINI_KEY) {
    try {
      const personas = NICKS.slice().sort(() => Math.random() - 0.5).slice(0, 6).map(function(p, i) {
        return p + "(" + PERSONA_ROLES[i % PERSONA_ROLES.length] + ")";
      });
      const ctx = recent.map((t) => t.nick + ": " + t.text).join("\n");
      const prompt = "한국 지하철/출퇴근 커뮤니티 실시간 단체채팅입니다. 상황: " + slotLabel(kst) + ctxBlock(kst, rw, weatherCat(rw)) + "\n최근 대화:\n" + ctx + "\n" + userNick + ": " + userText + '\n마지막에 "' + userNick + '"가 방금 보낸 메시지에 자연스럽게 반응하는 답장을 1~3개 만드세요.\n- 반드시 그 메시지 내용에 직접 반응할 것 (질문이면 답하고, 얘기면 맞장구/되묻기/농담)\n- 참여자 닉네임은 이 중에서만: ' + personas.join(", ") + '\n- 위 최근 대화에 나온 문장\xB7표현 반복 금지\n- 짧게(5~35자), 반말, ㅋㅋ/ㄷㄷ 자연스럽게. 정치/혐오/욕설 금지\n- JSON 배열만 출력: [{"n":"닉","t":"내용","d":지연초(4~40)}]';
      const r = await gemFetch(env, 1e4, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 1, maxOutputTokens: 500 } })
      });
      if (r.ok) {
        const d = await r.json();
        let txt = "";
        try {
          txt = d.candidates[0].content.parts.map((p) => p.text || "").join("");
        } catch (e) {
        }
        txt = txt.replace(/```json|```/g, "").trim();
        const arr = JSON.parse(txt);
        if (Array.isArray(arr) && arr.length) {
          replies = arr.filter((x) => x && x.n && x.t).map((x) => ({ nick: String(x.n).slice(0, 16), text: holFix(String(x.t).slice(0, 120), kst), d: Math.max(4, Math.min(40, parseInt(x.d, 10) || 12)) })).filter((m) => !ctxReject(m.text, kst, rw)).slice(0, 3);
        }
      }
    } catch (e) {
    }
  }
  // ★ 2026-10-03: 반응 문구도 6개월 원장을 통과해야 한다. 다 걸러지면 6개월 규칙에서 빠지는 짧은 추임새로 대신한다.
  if (replies && replies.length) {
    try { replies = await talkLedgerFilter(env, replies); } catch (e) { replies = null; }
  }
  const usedAi = !!(replies && replies.length);
  if (!usedAi) {
    const fb = REACT_FALLBACK.filter(function(t) { return talkKey(t).length < 3; });
    replies = [{ nick: rnd(NICKS), text: rnd(fb.length ? fb : ["ㅇㅈ"]), d: rndInt(5, 20) }];
  }
  let cols = [];
  try {
    const info = await env.DB.prepare("SELECT name FROM pragma_table_info('talks')").all();
    cols = (info.results || []).map((r) => r.name);
  } catch (e) {
  }
  let made = 0;
  let ts = Date.now();
  for (const msg of replies) {
    ts += msg.d * 1e3;
    if (line) {
      try {
        await env.DB.prepare("INSERT INTO line_msgs (line,kind,nick,text,stn,ipk,ts) VALUES (?1,'chat',?2,?3,NULL,'ai',?4)").bind(line, msg.nick, msg.text, ts).run();
        made++;
      } catch (e) { break; }
      continue;
    }
    try {
      const data = { nick: msg.nick, text: msg.text, ts };
      const use = Object.keys(data).filter((k) => cols.indexOf(k) >= 0);
      if (!use.length) break;
      const sql = "INSERT INTO talks (" + use.join(",") + ") VALUES (" + use.map(() => "?").join(",") + ")";
      await env.DB.prepare(sql).bind(...use.map((k) => data[k])).run();
      made++;
    } catch (e) {
      break;
    }
  }
  return { made, ai: usedAi };
}
__name(generateReaction, "generateReaction");
var BAD_WORDS = [
  "시발", "씨발", "시팔", "씨팔", "ㅅㅂ", "ㅂㅅ", "병신", "ㅂㅅ", "개새", "새끼", "새기", "색끼",
  "좌", "존나", "존마", "읔냨", "지랑", "ㅈㄹ", "꾠져", "닥쳐", "엿먹", "미친놓", "미친년", "또라이",
  "등신", "멍청", "버러지", "쓰레기같", "죽어", "뒤져", "듈져", "개같", "개소리", "걸레", "창녀",
  "느금", "니애미", "니미", "애미", "애비", "보지", "자지", "섬스", "강간", "fuck", "shit", "bitch", "asshole",
  "한남", "한녀", "김치녀", "된장녀", "만충", "틀딱", "급식충", "노친네", "정신병자", "장애인같"
];
function containsBadWord(text) {
  if (!text) return false;
  const t = String(text).toLowerCase().replace(/\s+/g, "");
  for (let i = 0; i < BAD_WORDS.length; i++) {
    if (t.indexOf(BAD_WORDS[i].toLowerCase()) >= 0) return true;
  }
  return false;
}
__name(containsBadWord, "containsBadWord");
// ★ 2026-09-25: "게시판 들어가면 2~3초 있다가 뜬다" 제보 원인 — /posts·/comment·/comments가
//   요청마다 pragma_table_info로 컬럼을 매번 새로 물어본 뒤(D1 왕복 1회) 본 쿼리(왕복 1회)를
//   또 날려서, 매 요청이 D1을 직렬로 두 번 왕복했다(콜드일 때 왕복당 수백ms~1초+, route-v2
//   D1 코리도조회가 느렸던 것과 같은 모양의 문제). 스키마는 운영 중 거의 안 바뀌므로
//   route-v2의 L1 메모리캐시(ROWS_CACHE)와 같은 방식으로 10분만 캐시해 두 번째 왕복을 없앤다.
var _colsCache = {};
var _COLS_TTL_MS = 10 * 60 * 1000;
async function getCols(env, table) {
  var hit = _colsCache[table];
  if (hit && Date.now() - hit.at < _COLS_TTL_MS) return hit.cols;
  var info = await env.DB.prepare("SELECT name FROM pragma_table_info('" + table + "')").all();
  var cols = (info.results || []).map(function(r) { return r.name; });
  _colsCache[table] = { cols: cols, at: Date.now() };
  return cols;
}
__name(getCols, "getCols");
// ═══════════════════════════════════════════════════════════════════════
// ★ 2026-10-08 (YJ: "내가 쓴 글은 앱 사용자 모두 보게 해줘"): 사용자 글 등록 · 신고 · 관리자 삭제
//   · POST /post   {nick,title,body,cat}  → posts 에 user=1 로 저장 → GET /posts 로 모두에게 내려간다
//   · POST /report {post_id}               → 사용자 글만 신고 가능, 서로 다른 3곳(IP)이 신고하면 hidden=1
//   · GET  /post/delete?id=&token=         → 관리자 삭제(글+댓글),  GET /reports?token= → 신고된 글 목록
//   악용 방지: 욕설 필터(기존 BAD_WORDS) · 링크/전화번호 차단 · IP당 시간 5건/하루 15건 · 같은 닉+제목 하루 1건 · 길이 제한
// ═══════════════════════════════════════════════════════════════════════
var USER_POST_CATS = ["잡담", "현장제보", "일상", "정보", "제보", "지연", "혼잡"];
var POST_PER_IP_HR = 5, POST_PER_IP_DAY = 15, REPORT_PER_IP_HR = 30, REPORT_HIDE_AT = 3;
function hasLinkOrPhone(t) {
  t = String(t || "");
  if (/(https?:\/\/|www\.|t\.me\/|open\.kakao|bit\.ly)/i.test(t)) return true;
  if (/[a-z0-9-]{2,}\.(com|net|kr|co\.kr|io|me|ly|xyz|site|info|org|app|shop|top)(\/|\b)/i.test(t)) return true;
  if (/0\d{1,2}[-.\s]?\d{3,4}[-.\s]?\d{4}/.test(t)) return true;
  return false;
}
__name(hasLinkOrPhone, "hasLinkOrPhone");
async function bumpLimit(env, key, bucket, max) {
  try {
    await env.DB.prepare("CREATE TABLE IF NOT EXISTS react_rl (k TEXT, hr INTEGER, n INTEGER, PRIMARY KEY (k, hr))").run();
    await env.DB.prepare("INSERT INTO react_rl (k,hr,n) VALUES (?1,?2,1) ON CONFLICT(k,hr) DO UPDATE SET n = n + 1").bind(key, bucket).run();
    const r = await env.DB.prepare("SELECT n FROM react_rl WHERE k=?1 AND hr=?2").bind(key, bucket).first();
    return ((r && r.n) || 1) <= max;
  } catch (e) { return false; }
}
__name(bumpLimit, "bumpLimit");
async function ownerHash(k) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("bw-owner:" + String(k)));
  return Array.from(new Uint8Array(d)).map((x) => x.toString(16).padStart(2, "0")).join("");
}
__name(ownerHash, "ownerHash");
var _userColsOk = false;
async function ensureUserPostCols(env) {
  if (_userColsOk) return;
  let cols = await getCols(env, "posts");
  for (const [c, ddl] of [["user", "ALTER TABLE posts ADD COLUMN user INTEGER DEFAULT 0"], ["hidden", "ALTER TABLE posts ADD COLUMN hidden INTEGER DEFAULT 0"], ["owner", "ALTER TABLE posts ADD COLUMN owner TEXT"]]) {
    if (cols.indexOf(c) < 0) { try { await env.DB.prepare(ddl).run(); } catch (e) {} }
  }
  delete _colsCache["posts"];
  cols = await getCols(env, "posts");
  _userColsOk = cols.indexOf("user") >= 0 && cols.indexOf("hidden") >= 0 && cols.indexOf("owner") >= 0;
}
__name(ensureUserPostCols, "ensureUserPostCols");
async function purgePostsCache(url) {
  _MEM = Object.create(null);
  try {
    await caches.default.delete(new Request(url.origin + "/posts?limit=50"));
    for (const c of USER_POST_CATS) await caches.default.delete(new Request(url.origin + "/posts?limit=50&cat=" + encodeURIComponent(c)));
  } catch (e) {}
}
__name(purgePostsCache, "purgePostsCache");
var worker_default = {
  // 크론 (20분마다)
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => { try { await ensureLineRoom(env); await env.DB.prepare("DELETE FROM line_msgs WHERE ts < ?1").bind(Date.now() - 14 * 24 * 3600 * 1000).run(); await env.DB.prepare("DELETE FROM line_reports WHERE ts < ?1").bind(Date.now() - 14 * 24 * 3600 * 1000).run(); await env.DB.prepare("DELETE FROM line_msgs WHERE ipk = 'ai' AND ts < ?1").bind(Date.now() - 2 * 24 * 3600 * 1000).run(); } catch (e) {} })());
    // ★ 2026-10-05: 게시판 글·댓글을 먼저, 호선 방은 그 다음 — Gemini 가 모자랄 때 게시판이 굶지 않게 한다. 하나가 실패해도 다음 단계는 계속한다.
    ctx.waitUntil((async () => {
      await holRefresh(env);
      try { console.log("[board-writer][posts]", JSON.stringify(await generatePosts(env))); } catch (e) { console.log("[board-writer][posts] 실패:", e && e.message); }
      try { console.log("[board-writer][comments]", JSON.stringify(await generateComments(env))); } catch (e) { console.log("[board-writer][comments] 실패:", e && e.message); }
      try { await flushGemUse(env); } catch (e) {}
      try { console.log("[board-writer][linetalks]", JSON.stringify(await generateLineTalks(env))); } catch (e) { console.log("[board-writer][linetalks] 실패:", e && e.message); }
    })());
  },
  // 수동 테스트/상태 확인
  async fetch(req, env, ctx) {
    _CTX = ctx || null;
    if (req.method === "POST") _MEM = Object.create(null);   // 글·제보·댓글을 쓰면 이 격리의 메모리 스냅샷은 모두 버린다(바로 보이게)
    const url = new URL(req.url);
    // ★ 2026-10-10: 공휴일 자료 읽기(D1 왕복 3번)가 모든 첫 요청을 막고 있었다 → 응답과 별개로 처리한다
    try { if (ctx) ctx.waitUntil(holRefresh(env)); else holRefresh(env).catch(function () {}); } catch (e) {}
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Content-Type": "application/json; charset=utf-8"
    };
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (url.pathname === "/gen") {
      if (!adminOk(url, env))
        return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), { status: 401, headers: cors });
      const n = Math.min(10, parseInt(url.searchParams.get("n") || "3", 10));
      let total = 0, runs = [];
      for (let i = 0; i < n; i++) {
        const r = await generatePosts(env);
        total += r.made;
        runs.push(r);
      }
      return new Response(JSON.stringify({ ok: true, made: total, runs }), { headers: cors });
    }
    if (url.pathname === "/newsfeed") {
      const cacheKey = new Request(url.origin + "/newsfeed");
      try {
        const hit = await caches.default.match(cacheKey);
        if (hit) return hit;
      } catch (e) {
      }
      const items = [];
      await Promise.all(NEWSFEED_SRC.map(async function(f) {
        try {
          const r = await fetchT(f.url, 6e3);
          if (!r.ok) return;
          const xml = await r.text();
          parseItemsFull(xml).forEach(function(it) {
            items.push({ cat: f.cat, title: it.t, link: it.l, ts: it.d, desc: it.s || "" });
          });
        } catch (e) {
        }
      }));
      const cut3d = Date.now() - 3 * 24 * 3600 * 1e3;
      const out = items.filter(function(i) {
        return i.title && i.link && (!i.ts || i.ts >= cut3d);
      }).sort(function(a, b) {
        return (b.ts || 0) - (a.ts || 0);
      }).slice(0, 200);
      const res = new Response(JSON.stringify({ ok: true, ts: Date.now(), items: out }), {
        headers: Object.assign({}, cors, { "Cache-Control": "public, s-maxage=600, max-age=300" })
      });
      try {
        await caches.default.put(cacheKey, res.clone());
      } catch (e) {
      }
      return res;
    }
    // ★ 2026-09-24 신설: generatePosts(크론, 20분마다)가 D1 posts 테이블에 계속
    //   쌓아왔지만, 정작 이걸 앱에 돌려주는 GET 엔드포인트가 여태 없었다.
    //   그래서 앱은 (엉뚱한 워커 주소로 /posts를 시도하다 실패하고) 매번 기기별
    //   로컬 생성으로 떨어졌었다 — 서버가 애써 만든 글이 사용자에게 전혀 도달하지
    //   못하고 있었던 것. 이 라우트를 추가하고 앱 index.html의 요청 주소를
    //   board-writer로 고쳐야 실제로 연결된다.
    if (url.pathname === "/posts") {
      const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get("limit") || "50", 10)));
      const cat = url.searchParams.get("cat");
      // ★ 2026-09-25: 글은 20분 cron(generatePosts)으로만 바뀌므로 짧은 엣지캐시를 둬도
      //   신선도 손해가 없다. newsfeed 라우트와 동일한 방식(caches.default)으로 실제 캐싱을
      //   적용한다(이전엔 Cache-Control 헤더만 있고 caches.default 저장/조회가 없어 매번
      //   D1까지 갔었음 — 게시판 진입 2~3초 지연의 주원인).
      const cacheKey = new Request(url.origin + "/posts?limit=" + limit + (cat ? "&cat=" + encodeURIComponent(cat) : ""));
      // ★ 2026-10-10: workers.dev 에서는 엣지 캐시가 동작하지 않아 매 요청 D1 까지 갔다 → 같은 격리 안에서 15초 메모리 캐시
      const memBody = memGet("posts:" + limit + ":" + (cat || ""), 15000);
      if (memBody) return new Response(memBody, { headers: Object.assign({}, cors, { "Cache-Control": "public, s-maxage=30, max-age=15" }) });
      try {
        const hit = await caches.default.match(cacheKey);
        if (hit) return hit;
      } catch (e) {
      }
      try {
        // ★ 2026-09-24: 실제 posts 테이블에 없는 컬럼(views 등)을 하드코딩해서
        //   SELECT하면 스키마가 조금만 달라도 500 에러가 난다. generatePosts의
        //   INSERT처럼 pragma_table_info로 실제 존재하는 컬럼만 골라서 SELECT한다.
        //   (2026-09-25: 매 요청 D1 왕복이던 걸 getCols로 10분 메모리캐시함)
        const [cols, cmtCols] = await Promise.all([getCols(env, "posts"), getCols(env, "comments").catch(function () { return []; })]);   // ★ 2026-10-10: 차례로 → 동시에
        const want = ["id", "nick", "title", "body", "cat", "ts", "views", "likes", "lols", "sads", "link", "user"];
        const use = want.filter((c) => cols.indexOf(c) >= 0);
        if (!use.length) throw new Error("posts 테이블 컬럼을 찾을 수 없음");
        // ★ 2026-10-03: 목록의 💬 숫자가 글을 펼치기 전엔 항상 0이었다 → 올 때가 된 서버 댓글 수를 같이 내려준다
        const hasCmt = cmtCols.length > 0;
        // ★ 2026-10-10: 목록의 💬 숫자(글마다 댓글 수 세기)가 빠르도록 댓글 표에 색인을 한 번 만들어 둔다(이미 있으면 아무 일 없음)
        if (hasCmt && !_cmtIdxDone) { _cmtIdxDone = true; try { const pi = env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_comments_post ON comments (post_id, ts)").run().catch(function () {}); if (_CTX) _CTX.waitUntil(pi); } catch (e) {} }
        let sql = "SELECT " + use.join(",") + (hasCmt ? ", (SELECT COUNT(*) FROM comments c WHERE c.post_id = posts.id AND c.ts <= " + Date.now() + ") AS cmts" : "") + " FROM posts";
        const binds = [];
        const conds = [];
        if (cat && cat !== "all" && cols.indexOf("cat") >= 0) {
          conds.push("cat = ?");
          binds.push(cat);
        }
        // ★ 2026-10-08: 신고가 쌓여 숨김 처리된 사용자 글은 내려주지 않는다
        if (cols.indexOf("hidden") >= 0) conds.push("(hidden IS NULL OR hidden = 0)");
        if (conds.length) sql += " WHERE " + conds.join(" AND ");
        sql += " ORDER BY id DESC LIMIT ?";
        binds.push(limit);
        const rs = await env.DB.prepare(sql).bind(...binds).all();
        const bodyStr = JSON.stringify({ ok: true, posts: rs.results || [] });
        memPut("posts:" + limit + ":" + (cat || ""), bodyStr);
        const res = new Response(bodyStr, {
          headers: Object.assign({}, cors, { "Cache-Control": "public, s-maxage=30, max-age=15" })
        });
        try { await caches.default.put(cacheKey, res.clone()); } catch (e) {}
        return res;
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 500, headers: cors });
      }
    }
    // ★ 2026-09-25 신설: 실제 유저가 글에 달는 댓글을 D1에 저장하고, 같은 글을 보는 다른
    //   기기/사용자에게도 그대로 보여준다. 토큰 게이팅 없음 — /react(가짜 반응 생성)과달리
    //   실제 유저 액션이라 앱이 토큰 없이 호출함(subway-api의 실제 사용자 /react와 같은 결).
    // ★ 2026-10-08: 사용자 글 등록
    if (url.pathname === "/post" && req.method === "POST") {
      const J = (o, st) => new Response(JSON.stringify(o), { status: st || 200, headers: cors });
      let b = {};
      try { b = await req.json(); } catch (e) {}
      const nick = String(b.nick || "").replace(/\s+/g, " ").trim().slice(0, 16);
      const title = String(b.title || "").replace(/\s+/g, " ").trim().slice(0, 60);
      const body = String(b.body || "").replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim().slice(0, 800);
      const cat = USER_POST_CATS.indexOf(b.cat) >= 0 ? b.cat : "잡담";
      if (!nick) return J({ ok: false, error: "커뮤니티 아이디가 필요해요" }, 400);
      if (!title || !body) return J({ ok: false, error: "제목과 내용을 입력해주세요" }, 400);
      if (containsBadWord(nick) || containsBadWord(title) || containsBadWord(body)) return J({ ok: false, error: "욕설·비방이 포함되어 등록할 수 없어요" }, 400);
      if (hasLinkOrPhone(title) || hasLinkOrPhone(body)) return J({ ok: false, error: "링크·전화번호는 올릴 수 없어요" }, 400);
      try {
        await ensureUserPostCols(env);
        const ip = (await ownerHash("ip:" + (req.headers.get("CF-Connecting-IP") || "?"))).slice(0, 24);   // IP 원문은 저장하지 않는다
        const hr = Math.floor(Date.now() / 36e5), day = Math.floor(Date.now() / 864e5);
        if (!(await bumpLimit(env, "post:" + ip, hr, POST_PER_IP_HR)) || !(await bumpLimit(env, "postd:" + ip, day, POST_PER_IP_DAY)))
          return J({ ok: false, error: "글을 너무 자주 올리고 있어요. 잠시 뒤 다시 써주세요" }, 429);
        const dup = await env.DB.prepare("SELECT id FROM posts WHERE nick = ?1 AND title = ?2 AND ts > ?3 LIMIT 1").bind(nick, title, Date.now() - 864e5).first();
        if (dup) return J({ ok: false, error: "같은 제목의 글을 이미 올렸어요" }, 400);
        const ts = Date.now();
        const cols = await getCols(env, "posts");
        const ok = String(b.owner_key || "");
        const data = { nick, title, body, cat, ts, likes: 0, lols: 0, sads: 0, user: 1, hidden: 0, owner: ok.length >= 16 ? await ownerHash(ok) : null };
        const use = Object.keys(data).filter((k) => cols.indexOf(k) >= 0);
        const res = await env.DB.prepare("INSERT INTO posts (" + use.join(",") + ") VALUES (" + use.map(() => "?").join(",") + ")").bind(...use.map((k) => data[k])).run();
        const id = res && res.meta ? res.meta.last_row_id : null;
        await purgePostsCache(url);
        return J({ ok: true, id, ts });
      } catch (e) {
        return J({ ok: false, error: "서버 오류: " + e.message }, 500);
      }
    }
    // ★ 2026-10-08: 작성자 본인 삭제 — 등록할 때 보낸 기기 비밀키(owner_key)가 맞아야 한다(개인정보처리방침의 '직접 삭제' 약속)
    if (url.pathname === "/post/mine-delete" && req.method === "POST") {
      const J = (o, st) => new Response(JSON.stringify(o), { status: st || 200, headers: cors });
      let b = {};
      try { b = await req.json(); } catch (e) {}
      const pid = parseInt(b.post_id, 10), ok = String(b.owner_key || "");
      if (!pid || ok.length < 16) return J({ ok: false, error: "post_id·owner_key 필요" }, 400);
      try {
        await ensureUserPostCols(env);
        const row = await env.DB.prepare("SELECT owner FROM posts WHERE id = ?1 AND user = 1").bind(pid).first();
        if (!row) return J({ ok: true, deleted: false });   // 이미 없음
        if (!row.owner || row.owner !== (await ownerHash(ok))) return J({ ok: false, error: "본인 글만 삭제할 수 있어요" }, 403);
        await env.DB.prepare("DELETE FROM posts WHERE id = ?1").bind(pid).run();
        try { await env.DB.prepare("DELETE FROM comments WHERE post_id = ?1").bind(pid).run(); } catch (e) {}
        await purgePostsCache(url);
        return J({ ok: true, deleted: true });
      } catch (e) {
        return J({ ok: false, error: e.message }, 500);
      }
    }
    // ★ 2026-10-08: 사용자 글 신고 — 서로 다른 3곳이 신고하면 숨긴다
    if (url.pathname === "/report" && req.method === "POST") {
      const J = (o, st) => new Response(JSON.stringify(o), { status: st || 200, headers: cors });
      let b = {};
      try { b = await req.json(); } catch (e) {}
      const pid = parseInt(b.post_id, 10);
      if (!pid) return J({ ok: false, error: "post_id 필요" }, 400);
      try {
        await ensureUserPostCols(env);
        const ip = (await ownerHash("ip:" + (req.headers.get("CF-Connecting-IP") || "?"))).slice(0, 24);   // IP 원문은 저장하지 않는다
        if (!(await bumpLimit(env, "rep:" + ip, Math.floor(Date.now() / 36e5), REPORT_PER_IP_HR))) return J({ ok: false, error: "too many" }, 429);
        const post = await env.DB.prepare("SELECT id, user FROM posts WHERE id = ?1").bind(pid).first();
        if (!post || !post.user) return J({ ok: false, error: "신고할 수 없는 글이에요" }, 400);
        await env.DB.prepare("CREATE TABLE IF NOT EXISTS post_reports (post_id INTEGER, k TEXT, ts INTEGER, PRIMARY KEY (post_id, k))").run();
        if (Math.random() < 0.05) { try { await env.DB.prepare("DELETE FROM post_reports WHERE ts < ?1").bind(Date.now() - 14 * 864e5).run(); } catch (e) {} }   // 14일 지난 신고 기록 삭제(방침과 동일)
        await env.DB.prepare("INSERT OR IGNORE INTO post_reports (post_id,k,ts) VALUES (?1,?2,?3)").bind(pid, ip, Date.now()).run();
        const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM post_reports WHERE post_id = ?1").bind(pid).first();
        let hidden = false;
        if (n && n.n >= REPORT_HIDE_AT) { await env.DB.prepare("UPDATE posts SET hidden = 1 WHERE id = ?1").bind(pid).run(); hidden = true; await purgePostsCache(url); }
        return J({ ok: true, hidden });
      } catch (e) {
        return J({ ok: false, error: e.message }, 500);
      }
    }
    // ★ 2026-10-08: 관리자 — 글 삭제 / 신고된 글 보기 (ADMIN_TOKEN)
    if (url.pathname === "/post/delete" || url.pathname === "/reports") {
      if (!adminOk(url, env)) return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), { status: 401, headers: cors });
      try {
        if (url.pathname === "/post/delete") {
          const id = parseInt(url.searchParams.get("id"), 10);
          if (!id) return new Response(JSON.stringify({ ok: false, error: "id 필요" }), { status: 400, headers: cors });
          await env.DB.prepare("DELETE FROM posts WHERE id = ?1").bind(id).run();
          try { await env.DB.prepare("DELETE FROM comments WHERE post_id = ?1").bind(id).run(); } catch (e) {}
          await purgePostsCache(url);
          return new Response(JSON.stringify({ ok: true, deleted: id }), { headers: cors });
        }
        await env.DB.prepare("CREATE TABLE IF NOT EXISTS post_reports (post_id INTEGER, k TEXT, ts INTEGER, PRIMARY KEY (post_id, k))").run();
        const rs = await env.DB.prepare("SELECT r.post_id, COUNT(*) AS n, p.nick, p.title, p.hidden FROM post_reports r LEFT JOIN posts p ON p.id = r.post_id GROUP BY r.post_id ORDER BY n DESC LIMIT 50").all();
        return new Response(JSON.stringify({ ok: true, reports: rs.results || [] }), { headers: cors });
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 500, headers: cors });
      }
    }
    if (url.pathname === "/comment" && req.method === "POST") {
      let body = {};
      try {
        body = await req.json();
      } catch (e) {
      }
      const postId = parseInt(body.post_id, 10);
      const nick = String(body.nick || "나").slice(0, 16).trim() || "나";
      const text = String(body.body || "").slice(0, 300).trim();
      if (!postId) return new Response(JSON.stringify({ ok: false, error: "post_id 필요" }), { status: 400, headers: cors });
      if (!text) return new Response(JSON.stringify({ ok: false, error: "empty" }), { status: 400, headers: cors });
      if (containsBadWord(nick) || containsBadWord(text)) {
        return new Response(JSON.stringify({ ok: false, error: "부적절한 내용이 포함되어 있습니다" }), { status: 400, headers: cors });
      }
      try {
        const ts = Date.now();
        const cols = await getCols(env, "comments");
        if (!cols.length) throw new Error("comments 테이블이 없습니다 (D1에 CREATE TABLE 필요)");
        const data = { post_id: postId, nick, body: text, ts };
        const use = Object.keys(data).filter((k) => cols.indexOf(k) >= 0);
        const sql = "INSERT INTO comments (" + use.join(",") + ") VALUES (" + use.map(() => "?").join(",") + ")";
        const res = await env.DB.prepare(sql).bind(...use.map((k) => data[k])).run();
        const id = res && res.meta ? res.meta.last_row_id : null;
        return new Response(JSON.stringify({ ok: true, id, ts }), { headers: cors });
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 500, headers: cors });
      }
    }
    if (url.pathname === "/comments") {
      const postId = parseInt(url.searchParams.get("post_id"), 10);
      const limit = Math.min(200, Math.max(1, parseInt(url.searchParams.get("limit") || "50", 10)));
      if (!postId) return new Response(JSON.stringify({ ok: false, error: "post_id 필요" }), { status: 400, headers: cors });
      try {
        const cols = await getCols(env, "comments");
        if (!cols.length) {
          return new Response(JSON.stringify({ ok: true, comments: [] }), { headers: cors });
        }
        const want = ["id", "nick", "body", "ts"];
        const use = want.filter((c) => cols.indexOf(c) >= 0);
        // ★ 2026-10-03: 아직 올 때가 안 된(ts 가 미래인) 서버 댓글은 숨긴다 — 실제 댓글처럼 하나씩 나타난다
        const sql = "SELECT " + use.join(",") + " FROM comments WHERE post_id = ? AND ts <= ? ORDER BY ts ASC, id ASC LIMIT ?";
        const rs = await env.DB.prepare(sql).bind(postId, Date.now(), limit).all();
        return new Response(JSON.stringify({ ok: true, now: Date.now(), comments: rs.results || [] }), {
          headers: Object.assign({}, cors, { "Cache-Control": "no-store" })
        });
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 500, headers: cors });
      }
    }
    // ★ 2026-10-03: 모든 사용자가 같은 대화를 본다. 앱이 6초마다 이 라우트를 불러 새 줄만 받아 간다.
    //   · ts 가 '지금 이전'인 줄만 내려준다(generateTalks 는 19분에 걸쳐 시각을 미리 흩뿌려 저장하므로,
    //     아직 올 때가 안 된 줄은 숨겨져야 실제 채팅처럼 한 줄씩 나타난다).
    //   · 커서는 id 가 아니라 ts(since)다 — 사용자 메시지·반응이 같은 배치 사이사이 끼어들어 id 순서와
    //     시각 순서가 다르다. 같은 ts 줄을 다시 받을 수 있으니 앱이 id 로 중복을 걸러낸다.
    //   · 최근 100줄 스냅샷을 5초만 엣지캐시해 사용자가 몰려도 D1 은 몇 초에 한 번만 읽는다.
    if (url.pathname === "/talks") {
      const since = parseInt(url.searchParams.get("since") || "0", 10) || 0;
      const limit = Math.min(60, Math.max(1, parseInt(url.searchParams.get("limit") || "30", 10)));
      const snapKey = new Request(url.origin + "/talks?snap=1");
      // ★ 2026-10-10: workers.dev 에서는 엣지 캐시(caches.default)가 동작하지 않는다(Cloudflare 문서: 사용자 지정 도메인에서만) →
      //   같은 격리 안에서 5초간은 메모리 스냅샷을 쓴다.
      let snap = memGet("talks", 5000);
      try {
        if (!snap) {
          const hit = await caches.default.match(snapKey);
          if (hit) snap = await hit.json();
        }
      } catch (e) {
      }
      if (!snap) {
        try {
          // ★ 2026-10-04: 전체 = 각 노선 방(line_msgs 의 chat)을 시간순으로 모은 것. 각 줄에 line(노선명)이 붙는다.
          //   옛 talks(전체에서 노선 없이 보낸 말·예전 반응)도 최근 6시간분은 함께 섞는다(line 은 null).
          await ensureLineRoom(env);
          const nowT = Date.now();
          const rs = await env.DB.prepare("SELECT * FROM (SELECT 'L' || id AS id, nick, text, ts, line FROM line_msgs WHERE kind='chat' AND ts <= ?1 AND ts > ?2" + LR_HIDDEN_SQL + " UNION ALL SELECT id, nick, text, ts, NULL AS line FROM talks WHERE ts <= ?1 AND ts > ?2) ORDER BY ts DESC LIMIT 100").bind(nowT, nowT - 6 * 3600 * 1000).all();
          snap = { talks: (rs.results || []).reverse() };
          memPut("talks", snap);
          try {
            await caches.default.put(snapKey, new Response(JSON.stringify(snap), { headers: { "Content-Type": "application/json", "Cache-Control": "public, s-maxage=5" } }));
          } catch (e) {
          }
        } catch (e) {
          if (/no such table/i.test(String(e && e.message)) && !_lrRetry) { _lrRetry = true; _lrReady = false; try { await ensureLineRoom(env, true); return await worker_default.fetch(req, env, ctx); } finally { _lrRetry = false; } }
          return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 500, headers: cors });
        }
      }
      let rows = snap.talks || [];
      rows = since > 0 ? rows.filter(function(t) { return t.ts >= since; }) : rows.slice(-limit);
      return new Response(JSON.stringify({ ok: true, now: Date.now(), talks: rows }), { headers: Object.assign({}, cors, { "Cache-Control": "no-store" }) });
    }
    // ★ 2026-10-03 (개선안 4·5): 노선별 방. 대화 읽기/쓰기 + 지연 제보 집계.
    if (url.pathname === "/lroom" && req.method === "POST") {
      let body = {};
      try { body = await req.json(); } catch (e) {}
      const line = String(body.line || "").trim();
      const kind = LR_KINDS_OK.indexOf(body.kind) >= 0 ? body.kind : "chat";
      const nick = String(body.nick || "나").slice(0, 16).trim() || "나";
      const stn = String(body.stn || "").slice(0, 20).trim();
      let text = String(body.text || "").slice(0, 120).trim();
      if (!lrLineOk(line)) return new Response(JSON.stringify({ ok: false, error: "line" }), { status: 400, headers: cors });
      if (!text) text = kind === "delay" ? (stn ? stn + " 쪽 지연돼요" : "지연돼요") : kind === "crowd" ? (stn ? stn + " 많이 붐벼요" : "많이 붐벼요") : "";
      if (!text) return new Response(JSON.stringify({ ok: false, error: "empty" }), { status: 400, headers: cors });
      if (containsBadWord(nick) || containsBadWord(text) || containsBadWord(stn)) return new Response(JSON.stringify({ ok: false, error: "filtered" }), { status: 400, headers: cors });
      try {
        await ensureLineRoom(env);
        if (!await lrAllowed(req, env)) return new Response(JSON.stringify({ ok: false, error: "rate limited" }), { status: 429, headers: cors });
        const ipk = await lrIpHash(req);
        const now = Date.now();
        // 같은 사람의 같은 글·제보는 짧은 시간 안에 한 번만 저장한다
        const dupWin = kind === "chat" ? 60 * 1000 : 20 * 60 * 1000;
        const dup = kind === "chat"
          ? await env.DB.prepare("SELECT id FROM line_msgs WHERE line=?1 AND ipk=?2 AND text=?3 AND ts > ?4 LIMIT 1").bind(line, ipk, text, now - dupWin).first()
          : await env.DB.prepare("SELECT id FROM line_msgs WHERE line=?1 AND ipk=?2 AND kind=?3 AND IFNULL(stn,'')=?4 AND ts > ?5 LIMIT 1").bind(line, ipk, kind, stn, now - dupWin).first();
        if (dup) return new Response(JSON.stringify({ ok: true, dup: true, id: dup.id }), { headers: cors });
        const res = await env.DB.prepare("INSERT INTO line_msgs (line,kind,nick,text,stn,ipk,ts) VALUES (?1,?2,?3,?4,?5,?6,?7)").bind(line, kind, nick, text, stn || null, ipk, now).run();
        return new Response(JSON.stringify({ ok: true, id: res && res.meta ? res.meta.last_row_id : null, ts: now }), { headers: cors });
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 500, headers: cors });
      }
    }
    if (url.pathname === "/ridelog" && req.method === "POST") return rideHandle(req, env, cors);
    if (url.pathname === "/lreport" && req.method === "POST") {
      let body = {};
      try { body = await req.json(); } catch (e) {}
      const id = parseInt(body.id, 10);
      if (!isFinite(id) || id <= 0) return new Response(JSON.stringify({ ok: false, error: "id" }), { status: 400, headers: cors });
      try {
        await ensureLineRoom(env);
        if (!await lrAllowed(req, env)) return new Response(JSON.stringify({ ok: false, error: "rate limited" }), { status: 429, headers: cors });
        const ipk = await lrIpHash(req);
        const m = await env.DB.prepare("SELECT id, ipk FROM line_msgs WHERE id=?1").bind(id).first();
        if (!m) return new Response(JSON.stringify({ ok: true, gone: true }), { headers: cors });
        if (m.ipk === ipk) return new Response(JSON.stringify({ ok: true, own: true }), { headers: cors });   // 내 글은 신고 대상이 아니다
        await env.DB.prepare("INSERT OR IGNORE INTO line_reports (msg_id, ipk, ts) VALUES (?1,?2,?3)").bind(id, ipk, Date.now()).run();
        const c = await env.DB.prepare("SELECT COUNT(*) AS n FROM line_reports WHERE msg_id=?1").bind(id).first();
        return new Response(JSON.stringify({ ok: true, hidden: ((c && c.n) || 0) >= LR_HIDE_N }), { headers: cors });
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 500, headers: cors });
      }
    }
    if (url.pathname === "/lroom") {
      const line = String(url.searchParams.get("line") || "").trim();
      if (!lrLineOk(line)) return new Response(JSON.stringify({ ok: false, error: "line" }), { status: 400, headers: cors });
      const since = parseInt(url.searchParams.get("since") || "0", 10) || 0;
      const snapKey = new Request(url.origin + "/lroom?snap=1&line=" + encodeURIComponent(line));
      let snap = memGet("lroom:" + line, 5000);
      if (!snap) { try { const hit = await caches.default.match(snapKey); if (hit) snap = await hit.json(); } catch (e) {} }
      if (!snap) {
        try {
          await ensureLineRoom(env);
          const now = Date.now();
          const alP = lrAlerts(env, [line]);   // ★ 2026-10-10: 대화와 지연 제보 집계를 동시에 읽는다
          alP.catch(function () {});
          const rs = await env.DB.prepare("SELECT id, kind, nick, text, stn, ts FROM line_msgs WHERE line=?1 AND ts <= ?2 AND ts > ?3" + LR_HIDDEN_SQL + " ORDER BY ts DESC, id DESC LIMIT 80").bind(line, now, now - 24 * 3600 * 1000).all();   // ★ 2026-10-05: 화면에 보이는 기간 12시간→24시간(새벽에도 전날 저녁 대화가 남아 방이 비어 보이지 않게)
          const al = await alP;
          snap = { msgs: (rs.results || []).reverse(), alert: al[line] || { reporters: 0, stations: [] } };
          memPut("lroom:" + line, snap);
          try { await caches.default.put(snapKey, new Response(JSON.stringify(snap), { headers: { "Content-Type": "application/json", "Cache-Control": "public, s-maxage=5" } })); } catch (e) {}
        } catch (e) {
          if (/no such table/i.test(String(e && e.message)) && !_lrRetry) { _lrRetry = true; _lrReady = false; try { await ensureLineRoom(env, true); return await worker_default.fetch(req, env, ctx); } finally { _lrRetry = false; } }
          return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 500, headers: cors });
        }
      }
      const rows = since > 0 ? (snap.msgs || []).filter((m) => m.ts >= since) : (snap.msgs || []);
      return new Response(JSON.stringify({ ok: true, now: Date.now(), msgs: rows, alert: snap.alert }), { headers: Object.assign({}, cors, { "Cache-Control": "no-store" }) });
    }
    if (url.pathname === "/lalerts") {
      const lines = String(url.searchParams.get("lines") || "").split(",").map((x) => x.trim()).filter(lrLineOk).slice(0, 8);
      if (!lines.length) return new Response(JSON.stringify({ ok: true, lines: {} }), { headers: cors });
      const key = new Request(url.origin + "/lalerts?lines=" + encodeURIComponent(lines.join(",")));
      try { const hit = await caches.default.match(key); if (hit) return hit; } catch (e) {}
      try {
        await ensureLineRoom(env);
        const al = await lrAlerts(env, lines);
        const res = new Response(JSON.stringify({ ok: true, now: Date.now(), lines: al }), { headers: Object.assign({}, cors, { "Cache-Control": "public, s-maxage=20" }) });
        try { await caches.default.put(key, res.clone()); } catch (e) {}
        return res;
      } catch (e) {
        if (/no such table/i.test(String(e && e.message)) && !_lrRetry) { _lrRetry = true; _lrReady = false; try { await ensureLineRoom(env, true); return await worker_default.fetch(req, env, ctx); } finally { _lrRetry = false; } }
        return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 500, headers: cors });
      }
    }
    if (url.pathname === "/react" && req.method === "POST") {
      let body = {};
      try {
        body = await req.json();
      } catch (e) {
      }
      const nick = String(body.nick || "나").slice(0, 16);
      const text = String(body.text || "").slice(0, 200).trim();
      const rline = body.line == null ? "" : String(body.line).trim();   // ★ 2026-10-04: 노선 방에서 보낸 말이면 그 방에 저장하고 그 방에서 반응한다
      if (rline && !lrLineOk(rline)) return new Response(JSON.stringify({ ok: false, error: "line" }), { status: 400, headers: cors });
      if (!text) return new Response(JSON.stringify({ ok: false, error: "empty" }), { status: 400, headers: cors });
      if (containsBadWord(nick) || containsBadWord(text)) return new Response(JSON.stringify({ ok: false, error: "filtered" }), { status: 400, headers: cors });
      // ★ 2026-10-03: 사용자가 친 말을 대화에 저장해야 다른 사용자에게도 보인다(전에는 AI 반응만 저장).
      //   욕설·비방은 저장하지 않는다. 사용자 말 저장은 AI 반응과 별도의 한도(IP당 시간당 40줄)를 쓴다.
      let stored = false;
      try {
        if (rline && !containsBadWord(nick) && !containsBadWord(text) && await msgAllowed(req, env)) {
          await ensureLineRoom(env);
          const ipk = await lrIpHash(req);
          await env.DB.prepare("INSERT INTO line_msgs (line,kind,nick,text,stn,ipk,ts) VALUES (?1,'chat',?2,?3,NULL,?4,?5)").bind(rline, nick, text.slice(0, 120), ipk, Date.now()).run();
          stored = true;
        } else if (!rline && !containsBadWord(nick) && !containsBadWord(text) && await msgAllowed(req, env)) {
          const info = await getCols(env, "talks");
          const data = { nick, text: text.slice(0, 120), ts: Date.now() };
          const use = Object.keys(data).filter((k) => info.indexOf(k) >= 0);
          if (use.length) {
            await env.DB.prepare("INSERT INTO talks (" + use.join(",") + ") VALUES (" + use.map(() => "?").join(",") + ")").bind(...use.map((k) => data[k])).run();
            stored = true;
          }
        }
      } catch (e) {
      }
      if (!await reactAllowed(req, env))
        return new Response(JSON.stringify({ ok: false, error: "rate limited", stored }), { status: 429, headers: cors });
      const r = await generateReaction(env, nick, text, rline || null);
      return new Response(JSON.stringify({ ok: true, stored, result: r }), { headers: cors });
    }
    if (url.pathname === "/gentalk") {
      if (!adminOk(url, env))
        return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), { status: 401, headers: cors });
      const r = await generateTalks(env);
      return new Response(JSON.stringify({ ok: true, result: r }), { headers: cors });
    }
    if (url.pathname === "/news") {
      if (!adminOk(url, env))
        return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), { status: 401, headers: cors });
      const report = [];
      for (const feed of NEWS_FEEDS) {
        const r = await fetchHeadlines(feed, true);
        report.push({ cat: feed.cat, got: r.titles.length, sample: r.titles.slice(0, 2), tries: r.tries });
      }
      return new Response(JSON.stringify({ ok: true, feeds: report }, null, 1), { headers: cors });
    }
    if (url.pathname === "/status") {
      try {
        const c = await env.DB.prepare("SELECT COUNT(*) AS n, MIN(id) AS oldest, MAX(id) AS newest FROM posts").first();
        let tk = null;
        try {
          tk = await env.DB.prepare("SELECT COUNT(*) AS n, MAX(ts) AS lastTs FROM talks").first();
        } catch (e) {
        }
        return new Response(JSON.stringify({ ok: true, posts: { count: c.n, oldest: c.oldest, newest: c.newest }, talks: tk }), { headers: cors });
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 500, headers: cors });
      }
    }
    return new Response(JSON.stringify({ ok: true, name: "board-writer", endpoints: ["/gen?token=..&n=3", "/posts?limit=50&cat=all", "/comment (POST)", "/comments?post_id=&limit=50", "/newsfeed", "/talks?since=<ts>", "/lroom?line=<노선>&since=<ts>", "/lroom (POST)", "/lalerts?lines=a,b", "/react (POST)", "/status"] }), { headers: cors });
  }
};
export {
  worker_default as default
};
//# sourceMappingURL=worker.js.map