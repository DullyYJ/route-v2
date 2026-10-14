// 워커를 "ASCII 전용" 파일로 바꾼다 — 한글 등 모든 비ASCII 글자를 \uXXXX 로 쓴다.
//   왜: 대시보드에 붙여 넣을 때 휴대폰·메모장이 파일을 UTF-8 로 읽지 못하면 한글이 전부 깨져 올라간다
//   (2026-10-14 실제로 발생: '평일' → 'ÌèâÏùº', 시간표·경로 한글 비교가 전부 실패). ASCII 파일은 어떤 편집기로 열어도 깨지지 않는다.
//   동작은 같다: 문자열·정규식·템플릿의 \uXXXX 는 같은 글자이고, String.raw 로 들어간 두 JSON(공휴일·시각표 묶음)은 JSON.parse 가 같은 글자로 읽는다.
// 사용: node make-ascii.js [입력=route-v2-worker.js] [출력=route-v2-worker.ascii.js]
const fs = require('fs');
const inp = process.argv[2] || 'route-v2-worker.js', out = process.argv[3] || 'route-v2-worker.ascii.js';
const s = fs.readFileSync(inp, 'utf8');
let o = '', n = 0;
for (const ch of s) {                       // 코드포인트 단위(이모지는 서로게이트 쌍으로)
  const c = ch.codePointAt(0);
  if (c < 128) { o += ch; continue; }
  n++;
  if (c > 0xffff) { const v = c - 0x10000; o += '\\u' + (0xd800 + (v >> 10)).toString(16) + '\\u' + (0xdc00 + (v & 1023)).toString(16); }
  else o += '\\u' + c.toString(16).padStart(4, '0');
}
if (/[^\x00-\x7f]/.test(o)) throw new Error('비ASCII 가 남았다');
// 홀수 개의 역슬래시 바로 뒤의 비ASCII 는 \\uXXXX 가 되어 의미가 바뀐다 — 없는지 확인
const re = /[^\x00-\x7f]/g;
for (let m; (m = re.exec(s));) { let k = m.index, c = 0; while (k > 0 && s[k - 1] === '\\') { c++; k--; } if (c % 2) throw new Error('역슬래시 뒤 비ASCII @' + m.index); }
fs.writeFileSync(out, o, 'ascii');
console.log('비ASCII', n, '글자 → \\uXXXX,', inp, s.length, '→', out, o.length);
