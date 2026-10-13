// 로컬 시뮬레이터: 실제 D1 버스 정류장 자료(bus_route_stops JOIN bus_routes 결과 JSON)로 엔진을 직접 돌려 4개 탭을 무작위 출발·도착 쌍으로 점검한다.
//   실행: node test/sim_tabs.js <엔진파일> <D1결과.json> <쌍 개수> <라벨>    (D1 결과: d1 query 의 results 배열이 든 JSON)
//   점검: 지하철 탭 버스 섞임(subBusBadWalk) · 버스 탭 지하철(busSub) · 최소환승이 최단시간보다 환승 많음(lessMoreXfer) · 오래 걷기 · 한 정거장 버스(hop) · 새벽버스 시간(dawnBad)
const fs=require('fs');
const [,, engFile, dataFile, N, label]=process.argv;
let src=fs.readFileSync(engFile,'utf8'); const ei=src.lastIndexOf('\nexport {'); src=src.slice(0,ei)+'\n';
const mod=new Function('fetch','caches',src+'\nreturn { buildSubway, addBus, dijkstra, SUBWAY_BUNDLE, subwayTabRoute: (typeof subwayTabRoute!=="undefined"?subwayTabRoute:null), pickMinTransfer: (typeof pickMinTransfer!=="undefined"?pickMinTransfer:null) };')(async()=>({}),undefined);
const raw=JSON.parse(fs.readFileSync(dataFile,'utf8')); const rows=(raw[0]||raw).results;
const rad=Math.PI/180, hav=(a,b,c,d)=>{const dl=(c-a)*rad,dg=(d-b)*rad,s=Math.sin(dl/2)**2+Math.cos(a*rad)*Math.cos(c*rad)*Math.sin(dg/2)**2;return 2*6371e3*Math.asin(Math.sqrt(s));};
function rng(seed){let a=seed>>>0;return()=>{a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;};}
const R=rng(12345); const stops=[...new Map(rows.map(r=>[r.node_id,[r.lat,r.lng]])).values()];
const times=[[8,30],[14,0],[19,20],[23,50],[4,10]];
const pairs=[]; while(pairs.length<+N){const a=stops[Math.floor(R()*stops.length)],b=stops[Math.floor(R()*stops.length)];const d=hav(a[0],a[1],b[0],b[1]);if(d>2500&&d<16000)pairs.push([a,b]);}
const V={pairs:0,subNull:0,busNull:0,fastNull:0,subBus:0,subBusBadWalk:0,subNoSub:0,busSub:0,fastSlow:0,lessMoreXfer:0,lessWalk25:0,fastWalk25:0,subWalk25:0,hop:0,sameName:0,dawnBad:0,total:0,lessXferSum:0,fastXferSum:0,nLess:0,nFast:0};
const ex={};
const note=(k,s)=>{(ex[k]=ex[k]||[]).length<6&&ex[k].push(s);};
for(const [h,m] of times){
  const base=Date.UTC(2026,9,14,h-9,m);
  const sub=mod.buildSubway(mod.SUBWAY_BUNDLE); const G={adj:sub.adj,ST:sub.ST,LN:sub.LN,_baseMs:base};
  const bc=mod.addBus(G,rows,mod.SUBWAY_BUNDLE);
  for(const [o,d] of pairs){
    V.pairs++;
    const dj=(mode,opt)=>{try{return mod.dijkstra(G,bc.busCoord,bc.busNm,o[0],o[1],d[0],d[1],mode,opt)}catch(e){return {err:e.message}}};
    const mt=dj('minTime'), ml=dj('minTransfer'), mw=dj('minWalk'), bus=dj('minTime',{noSubway:true});
    let sb; if(mod.subwayTabRoute){try{sb=mod.subwayTabRoute(G,bc.busCoord,bc.busNm,o[0],o[1],d[0],d[1])}catch(e){sb={err:e.message}}} else sb=dj('minTime',{mustSubway:true,subwayNearest:true});
    for(const r of [mt,ml,mw,bus,sb]) if(r&&r.err){note('error',r.err);}
    const ok=x=>x&&!x.err;
    const ml0=ml; const ml2=mod.pickMinTransfer?mod.pickMinTransfer([ml0,mt,mw,sb,bus].filter(ok)):ml0;
    const all=[mt,ml,mw,sb,bus].filter(ok); const fast=all.length?all.reduce((a,b)=>b.totalMin<a.totalMin?b:a):null;
    if(!fast){V.fastNull++;continue;}
    V.fastMin=(V.fastMin||0)+fast.totalMin; V.nF=(V.nF||0)+1; if(ok(ml2)){V.lessMin=(V.lessMin||0)+ml2.totalMin; V.nL=(V.nL||0)+1;}
    if(!ok(sb))V.subNull++; if(!ok(bus))V.busNull++;
    const bl=r=>r.legs.filter(l=>l.mode==='bus'), sl=r=>r.legs.filter(l=>l.mode==='subway');
    const tag=`${label} ${h}:${String(m).padStart(2,'0')} (${o[0].toFixed(3)},${o[1].toFixed(3)})→(${d[0].toFixed(3)},${d[1].toFixed(3)})`;
    if(ok(sb)){
      if(bl(sb).length){V.subBus++;
        const pure=dj('minTime',{mustSubway:true,subwayNearest:true,noBus:true});
        // 순수 지하철이 있고 첫 걷기가 12분 이하인데 버스가 섞이면 위반
        if(ok(pure)&&pure.accessWalkMin<=12&&!(sb.totalMin<pure.totalMin)){V.subBusBadWalk++;note('subBusBadWalk',tag);}
      }
      if(!sl(sb).length){V.subNoSub++;note('subNoSub',tag);}
      if(sb.accessWalkMin>25)V.subWalk25++;
    }
    if(ok(bus)&&sl(bus).length){V.busSub++;note('busSub',tag);}
    if(fast.totalMin>Math.min(...all.map(x=>x.totalMin))+1){V.fastSlow++;}
    const ml_=ml2; if(ok(ml_)){const ml=ml_; V.nLess++;V.lessXferSum+=ml.transfers;V.nFast++;V.fastXferSum+=fast.transfers; if(ml.transfers>fast.transfers){V.lessMoreXfer++;note('lessMoreXfer',tag+` less${ml.transfers}x ${ml.totalMin}m acc${ml.accessWalkMin} | fast${fast.transfers}x ${fast.totalMin}m acc${fast.accessWalkMin} egr${fast.egressWalkMin} :: `+fast.legs.map(x=>x.mode==='bus'?'BUS'+x.busNo:x.mode==='walk'?'walk'+x.min:x.mode==='subway'?'SUB':x.mode).join('/'));} if(ml.accessWalkMin>25){V.lessWalk25++;note('lessWalk25',tag+` walk${ml.accessWalkMin}`);}}
    if(fast.accessWalkMin>25)V.fastWalk25++;
    for(const [nm,r] of [['fast',fast],['less',ml],['sub',sb],['bus',bus]]){ if(!ok(r))continue; V.total++;
      for(const L of bl(r)){
        const cl=(L.coordList||[]).filter(Boolean);
        if(L.from&&L.to&&L.from===L.to){V.sameName++;note('sameName',tag+' '+nm+' '+L.busNo+' '+L.from);}
        if(L.stops<=2&&cl.length>=2&&hav(cl[0][0],cl[0][1],cl[cl.length-1][0],cl[cl.length-1][1])<600){V.hop++;const dd=hav(cl[0][0],cl[0][1],cl[cl.length-1][0],cl[cl.length-1][1]);V[dd<250?'hop250':dd<350?'hop350':'hop600']=(V[dd<250?'hop250':dd<350?'hop350':'hop600']||0)+1;note('hop',tag+' '+nm+' '+r.legs.map(x=>x.mode==='bus'?'BUS'+x.busNo+'('+x.from+'>'+x.to+','+x.stops+'st,'+x.min+'m)':x.mode==='walk'?'walk'+x.min:x.mode==='subway'?'SUB'+x.min:x.mode).join(' / ')+' acc'+r.accessWalkMin+' egr'+r.egressWalkMin);}
        if(/^새벽/.test(L.busNo||'')){const mm=h*60+m;if(!(mm>=210&&mm<=330+20)){V.dawnBad++;note('dawnBad',tag+' '+nm+' '+L.busNo);}}
      }}
  }
}
console.log(label, JSON.stringify(V)); console.log(JSON.stringify(ex,null,0).slice(0,6000));
