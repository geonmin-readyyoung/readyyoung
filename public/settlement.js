/* =========================================================================
   급여관리 › 월별 급여 데이터 — 세무사 제출용 엑셀 2종을 HR 데이터로 만든다.
     · N월_근무시간기록표_단시간사업소득_명동타운레디영.xlsx (미신고 단시간 인원별 시트)
     · N월_급여변경사항_명동타운레디영_YYMM.xlsx (입사/퇴사/수당/수당_미신고인원/급여현황표 3종/이메일)
   양식은 templates/*.xlsx (기존 제출본에서 개인정보·값만 지운 것, 관리자 로그인에만 서버가 내려줌)을 그대로 쓰고,
   엑셀은 브라우저에서 만들어 바로 내려받는다 (서버로 보내는 것 없음).
   산출 기준
     · 근무일·마감·휴일: 출근부와 같은 판정(attDayInfo) — 출근 1일, 반차 0.5일
     · 근무시간: 근무표(대체·변경 시 그 시간), 반차는 반차 구간
     · 휴일근로 시간: DB.holidays 날 근무시간 − 휴게(4시간 미만 0, 8시간 미만 30분, 8시간 이상 1시간)
     · 일당: 시간대별 일당 → 기본 일당 → 시급×근무시간 순
     · 월 중간 입사: 역일 기준 일할 (입사일~말일 / 그 달 일수)
   설정은 직원별로 DB.payrollConfig[직원id]에 저장되고, 없으면 PAYROLL_PRESET → 기본 규칙 순으로 쓴다.
   ========================================================================= */

const STORE_FILE_NAME = "명동타운레디영";
const PAY_CATS = [
  {key:"상용",        label:"신고 정규직",   hint:"수당 시트 · 입사/퇴사 · 이메일"},
  {key:"일용",        label:"신고 일용직",   hint:"급여현황표_일용직 · 입사/퇴사 · 이메일"},
  {key:"미신고상용",  label:"미신고 정규직", hint:"수당_미신고인원 시트"},
  {key:"미신고단시간",label:"미신고 단시간", hint:"근무시간기록표 · 급여현황표_미신고인원"},
  {key:"제외",        label:"정산 제외",     hint:"어느 파일에도 넣지 않음"},
];
const PAY_CAT_LABEL = Object.fromEntries(PAY_CATS.map(c=>[c.key,c.label]));
/* 초기값 — 2026년 7~9월 제출본으로 검증한 단가·구분. 정산 설정에서 바꾸면 그 값(DB.payrollConfig)이 우선 */
const PAYROLL_PRESET = {
  "유소":   {cat:"미신고단시간", hourly:15000, rateTax:"세후", note:"유학비자로 인해 신고 X"},
  "육호청": {cat:"미신고단시간", daily:125000, rateTax:"세전"},
  "베라":   {cat:"미신고상용"},
  "양지수": {cat:"상용"}, "포가이": {cat:"상용"},
  "김보경": {cat:"일용", duty:"직원", daily:150000},
  "박진우": {cat:"일용", duty:"직원", daily:150000},
  "윤다영": {cat:"일용", slots:{"10:00~20:00":400000, "15:00~23:00":320000}},
  "이승연": {cat:"일용", daily:320000},
  "최예린": {cat:"일용", daily:400000}, "박효진": {cat:"일용", daily:400000}, "최은지": {cat:"일용", daily:400000},
  "안상연": {cat:"일용", daily:250000}, "임태환": {cat:"일용", daily:250000},
  "이유정": {cat:"일용", daily:300000}, "노형중": {cat:"일용", daily:300000},
  "김수현": {cat:"일용", daily:300000},
};
/* 공휴일 참고표 — 출근부 휴일(DB.holidays)에 빠진 날을 알려주는 데만 쓴다 (계산은 DB.holidays 기준) */
const KR_HOLIDAYS = {
  "2026-01-01":"신정","2026-02-16":"설날","2026-02-17":"설날","2026-02-18":"설날","2026-03-02":"삼일절 대체",
  "2026-05-05":"어린이날","2026-05-25":"부처님오신날 대체","2026-06-03":"지방선거","2026-07-17":"제헌절",
  "2026-08-17":"광복절 대체","2026-09-24":"추석","2026-09-25":"추석","2026-09-26":"추석","2026-10-05":"개천절 대체",
  "2026-10-09":"한글날","2026-12-25":"성탄절",
  "2027-01-01":"신정","2027-02-08":"설날 대체","2027-02-09":"설날 연휴","2027-03-01":"삼일절","2027-05-05":"어린이날",
  "2027-05-13":"부처님오신날","2027-06-07":"현충일 대체","2027-07-17":"제헌절","2027-08-16":"광복절 대체",
  "2027-09-14":"추석","2027-09-15":"추석","2027-09-16":"추석","2027-10-04":"개천절 대체","2027-10-11":"한글날 대체","2027-12-27":"성탄절 대체",
};

let stlMonth = prevYm(ymNow());
let payTab = "info";        // "info" 급여정보 | "monthly" 월별 급여 데이터
let stlRrn = {};            // 지난달 파일에서 읽은 이름→주민번호 (화면 메모리에만, 저장 안 함)
let stlRrnFile = "";

function prevYm(ym){ const [y,m]=ym.split("-").map(Number); const d=new Date(y,m-2,1); return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0"); }
function setPayTab(t){ payTab=t; render(); }
function stlShift(n){ const [y,m]=stlMonth.split("-").map(Number); const d=new Date(y,m-1+n,1); stlMonth=d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0"); render(); }
function yymm(ym){ return Number(ym.slice(2,4)+ym.slice(5,7)); }
function monthNo(ym){ return Number(ym.slice(5,7)); }
function num(n){ return Number(n||0).toLocaleString("ko-KR"); }
function hrs(h){ return (Math.round(h*100)/100)+"시간"; }

/* ---- 직원별 정산 설정 ---- */
function payCfg(e){
  const base = {cat: e.empType==="정규직" ? "상용" : "일용", duty: e.role==="약무" ? "약사" : "직원",
    holidayMode: e.role==="약무" ? "금액" : "시간", holidayAmount: 100000,
    closeRate: e.role==="약무" ? 100000 : 80000, closeTax: e.role==="약무" ? "세후" : "세전",
    rateTax: "세후", slots:{}, daily:null, hourly:null, note:""};
  /* 앱에 등록된 시급·일급이 있으면 일당 계산에 쓴다 */
  if(e.payType==="DAILY" && e.payAmount) base.daily=Number(e.payAmount);
  if(e.payType==="HOURLY" && e.payAmount) base.hourly=Number(e.payAmount);
  return {...base, ...(PAYROLL_PRESET[e.name]||{}), ...((DB.payrollConfig||{})[e.id]||{})};
}
function empInMonth(e, ym){
  const first=ym+"-01", last=ym+"-"+String(daysInMonth(ym)).padStart(2,"0");
  if((e.joinDate||"").slice(0,10) > last) return false;
  if(e.leaveDate && e.leaveDate.slice(0,10) < first) return false;
  if(e.status==="퇴사" && !e.leaveDate) return false;
  return true;
}
function spanHours(start, end){ const a=toMin(start); let b=toMin(end); if(a==null||b==null) return null; if(b<=a) b+=24*60; return (b-a)/60; }
function breakHours(h){ return h<4 ? 0 : h<8 ? 0.5 : 1; }
/* 그 날 실제 근무 시간대 — 반차면 반차 구간 */
function workWindow(e, day, info){
  const sh=shiftForDay(e.id, day);
  if(!sh.on) return null;
  if(info.st==="반차"){ const w=halfWindow(info.hs&&info.hs.start||sh.start, info.hs&&info.hs.end||sh.end); return {start:w.start, end:w.end}; }
  return {start:sh.start, end:sh.end};
}
function dayRate(cfg, win){
  const slot = win ? win.start+"~"+win.end : "";
  if(slot && cfg.slots && cfg.slots[slot]) return {rate:Number(cfg.slots[slot]), how:slot};
  if(cfg.daily) return {rate:Number(cfg.daily), how:"일당"};
  if(cfg.hourly && win){ const h=spanHours(win.start, win.end); if(h) return {rate:Math.round(cfg.hourly*h), how:`시급×${h}h`}; }
  return null;
}

/* ---- 한 달 정산 ---- */
function computeSettlement(ym){
  const dim=daysInMonth(ym), M=monthNo(ym);
  const days=[...Array(dim)].map((_,i)=>ym+"-"+String(i+1).padStart(2,"0"));
  const sc=shiftChangeSummary(ym);
  const scBy=Object.fromEntries(sc.map(r=>[r.e.id,r]));
  const warns=[];
  const rows=DB.employees.filter(e=>empInMonth(e, ym)).map(e=>{
    const cfg=payCfg(e);
    const r={e, cfg, cat:cfg.cat, workDays:0, marks:{}, hours:0, closeCnt:0, holDays:0, holHours:0, holDates:[],
      pay:0, payParts:{}, lastWork:null, noRate:[], noTime:[], partDays:[]};
    days.forEach((day,i)=>{
      const info=attDayInfo(e, day);
      if(info.closed) r.closeCnt++;
      if(info.parts && info.parts.length) r.partDays.push(day);
      if(!info.work) return;
      r.workDays+=info.work; r.marks[i+1]=info.work; r.lastWork=day;
      const win=workWindow(e, day, info);
      const h=win?spanHours(win.start, win.end):null;
      if(h==null) r.noTime.push(day); else r.hours+=h;
      if(info.isHol){ r.holDays+=info.work; r.holDates.push(day); if(h!=null) r.holHours+=h-breakHours(h); }
      if(cfg.cat==="일용" || cfg.cat==="미신고단시간"){
        let pr=null;
        if(cfg.cat==="미신고단시간") pr = cfg.hourly ? (h!=null?{rate:cfg.hourly*h, how:"시급"}:null) : cfg.daily ? {rate:cfg.daily, how:"일당"} : null;
        else pr=dayRate(cfg, win);
        if(!pr){ r.noRate.push(day); return; }
        const amt=Math.round(pr.rate*(cfg.cat==="일용"?info.work:1));
        r.pay+=amt; const k=pr.how; (r.payParts[k]=r.payParts[k]||{rate:pr.rate, n:0, sum:0}); r.payParts[k].n+=info.work; r.payParts[k].sum+=amt;
      }
    });
    const s=scBy[e.id];
    r.absent = s ? s.무급 : 0;
    r.timeOff = s ? s.시간 : 0; r.timeOffN = s ? s.시간건 : 0;
    r.closePay = r.closeCnt*Number(cfg.closeRate||0);
    r.holPay = cfg.holidayMode==="금액" ? r.holDays*Number(cfg.holidayAmount||0) : 0;
    const join=(e.joinDate||"").slice(0,10), leave=(e.leaveDate||"").slice(0,10);
    r.joined = join.slice(0,7)===ym ? join : null;
    r.left = leave.slice(0,7)===ym ? leave : null;
    if(r.joined && cfg.cat==="상용"){
      const jd=Number(r.joined.slice(8,10)); r.prorate={k:dim-jd+1, dim, amt: e.payAmount ? Math.round(Number(e.payAmount)*(dim-jd+1)/dim) : null};
      if(!e.payAmount) warns.push({e, msg:`${M}월 입사 정규직인데 급여관리에 급여액이 없어요 — 입사 시트 월급·일할 금액이 비어요`});
    }
    if(r.partDays.length && (cfg.cat==="미신고단시간"||cfg.cat==="일용") && cfg.hourly) warns.push({e, msg:`근무시간 일부 이동 — ${r.partDays.map(d=>Number(d.slice(8))+"일").join(", ")} (근무일수는 그대로, 시급 시간은 근무표 기준이라 옮긴 시간만큼 확인 필요)`});
    if(r.noRate.length) warns.push({e, msg:`단가 미설정 — ${r.noRate.map(d=>Number(d.slice(8))+"일").join(", ")} 근무의 일당을 계산할 수 없어요 (정산 설정에서 일당·시급 입력)`});
    if(r.noTime.length && (cfg.cat==="미신고단시간" || (r.holDates.length && cfg.holidayMode==="시간")))
      warns.push({e, msg:`근무표 시간이 없는 출근 — ${r.noTime.map(d=>Number(d.slice(8))+"일").join(", ")} (근무표에 시간 등록 필요)`});
    return r;
  }).filter(r=>r.cat!=="제외");
  /* 출근부 휴일에 빠진 공휴일 */
  const missingHol=days.filter(d=>KR_HOLIDAYS[d] && !(DB.holidays||[]).includes(d));
  rows.sort((a,b)=>PAY_CATS.findIndex(c=>c.key===a.cat)-PAY_CATS.findIndex(c=>c.key===b.cat) || (a.e.employeeNo||0)-(b.e.employeeNo||0));
  return {ym, M, dim, rows, warns, missingHol};
}

/* ---- 화면 ---- */
function renderPayrollTabs(){
  return `<div class="toolbar"><div class="seg">
    <button class="btn sm${payTab==="info"?" active":""}" onclick="setPayTab('info')">급여정보</button>
    <button class="btn sm${payTab==="monthly"?" active":""}" onclick="setPayTab('monthly')">월별 급여 데이터</button>
  </div></div>`;
}
function renderSettlement(){
  const S=computeSettlement(stlMonth), M=S.M;
  const by=k=>S.rows.filter(r=>r.cat===k);
  const ilyong=by("일용").filter(r=>r.workDays), part=by("미신고단시간").filter(r=>r.workDays);
  const sum=(a,f)=>a.reduce((s,r)=>s+f(r),0);
  const kpi=(label,val,sub)=>`<div class="kpi"><div class="label">${label}</div><div class="val" style="font-size:22px">${val}</div>${sub?`<div class="hint">${sub}</div>`:""}</div>`;
  const holTxt=r=>!r.holDays ? "—" : !["상용","미신고상용"].includes(r.cat) ? `${fmtDays(r.holDays)}일` : (r.cfg.holidayMode==="금액" ? `${fmtDays(r.holDays)}일 · ${won(r.holPay)}` : r.cfg.holidayMode==="시간" ? `${fmtDays(r.holDays)}일 · ${hrs(r.holHours)}` : `${fmtDays(r.holDays)}일`);
  const closeTxt=r=>r.closeCnt ? (["상용","미신고상용"].includes(r.cat) && r.cfg.closeRate ? `${r.closeCnt}회 · ${won(r.closePay)} <span class="hint">${r.cfg.closeTax}</span>` : `${r.closeCnt}회`) : "—";
  const payTxt=r=>{
    if(r.cat==="일용"||r.cat==="미신고단시간") return r.pay?`<b>${won(r.pay)}</b>${r.noRate.length?' <span class="tag t-bad">단가 없음</span>':""}`:(r.noRate.length?'<span class="tag t-bad">단가 없음</span>':"—");
    if(r.prorate) return `일할 ${r.prorate.k}/${r.prorate.dim}${r.prorate.amt!=null?` · ${won(r.prorate.amt)}`:""}`;
    return '<span class="hint">월급제</span>';
  };
  const tags=r=>[r.joined?`<span class="tag t-ok">입사 ${Number(r.joined.slice(5,7))}/${Number(r.joined.slice(8))}</span>`:"", r.left?`<span class="tag t-gray">퇴사 ${Number(r.left.slice(5,7))}/${Number(r.left.slice(8))}</span>`:""].join(" ");
  const table = PAY_CATS.filter(c=>c.key!=="제외" && by(c.key).length).map(c=>{
    const list=by(c.key);
    return `<tr class="grp-row"><td colspan="8"><b>${c.label}</b> <span class="hint">${list.length}명 · ${c.hint}</span></td></tr>`+
      list.map(r=>`<tr>
        <td><span class="name">${esc(r.e.name)}</span> ${tags(r)}</td>
        <td class="num">${r.workDays?fmtDays(r.workDays)+"일":"—"}${r.cat==="미신고단시간"&&r.hours?` <span class="hint">${hrs(r.hours)}</span>`:""}</td>
        <td class="num">${holTxt(r)}</td>
        <td class="num">${closeTxt(r)}</td>
        <td class="num">${r.absent?`<b style="color:var(--bad)">${r.absent}일</b>`:"—"}</td>
        <td class="num">${r.timeOff?`−${fmtHM(r.timeOff)}`:"—"}</td>
        <td class="num">${payTxt(r)}</td>
        <td class="num"><button class="btn sm ghost" onclick="openPayCfg(${r.e.id})">설정</button></td>
      </tr>`).join("");
  }).join("");
  const warnList=[
    ...S.missingHol.length?[`<li>출근부 휴일에 <b>${S.missingHol.map(d=>`${Number(d.slice(5,7))}/${Number(d.slice(8))} ${KR_HOLIDAYS[d]}`).join(", ")}</b>이 빠져 있어요 — 휴일근로가 계산되지 않습니다. <button class="btn sm" onclick="stlAddHolidays()">휴일로 등록</button></li>`]:[],
    ...S.warns.map(w=>`<li><b>${esc(w.e.name)}</b> ${esc(w.msg)}</li>`),
  ];
  return `
  <div class="toolbar">
    <button class="btn sm" onclick="stlShift(-1)">‹ 이전달</button>
    <input type="month" value="${stlMonth}" onchange="stlMonth=this.value; render()" style="padding:8px 11px; border:1px solid var(--border-strong); border-radius:9px">
    <button class="btn sm" onclick="stlShift(1)">다음달 ›</button>
    <div class="grow"></div>
    <button class="btn primary" onclick="downloadWorktime()" ${part.length?"":"disabled title='이 달에 근무한 미신고 단시간 인원이 없어요'"}>⬇ 근무시간기록표</button>
    <button class="btn primary" onclick="downloadPayrollChanges()">⬇ 급여변경사항</button>
  </div>
  <div class="kpis" style="margin-bottom:16px">
    ${kpi("일용직 총급여", won(sum(ilyong,r=>r.pay)), `${ilyong.length}명 · ${fmtDays(sum(ilyong,r=>r.workDays))}일`)}
    ${kpi("미신고 단시간", won(sum(part,r=>r.pay)), part.map(r=>esc(r.e.name)).join(", ")||"—")}
    ${kpi("마감수당", won(sum(S.rows.filter(r=>["상용","미신고상용"].includes(r.cat)),r=>r.closePay)), `${sum(S.rows.filter(r=>["상용","미신고상용"].includes(r.cat)),r=>r.closeCnt)}회`)}
    ${kpi(`${M}월 입사·퇴사`, `${S.rows.filter(r=>r.joined&&["상용","일용"].includes(r.cat)).length} · ${S.rows.filter(r=>r.left&&["상용","일용"].includes(r.cat)).length}`, "신고 인원 기준")}
  </div>
  ${warnList.length?`<div class="panel" style="margin-bottom:16px;border-color:#FCD34D;background:#FFFBEB"><div class="p-head"><h2>확인 필요 <span class="hint">${warnList.length}건</span></h2></div><ul style="margin:0 0 6px 18px;line-height:1.8">${warnList.join("")}</ul></div>`:""}
  <div class="panel"><div class="att-wrap"><table>
    <thead><tr><th>직원</th><th class="num">근무일</th><th class="num">휴일근로</th><th class="num">마감</th><th class="num">결근<div class="hint">무급</div></th><th class="num">시간 차감<div class="hint">지각·조퇴·외출</div></th><th class="num">일당 합계·일할</th><th></th></tr></thead>
    <tbody>${table||`<tr><td colspan="8"><div class="empty">${M}월에 재직한 직원이 없어요</div></td></tr>`}</tbody>
  </table></div></div>
  <div class="panel" style="margin-top:16px"><div class="p-head"><h2>주민등록번호 채우기 <span class="hint">선택</span></h2></div>
    <div class="hint" style="line-height:1.7">HR 앱에는 주민등록번호를 저장하지 않아요. 지난달 <b>급여변경사항</b> 엑셀을 고르면 이름이 같은 사람의 주민등록번호를 이번 파일에 옮겨 적습니다. 파일은 이 브라우저 안에서만 읽고 어디에도 저장하지 않아요.</div>
    <div style="margin-top:8px;display:flex;gap:8px;align-items:center"><input type="file" accept=".xlsx" onchange="stlLoadRrn(this.files[0])">
    ${stlRrnFile?`<span class="tag t-ok">${esc(stlRrnFile)} · ${Object.keys(stlRrn).length}명 읽음</span>`:""}</div>
  </div>
  <div class="legend"><span><b>근무일·마감·휴일</b> 출근부와 같은 기준 (반차 0.5일, 조퇴한 날 마감 제외)</span><span><b>휴일근로 시간</b> 출근부 휴일에 근무한 시간 − 휴게 (4시간 미만 없음 · 8시간 미만 30분 · 8시간 이상 1시간)</span><span><b>일당</b> 시간대별 일당 → 기본 일당 → 시급×근무시간</span><span><b>일할</b> 월 중간 입사 정규직은 입사일~말일 역일 기준</span><span><b>직접 입력</b> 경영성과·개인성과 인센티브, 연장근로, 퇴사 사유, 급여 변경</span></div>`;
}
function stlAddHolidays(){
  const S=computeSettlement(stlMonth);
  DB.holidays=DB.holidays||[]; S.missingHol.forEach(d=>{ if(!DB.holidays.includes(d)) DB.holidays.push(d); });
  saveDB(); render(); toast("휴일로 등록했습니다");
}

/* ---- 직원별 정산 설정 ---- */
function slotsText(slots){ return Object.entries(slots||{}).map(([k,v])=>`${k}=${v}`).join("\n"); }
function parseSlots(t){ const o={}; String(t||"").split(/\n|,/).forEach(l=>{ const m=/^\s*(\d{1,2}:\d{2})\s*[~\-]\s*(\d{1,2}:\d{2})\s*=\s*([\d,]+)\s*$/.exec(l); if(m) o[m[1].padStart(5,"0")+"~"+m[2].padStart(5,"0")]=Number(m[3].replace(/,/g,"")); }); return o; }
function openPayCfg(id){
  const e=DB.employees.find(x=>x.id===id); if(!e) return;
  const c=payCfg(e);
  const opt=(list,v)=>list.map(x=>`<option value="${x.key??x}" ${(x.key??x)===v?"selected":""}>${x.label??x}</option>`).join("");
  modal(`${esc(e.name)} 정산 설정`, `
  <div class="grid2">
    <div class="field full"><label>정산 구분</label><select id="pc_cat">${opt(PAY_CATS,c.cat)}</select></div>
    <div class="field"><label>담당업무 (일용직 표)</label><select id="pc_duty">${opt(["약사","직원"],c.duty)}</select></div>
    <div class="field"><label>단가 세전/세후 (미신고 단시간)</label><select id="pc_ratetax">${opt(["세후","세전"],c.rateTax)}</select></div>
    <div class="field"><label>기본 일당</label><input id="pc_daily" type="number" min="0" value="${c.daily??""}" placeholder="원"></div>
    <div class="field"><label>시급</label><input id="pc_hourly" type="number" min="0" value="${c.hourly??""}" placeholder="원"></div>
    <div class="field full"><label>시간대별 일당 <span class="hint">한 줄에 하나 · 예: 10:00~20:00=400000</span></label><textarea id="pc_slots" rows="3" style="width:100%">${esc(slotsText(c.slots))}</textarea></div>
    <div class="field"><label>휴일근로</label><select id="pc_holmode">${opt([{key:"시간",label:"시간으로 기입"},{key:"금액",label:"1일당 금액"},{key:"없음",label:"없음"}],c.holidayMode)}</select></div>
    <div class="field"><label>휴일근로 1일 금액 (세후)</label><input id="pc_holamt" type="number" min="0" value="${c.holidayAmount??""}"></div>
    <div class="field"><label>마감수당 1회</label><input id="pc_close" type="number" min="0" value="${c.closeRate??""}"></div>
    <div class="field"><label>마감수당 세전/세후</label><select id="pc_closetax">${opt(["세전","세후"],c.closeTax)}</select></div>
    <div class="field full"><label>비고 (미신고 인원 급여현황표·기록표에 표기)</label><input id="pc_note" value="${esc(c.note||"")}" placeholder="예: 유학비자로 인해 신고 X"></div>
  </div>
  <div class="hint" style="margin-top:6px">정규직 월급은 <b>급여정보</b> 탭의 급여형태·급여액을 씁니다.</div>`, [
    `<button class="btn ghost" onclick="resetPayCfg(${id})">초기값으로</button>`,
    `<button class="btn" onclick="closeModal()">취소</button>`,
    `<button class="btn primary" onclick="savePayCfg(${id})">저장</button>`,
  ]);
}
function savePayCfg(id){
  const n=v=>v===""?null:Number(v);
  DB.payrollConfig=DB.payrollConfig||{};
  DB.payrollConfig[id]={cat:val("pc_cat"), duty:val("pc_duty"), rateTax:val("pc_ratetax"), daily:n(val("pc_daily")), hourly:n(val("pc_hourly")),
    slots:parseSlots(document.getElementById("pc_slots").value), holidayMode:val("pc_holmode"), holidayAmount:n(val("pc_holamt")),
    closeRate:n(val("pc_close")), closeTax:val("pc_closetax"), note:val("pc_note")};
  saveDB(); closeModal(); render(); toast("정산 설정을 저장했습니다");
}
function resetPayCfg(id){ if(DB.payrollConfig) delete DB.payrollConfig[id]; saveDB(); closeModal(); render(); toast("초기값으로 되돌렸습니다"); }

/* ---- 지난달 파일에서 주민등록번호 읽기 ---- */
function normName(s){ return String(s||"").replace(/\(.*?\)/g,"").replace(/\s+/g,"").trim(); }
async function stlLoadRrn(file){
  if(!file) return;
  try{
    await loadExcelJS();
    const wb=new ExcelJS.Workbook(); await wb.xlsx.load(await file.arrayBuffer());
    const map={};
    wb.eachSheet(ws=>ws.eachRow(row=>{
      const nm=normName(cellText(row.getCell(2))), rrn=cellText(row.getCell(3)).trim();
      if(nm && nm!=="홍길동" && /^\d{6}-?\d{7}$/.test(rrn) && !/^0{6}/.test(rrn)) map[nm]=rrn;
    }));
    stlRrn=map; stlRrnFile=file.name; render(); toast(`${Object.keys(map).length}명의 주민등록번호를 읽었습니다`);
  }catch(err){ console.error(err); toast("엑셀 파일을 읽지 못했어요"); }
}
function cellText(c){ const v=c&&c.value; if(v==null) return ""; if(typeof v==="object"){ if(v.richText) return v.richText.map(t=>t.text).join(""); if(v.result!=null) return String(v.result); if(v.text) return String(v.text); } return String(v); }
function rrnOf(e){ return stlRrn[normName(e.name)] || null; }

/* ---- 엑셀 ---- */
let excelJsP=null;
function loadExcelJS(){
  if(window.ExcelJS) return Promise.resolve();
  return excelJsP ||= new Promise((ok,ng)=>{ const s=document.createElement("script"); s.src="vendor/exceljs.min.js"; s.onload=ok; s.onerror=()=>{ excelJsP=null; ng(new Error("exceljs")); }; document.head.appendChild(s); });
}
async function loadTemplate(name){
  await loadExcelJS();
  /* 양식은 서버가 관리자 로그인 토큰을 확인한 뒤에만 내려준다 */
  const res=await fetch("/api/payroll-template/"+encodeURIComponent(name), {cache:"no-store", headers:{Authorization:"Bearer "+adminToken()}});
  if(res.status===403){ const e=new Error("admin_only"); e.adminOnly=true; throw e; }
  if(!res.ok) throw new Error("template "+res.status);
  const buf=await res.arrayBuffer();
  const wb=new ExcelJS.Workbook(); await wb.xlsx.load(buf); return wb;
}
async function saveWorkbook(wb, filename){
  const buf=await wb.xlsx.writeBuffer();
  const blob=new Blob([buf],{type:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"});
  const a=document.createElement("a"); a.href=URL.createObjectURL(blob); a.download=filename; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(a.href), 4000);
  toast(filename+" 저장");
}
function xDate(s){ const p=String(s).slice(0,10).split("-").map(Number); return new Date(Date.UTC(p[0],p[1]-1,p[2])); }
function dotDate(s){ return String(s||"").slice(0,10).replace(/-/g,"."); }
/* 표 행이 모자라면 마지막 행 서식을 복사해 늘린다 — 늘린 만큼 아래 행이 밀린다 */
function ensureRows(ws, first, last, n){ const extra=n-(last-first+1); if(extra>0) ws.duplicateRow(last, extra, true); return Math.max(0,extra); }
function numberRows(ws, first, count, col=1){ for(let i=0;i<count;i++) ws.getCell(first+i, col).value=i+1; }
function cloneSheet(wb, src, name){
  const ws=wb.addWorksheet(name, {properties:{...src.properties}, pageSetup:{...src.pageSetup}, views:src.views});
  (src.columns||[]).forEach((c,i)=>{ const col=ws.getColumn(i+1); if(c.width) col.width=c.width; if(c.hidden) col.hidden=true; });
  src.eachRow({includeEmpty:true},(row,r)=>{ const nr=ws.getRow(r); if(row.height) nr.height=row.height;
    row.eachCell({includeEmpty:true},(cell,c)=>{ const nc=nr.getCell(c); nc.value=cell.value; nc.style=JSON.parse(JSON.stringify(cell.style||{})); if(cell.note) nc.note=cell.note; }); });
  (src.model.merges||[]).forEach(m=>ws.mergeCells(m));
  return ws;
}

async function downloadWorktime(){
  if(!isOwner()){ toast("급여 파일 추출은 관리자 로그인만 가능해요"); return; }
  try{
    const S=computeSettlement(stlMonth), M=S.M;
    const list=S.rows.filter(r=>r.cat==="미신고단시간" && r.workDays);
    if(!list.length){ toast("이 달에 근무한 미신고 단시간 인원이 없어요"); return; }
    const wb=await loadTemplate("worktime-template.xlsx");
    const tpl=wb.getWorksheet("TEMPLATE");
    list.forEach(r=>{
      const ws=cloneSheet(wb, tpl, r.e.name.slice(0,31)), c=r.cfg, hourly=!!c.hourly;
      ws.getCell("C4").value=r.e.name;
      ws.getCell("C6").value=xDate(stlMonth+"-01");
      ws.getCell("H5").value = hourly ? "휴게시간 차감 안함" : null;
      ws.getCell("H6").value = c.note || "신고 X";
      ws.getCell("I6").value = hourly ? `시급 ${num(c.hourly)}원 (${c.rateTax})` : `일급 ${num(c.daily)}원 (${c.rateTax})`;
      ws.getCell("H7").value = `${M}월 ${fmtDays(r.workDays)}일${hourly?` · ${hrs(r.hours)}`:""} · ${num(r.pay)}원`;
      for(let d=1; d<=S.dim; d++){
        const day=stlMonth+"-"+String(d).padStart(2,"0"), row=8+d;
        if(!r.marks[d]) continue;
        ws.getCell(row,3).value="근무";
        if(hourly){
          const w=workWindow(r.e, day, attDayInfo(r.e, day));
          if(w){ const a=toMin(w.start)/60; let z=toMin(w.end)/60; if(z<=a) z+=24; ws.getCell(row,4).value=a; ws.getCell(row,6).value=z; }   // 제출본과 같이 숫자(서식 0.0"시")
        } else ws.getCell(row,4).value=r.marks[d];
      }
      if(!hourly) ws.getCell("D40").value=`${fmtDays(r.workDays)}일`;
    });
    wb.removeWorksheet(tpl.id);
    await saveWorkbook(wb, `${M}월_근무시간기록표_단시간사업소득_${STORE_FILE_NAME}.xlsx`);
  }catch(err){ console.error(err); toast(err.adminOnly ? "급여 파일 추출은 관리자 로그인만 가능해요 — 다시 로그인해 주세요" : "근무시간기록표를 만들지 못했어요"); }
}

async function downloadPayrollChanges(){
  if(!isOwner()){ toast("급여 파일 추출은 관리자 로그인만 가능해요"); return; }
  try{
    const S=computeSettlement(stlMonth), M=S.M, YM=yymm(stlMonth);
    const wb=await loadTemplate("payroll-changes-template.xlsx");
    const reported=S.rows.filter(r=>r.cat==="상용"||r.cat==="일용");
    const label=e=>e.visa?`${e.name}(${e.visa})`:e.name;

    /* 입사 — 신고 인원 중 이 달 입사 */
    { const ws=wb.getWorksheet("입사"), list=reported.filter(r=>r.joined);
      ensureRows(ws, 3, 25, list.length);
      list.forEach((r,i)=>{ const e=r.e, c=r.cfg, row=3+i;
        ws.getCell(row,1).value=i+1; ws.getCell(row,2).value=e.name; ws.getCell(row,3).value=rrnOf(e); ws.getCell(row,4).value=dotDate(r.joined);
        if(r.cat==="상용"){
          const net=e.payType==="MONTHLY_NET", amt=e.payAmount?Number(e.payAmount):null;
          ws.getCell(row,5).value = amt ? `${net?"세후":"세전"} 월 ${num(amt)}` : null;
          if(amt) ws.getCell(row, net?6:7).value=amt;
          ws.getCell(row,8).value=`정규직${e.weeklyWorkDays?` 주 ${e.weeklyWorkDays}일`:""}`;
          if(r.prorate && r.prorate.k<r.prorate.dim) ws.getCell(row,9).value=`${M}/${Number(r.joined.slice(8))} 입사 → ${M}월 일할 ${r.prorate.k}/${r.prorate.dim}${r.prorate.amt!=null?` = ${num(r.prorate.amt)}원(${net?"세후":"세전"})`:""}`;
        } else {
          const parts=Object.entries(c.slots||{}).map(([k,v])=>`${k} ${num(v)}`);
          ws.getCell(row,5).value = parts.length ? `일급 ${parts.join(" / ")}` : c.daily ? `일급 ${num(c.daily)}` : c.hourly ? `시급 ${num(c.hourly)}` : null;
          ws.getCell(row,8).value="일용직";
        }
      });
      if(!list.length) ws.getCell("I3").value=`※ ${M}월 입사자 없음 (HR 앱 기준)`;
    }
    /* 퇴사 */
    { const ws=wb.getWorksheet("퇴사"), list=reported.filter(r=>r.left);
      ensureRows(ws, 4, 23, list.length);
      list.forEach((r,i)=>{ const row=4+i;
        ws.getCell(row,1).value=i+1; ws.getCell(row,2).value=r.e.name; ws.getCell(row,3).value=rrnOf(r.e);
        ws.getCell(row,4).value=r.e.joinDate?xDate(r.e.joinDate):null; ws.getCell(row,5).value=xDate(r.lastWork||r.left); });
      if(!list.length) ws.getCell("F4").value=`※ ${M}월 퇴사자 없음 (HR 앱 기준)`;
    }
    /* 수당 / 수당_미신고인원 — 열 위치가 조금 다르다 */
    const fillAllowance=(name, cat, col, capLast)=>{
      const ws=wb.getWorksheet(name), list=S.rows.filter(r=>r.cat===cat);
      const extra=ensureRows(ws, 4, capLast, list.length);
      list.forEach((r,i)=>{ const row=4+i, c=r.cfg, notes=[];
        ws.getCell(row,1).value=i+1; ws.getCell(row,2).value=label(r.e);
        ws.getCell(row,3).value=r.e.joinDate?xDate(r.e.joinDate):null;
        if(r.left) ws.getCell(row,4).value=xDate(r.left);
        if(r.holDays){
          const ds=r.holDates.map(d=>`${Number(d.slice(5,7))}/${Number(d.slice(8))}`).join("·");
          if(c.holidayMode==="금액"){ ws.getCell(row,col.holAmt).value=r.holPay; notes.push(`휴일 ${ds} 근무 ${fmtDays(r.holDays)}일 × ${num(c.holidayAmount)}원`); }
          else if(c.holidayMode==="시간"){ ws.getCell(row,col.holH).value=r.holHours; notes.push(`휴일 ${ds} 근무 ${hrs(r.holHours)} (휴게 제외)`); }
        }
        if(r.closeCnt && c.closeRate){ ws.getCell(row, c.closeTax==="세후"?col.closeNet:col.closeGross).value=r.closePay; notes.push(`마감 ${r.closeCnt}회 × ${num(c.closeRate)}원(${c.closeTax})`); }
        if(r.timeOff) ws.getCell(row,col.late).value=`${fmtHM(r.timeOff)} (${r.timeOffN}건)`;
        if(r.absent) ws.getCell(row,col.absent).value=`${r.absent}일`;
        if(r.joined) notes.push(`${M}/${Number(r.joined.slice(8))} 입사`);
        if(r.left) notes.push(`${M}/${Number(r.left.slice(8))} 퇴사`);
        ws.getCell(row,col.note).value=notes.join(" / ")||null;
      });
      numberRows(ws, 4, capLast-4+1+extra);
    };
    fillAllowance("수당", "상용", {holAmt:10, holH:11, closeNet:14, closeGross:15, late:16, absent:17, note:18}, 16);
    fillAllowance("수당_미신고인원", "미신고상용", {holAmt:10, holH:11, closeNet:15, closeGross:16, late:17, absent:18, note:19}, 5);
    /* 급여현황표_미신고인원 — 미신고 단시간 */
    { const ws=wb.getWorksheet("급여현황표_미신고인원"), list=S.rows.filter(r=>r.cat==="미신고단시간" && r.workDays);
      const extra=ensureRows(ws, 5, 14, list.length);
      list.forEach((r,i)=>{ const row=5+i, c=r.cfg;
        ws.getCell(row,2).value=r.e.name; ws.getCell(row,3).value=rrnOf(r.e); ws.getCell(row,4).value=YM; ws.getCell(row,5).value=r.pay||null;
        const rate = c.hourly ? `시급 ${num(c.hourly)}원 (${c.rateTax}) 지급` : `일급 ${num(c.daily)}원 (${c.rateTax})`;
        const work = c.hourly ? `${M}월 ${fmtDays(r.workDays)}일 ${hrs(r.hours)} 근무` : `${fmtDays(r.workDays)}일 근무`;
        ws.getCell(row,6).value=[rate, "주휴수당 X", c.note, work].filter(Boolean).join(" / ")+"\n현금 지급 예정 / 급여 계산만 부탁드리겠습니다";
      });
      numberRows(ws, 5, 10+extra);
    }
    /* 급여현황표_일용직 — 날짜별 1 표기, 합계 행은 데이터 행 전체를 더한다 */
    { const ws=wb.getWorksheet("급여현황표_일용직"), list=S.rows.filter(r=>r.cat==="일용" && r.workDays);
      const extra=ensureRows(ws, 5, 15, list.length), last=15+extra, tot=last+1;
      const colL=n=>{ let s=""; while(n>0){ const k=(n-1)%26; s=String.fromCharCode(65+k)+s; n=Math.floor((n-1)/26); } return s; };
      list.forEach((r,i)=>{ const row=5+i, c=r.cfg;
        ws.getCell(row,2).value=r.e.name; ws.getCell(row,3).value=rrnOf(r.e); ws.getCell(row,4).value=c.duty; ws.getCell(row,5).value=YM;
        ws.getCell(row,6).value={formula:`IFERROR(AM${row}/AL${row},0)`};
        for(let d=1; d<=31; d++) ws.getCell(row,6+d).value = r.marks[d] || null;
        ws.getCell(row,38).value={formula:`SUM(G${row}:AK${row})`};
        ws.getCell(row,39).value=r.pay||null;
        const parts=Object.entries(r.payParts);
        const notes=[];
        if(parts.length>1) notes.push(parts.map(([k,p])=>`${k} ${num(p.rate)}×${fmtDays(p.n)}일`).join(" / "));
        if(r.noRate.length) notes.push(`단가 미설정 ${r.noRate.length}일 — 확인 필요`);
        if(r.joined) notes.push(`${M}/${Number(r.joined.slice(8))} 입사`);
        if(r.left) notes.push(`${M}/${Number(r.left.slice(8))} 퇴사`);
        ws.getCell(row,40).value=notes.join(" / ")||null;
      });
      for(let row=5+list.length; row<=last; row++){ [6,38].forEach(c=>ws.getCell(row,c).value=null); }
      numberRows(ws, 5, last-5+1);
      for(let c=7; c<=39; c++) ws.getCell(tot,c).value={formula:`SUM(${colL(c)}5:${colL(c)}${last})`};
    }
    /* 이메일 — 신고 인원 */
    { const ws=wb.getWorksheet("이메일"), list=reported.filter(r=>r.cat==="상용" || r.workDays);
      const extra=ensureRows(ws, 4, 28, list.length);
      list.forEach((r,i)=>{ ws.getCell(4+i,2).value=label(r.e); ws.getCell(4+i,3).value=r.e.email||null; });
      numberRows(ws, 4, 25+extra);
    }
    await saveWorkbook(wb, `${M}월_급여변경사항_${STORE_FILE_NAME}_${YM}.xlsx`);
  }catch(err){ console.error(err); toast(err.adminOnly ? "급여 파일 추출은 관리자 로그인만 가능해요 — 다시 로그인해 주세요" : "급여변경사항을 만들지 못했어요"); }
}
