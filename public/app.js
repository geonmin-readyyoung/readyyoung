
/* =========================================================================
   인사관리 — 단일 파일 앱. 데이터는 브라우저 저장소(window.storage)에 자동 저장.
   구조/규칙은 레디영 부산지점 앱(Prisma schema, lib/leave.ts)을 기준으로 이식.
   ========================================================================= */

const ADMIN_PW = "admin1234";
const STAFF_PW = "staff2024"; // 일반 직원용 비밀번호(급여 정보 비공개)        // 필요시 이 값만 바꾸면 됨
const BRANCH   = "레디영약국";        // 지점명 표시용
const STORE_KEY = "hr_db_v1";

/* ---- 상수 (constants.ts 이식) ---- */
const ROLES = ["약무","통역","물류","기타"];
const EMP_TYPES = ["정규직","파트타임"];
const TEAMS = ["","중국어","일본어"]; function categoryDigit(role,team){ if(role==="약무") return 1; if(role==="통역") return team==="일본어"?3:2; if(role==="물류") return 4; return 9; } function subgroupDigit(empType,closingDuty){ if(empType!=="파트타임") return 0; return closingDuty?2:1; } function suggestEmployeeNo(role,team,empType,closingDuty,excludeId){ const cat=categoryDigit(role,team); const sub=subgroupDigit(empType,closingDuty); const prefix=cat*10+sub; let max=0; DB.employees.forEach(x=>{ if(x.id===excludeId) return; const n=Number(x.employeeNo); if(!n||n<10000||n>99999) return; if(Math.floor(n/1000)!==prefix) return; if(n>max) max=n; }); if(max>0) return max+1; return prefix*1000+1; }
const PAY_TYPES = [
  {value:"MONTHLY",label:"월급"},{value:"MONTHLY_NET",label:"세후월급"},
  {value:"HOURLY",label:"시급"},{value:"DAILY",label:"일급"},
];
const PAY_LABEL = Object.fromEntries(PAY_TYPES.map(p=>[p.value,p.label]));
const LEAVE_TYPES = ["연차","반차(오전)","반차(오후)","병가","기타"];
const LEAVE_STATUSES = ["승인","대기","반려"];
const DEDUCT_TYPES = ["연차","반차(오전)","반차(오후)"]; const LEAVE_ADJ_REASONS = ["근태불량","경조사","포상","오류정정","기타"];

/* ---- 상태 ---- */
let DB = { employees:[], leaves:[], attendance:{}, weeklySchedule:{}, seq:1 };
let view = "dashboard";
let attMonth = ymNow();let leaveViewAll=false;function toggleLeaveViewAll(){ leaveViewAll=!leaveViewAll; render(); }let leaveAdjExpandedId=null;function toggleLeaveAdjRow(empId){ leaveAdjExpandedId=leaveAdjExpandedId===empId?null:empId; render(); } function toggleHoliday(day){ DB.holidays=DB.holidays||[]; const i=DB.holidays.indexOf(day); if(i>=0) DB.holidays.splice(i,1); else DB.holidays.push(day); saveDB(); render(); }

/* =========================== 저장/로드 =========================== */
async function loadDB(){
  try{
    const r = await fetch("/api/db").then(x=>x.json());
    if(r && r.data){ DB = r.data; }
  }catch(e){ /* 최초 실행 = 데이터 없음 */ }
  DB.employees ||= []; DB.leaves ||= []; DB.attendance ||= {}; DB.weeklySchedule ||= {}; DB.seq ||= 1; DB.leaveAdjustments ||= []; DB.holidays||=[]; DB.shiftChanges ||= []; migrateEmployeeNoFormat(); syncAll();
}
let saveT=null;
function saveDB(){
  clearTimeout(saveT);
  saveT = setTimeout(async()=>{
    try{ await fetch("/api/db", { method:"PUT", headers:{"Content-Type":"application/json"}, body: JSON.stringify(DB) }); }
    catch(e){ toast("저장 실패 — 서버 연결을 확인하세요"); }
  }, 120);
}
function nextId(){ return DB.seq++; } function migrateEmployeeNoFormat(){ let changed=false; DB.employees.forEach(e=>{ const s=String(e.employeeNo||""); if(/^\d{4}$/.test(s)){ const sub=s[1]; if(sub==="2") e.closingDuty=true; const catSub=s.slice(0,2), seq=s.slice(2); e.employeeNo=Number(catSub+seq.padStart(3,"0")); changed=true; } }); if(changed) saveDB(); }

/* =========================== 날짜/연차 로직 =========================== */
function ymNow(){ const d=new Date(); return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0"); }
function todayStr(){ const d=new Date(); return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0"); }
function fmtDate(s){ return s ? s.slice(0,10).replace(/-/g,".") : "—"; }

// 근속 개월 (date.ts monthsSince 규칙: 일 기준 보정)
function monthsSince(joinStr, asOf=new Date()){
  if(!joinStr) return 0;
  const j = new Date(joinStr);
  let m = (asOf.getFullYear()-j.getFullYear())*12 + (asOf.getMonth()-j.getMonth());
  if(asOf.getDate() < j.getDate()) m -= 1;
  return Math.max(0, m);
}
// 누적 발생 (leave.ts accruedLeave)
function accruedLeave(joinStr, asOf=new Date()){
  const m = monthsSince(joinStr, asOf);
  if(m >= 12) return 15;
  return Math.min(m, 11);
}
// 잔여 요약 (leave.ts summarizeLeave)
function summarizeLeave(emp){
  const accrued = accruedLeave(emp.joinDate);
  const used = DB.leaves
    .filter(l=>l.employeeId===emp.id && l.status==="승인" && DEDUCT_TYPES.includes(l.leaveType))
    .reduce((s,l)=>s+Number(l.days||0),0);
  const adj = (DB.leaveAdjustments||[]).filter(a=>a.employeeId===emp.id).reduce((s,a)=>s+(a.direction==="추가"?Number(a.days||0):-Number(a.days||0)),0); const remaining = Math.round((accrued - used + adj)*10)/10;
  return { serviceMonths:monthsSince(emp.joinDate), accrued, used, adj, remaining };
}

/* =========================== 유틸 =========================== */
function esc(s){ return String(s??"").replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c])); }
function won(n){ return n==null||n===""?"—":Number(n).toLocaleString("ko-KR")+"원"; }
function toast(msg){ const t=document.getElementById("toast"); t.textContent=msg; t.classList.add("show"); clearTimeout(t._h); t._h=setTimeout(()=>t.classList.remove("show"),2000); }
function statusTag(s){ return s==="재직"?'<span class="tag t-ok">재직</span>':'<span class="tag t-gray">퇴사</span>'; }
function leaveStatusTag(s){ return s==="승인"?'<span class="tag t-ok">승인</span>':s==="대기"?'<span class="tag t-warn">대기</span>':'<span class="tag t-bad">반려</span>'; }

/* =========================== 라우팅 =========================== */
function setView(v){
  if(v==="payroll" && !isOwner()) return;
  view=v;
  document.querySelectorAll("#nav button").forEach(b=>b.classList.toggle("active", b.dataset.view===v));
  render();
}
function render(){
  const m=document.getElementById("main");
  if(view==="dashboard") m.innerHTML=renderDashboard();
  else if(view==="employees") m.innerHTML=renderEmployees();
  else if(view==="leaves") m.innerHTML=renderLeaves();
  else if(view==="attendance"){ if(attMode==="week"){ m.innerHTML=renderAttendanceWeek(); wireWeek(); } else { m.innerHTML=renderAttendance(); wireAttendance(); } }
  else if(view==="schedule"){ m.innerHTML=renderSchedule(); wireSchedule(); }
else if(view==="shiftchanges"){ m.innerHTML=renderShiftChanges(); }
else if(view==="payroll"){ m.innerHTML=renderPayroll(); }
}

/* =========================== 대시보드 =========================== */
function renderDashboard(){
  const emps=DB.employees;
  const active=emps.filter(e=>e.status==="재직");
  const parttime=active.filter(e=>e.empType==="파트타임").length;
  const pending=DB.leaves.filter(l=>l.status==="대기").length;
  const scPending=(DB.shiftChanges||[]).filter(c=>c.status==="대기").length;
  // 이번 달 입사자 / 잔여연차 낮은 직원
  const daily=dailyScheduleData(dashDate, active);
  const recent=[...active].sort((a,b)=>(b.joinDate||"").localeCompare(a.joinDate||"")).slice(0,5);

  if(emps.length===0){
    return `
    ${headHTML("대시보드","한눈에 보는 인력 현황")}
    <div class="panel"><div class="empty">
      <div class="big">아직 등록된 직원이 없어요</div>
      <div>직원 메뉴에서 첫 직원을 등록하면 여기에 현황이 표시됩니다.</div>
      <div style="margin-top:16px; display:flex; gap:8px; justify-content:center">
        <button class="btn primary" onclick="setView('employees')">직원 등록하러 가기</button>
        <button class="btn" onclick="seedSample()">샘플 데이터 채우기</button>
      </div>
    </div></div>`;
  }
  return `
  ${headHTML("대시보드","한눈에 보는 인력 현황")}
  <div class="kpis">
    <div class="kpi"><div class="label">재직 인원</div><div class="val">${active.length}<small>명</small></div></div>
    <div class="kpi"><div class="label">파트타임</div><div class="val">${parttime}<small>명</small></div></div>
    <div class="kpi"><div class="label">전체 등록</div><div class="val">${emps.length}<small>명</small></div></div>
    <div class="kpi"><div class="label">휴가 승인대기</div><div class="val">${pending}<small>건</small></div></div>
    <div class="kpi${scPending?' kpi-alert':''}" ${scPending?'style="cursor:pointer" onclick="setView(\'shiftchanges\')"':""}><div class="label">근무변경 대기</div><div class="val">${scPending}<small>건</small></div></div>
  </div>
  <div class="card-grid dash-grid">
    ${renderDailySchedulePanel(daily)}
    <div class="panel">
      <div class="p-head"><h2>최근 입사</h2><button class="btn sm ghost" onclick="setView('employees')">직원 전체</button></div>
      <table><tbody>
        ${recent.map(e=>`<tr class="row-click" onclick="openCard(${e.id})">
          <td><span class="name">${esc(e.name)}</span></td>
          <td><span class="tag t-ice">${esc(e.role)}</span></td>
          <td>${esc(e.empType)}${e.closingDuty?' <span class="hint">(마감)</span>':""}</td>
          <td class="num">${fmtDate(e.joinDate)}</td>
        </tr>`).join("")}
      </tbody></table>
    </div>
  </div>`;
}

/* ---- 대시보드: 일별 근무표 ---- */
let dashDate = todayStr();
function addDays(day, n){ const p=day.split("-").map(Number); const d=new Date(Date.UTC(p[0],p[1]-1,p[2]+n)); return d.toISOString().slice(0,10); }
function dowOf(day){ const p=day.split("-").map(Number); return new Date(Date.UTC(p[0],p[1]-1,p[2])).getUTCDay(); }
function dashMove(n){ dashDate = n===0 ? todayStr() : addDays(dashDate,n); render(); }
function dashPick(v){ if(v){ dashDate=v; render(); } }
function dailyScheduleData(day, active){
  const dow=dowOf(day);
  const working=[], off=[];
  active.forEach(e=>{
    const base=getSchedule(e.id,dow);
    const rec=DB.attendance[attKey(e.id,day)]||{};
    const w=rec.swap;
    if(w){
      if(w.role==="빠짐"){ off.push({e, why: w.absence==="연차"?"연차":(w.partnerId?`${empName(w.partnerId)}와 교대`:"근무변경")}); return; }
      const s2={on:true,start:w.start||base.start,end:w.end||base.end,close:!!rec.closeOverride};
      working.push({e,s:s2,note: w.role==="대체" ? `${empName(w.partnerId)} 대신` : "시간변경"});
      return;
    }
    if(rec.status==="연차"){ if(base.on) off.push({e,why:"연차"}); return; }
    if(rec.status==="휴무"||rec.status==="결근"){ if(base.on) off.push({e,why:rec.status}); return; }
    if(!base.on) return;
    const close = typeof rec.closeOverride==="boolean" ? rec.closeOverride : !!base.close;
    working.push({e,s:{...base,close},note:""});
  });
  working.sort((a,b)=>(a.s.start||"").localeCompare(b.s.start||"") || (a.s.end||"").localeCompare(b.s.end||"") || (a.e.employeeNo||0)-(b.e.employeeNo||0));
  // 근무 타입별 그룹
  const groups=[];
  working.forEach(x=>{
    const key=x.s.start+"~"+x.s.end;
    let g=groups.find(g=>g.key===key);
    if(!g){ const tid=shiftTypeOf(x.s); const t=getShiftTypes().find(t=>t.id===tid); g={key, tid, name:t?t.name:"", start:x.s.start, end:x.s.end, rows:[]}; groups.push(g); }
    g.rows.push(x);
  });
  const closing=working.filter(x=>x.s.close).length;
  return {day, dow, working, off, groups, closing, holiday:(DB.holidays||[]).includes(day)};
}
function shiftColors(tid){ return tid==="custom" ? {bg:"#E4F5EC", fg:"#1F9D64"} : shiftColorFor(tid); }
function shiftChipStyle(tid){ const c=shiftColors(tid); return `background:${c.bg};color:${c.fg}`; }
function roleTag(e){
  if(e.role==="통역" && e.team==="중국어") return '<span class="tag t-cn">중국어</span>';
  if(e.role==="통역" && e.team==="일본어") return '<span class="tag t-jp">일본어</span>';
  return `<span class="tag t-ice">${esc(e.role||"")}</span>`;
}
function renderDailySchedulePanel(d){
  const isToday = d.day===todayStr();
  const p=d.day.split("-").map(Number);
  const title=`${p[1]}월 ${p[2]}일 (${DOW_LABELS[d.dow]})`;
  const nav=`<div class="day-nav">
      <button class="btn sm" onclick="dashMove(-1)" aria-label="이전 날">◀</button>
      <label class="day-pick"><input type="date" value="${d.day}" onchange="dashPick(this.value)"><span class="${d.dow===0||d.holiday?"we":d.dow===6?"sat":""}">${title}</span></label>
      <button class="btn sm" onclick="dashMove(1)" aria-label="다음 날">▶</button>
      ${isToday?'<span class="tag t-ok">오늘</span>':'<button class="btn sm ghost" onclick="dashMove(0)">오늘</button>'}
    </div>`;
  const summary=`<div class="day-sum">
      <span>근무 <b>${d.working.length}</b>명</span>
      ${d.groups.map(g=>`<span class="chip" style="${shiftChipStyle(g.tid)}">${g.start}~${g.end} <b>${g.rows.length}</b></span>`).join("")}
      ${d.closing?`<span>마감 <b class="close-tag">${d.closing}</b>명</span>`:""}
      ${d.off.length?`<span>휴가·빠짐 <b>${d.off.length}</b>명</span>`:""}
      ${d.holiday?'<span class="tag t-bad">공휴일</span>':""}
    </div>`;
  const body = d.working.length ? `<table class="day-table"><tbody>
      ${d.groups.map(g=>`
        <tr class="grp"><td colspan="3"><span class="grp-bar" style="background:${shiftColors(g.tid).fg}"></span>${g.name&&g.tid!=="custom"?esc(g.name)+" · ":""}${g.start}~${g.end} <span class="hint">${g.rows.length}명</span></td></tr>
        ${g.rows.map(({e,s,note})=>`<tr class="row-click" onclick="openCard(${e.id})">
          <td><span class="name">${esc(e.name)}</span>${note?` <span class="tag t-swap">${esc(note)}</span>`:""}</td>
          <td>${roleTag(e)}</td>
          <td class="num"><span class="chip" style="${shiftChipStyle(g.tid)}">${s.start}~${s.end}</span>${s.close?' <b class="close-tag">(마감)</b>':""}</td>
        </tr>`).join("")}`).join("")}
    </tbody></table>` : `<div class="empty" style="padding:28px">이 날 근무 예정인 직원이 없어요.</div>`;
  const offList = d.off.length ? `<div class="day-off"><span class="hint">휴가·빠짐</span>${d.off.map(({e,why})=>`<span class="off-chip" onclick="openCard(${e.id})">${esc(e.name)} <small>${esc(why)}</small></span>`).join("")}</div>` : "";
  return `<div class="panel">
      <div class="p-head"><h2>일별 근무표</h2><button class="btn sm ghost" onclick="setView('schedule')">근무표 전체</button></div>
      <div class="day-head">${nav}${summary}</div>
      ${body}${offList}
    </div>`;
}

/* =========================== 직원 목록 =========================== */
let empFilter={q:"",role:"",empType:"",status:"재직",team:""};
function renderEmployees(){
  const f=empFilter;
  let list=DB.employees.filter(e=>
    (!f.q || e.name.includes(f.q) || String(e.employeeNo||"").includes(f.q)) &&
    (!f.role || e.role===f.role) &&
    (!f.empType || e.empType===f.empType) && (!f.team || e.team===f.team) &&
    (!f.status || e.status===f.status)
  ).sort((a,b)=>(a.employeeNo||0)-(b.employeeNo||0));

  return `
  ${headHTML("직원","인사기록 · 입사/퇴사 관리", `<button class="btn primary" onclick="openForm()">＋ 입사 등록</button>`)}
  <div class="toolbar">
    <input type="text" placeholder="이름·사번 검색" value="${esc(f.q)}" oninput="empFilter.q=this.value; softRerender()" style="min-width:180px">
    <select onchange="empFilter.role=this.value; render()"><option value="">직무 전체</option>${ROLES.map(r=>`<option ${f.role===r?"selected":""}>${r}</option>`).join("")}</select>
    <select onchange="empFilter.empType=this.value; render()"><option value="">고용형태 전체</option>${EMP_TYPES.map(r=>`<option ${f.empType===r?"selected":""}>${r}</option>`).join("")}</select><select onchange="empFilter.team=this.value; render()"><option value="">언어 전체</option><option value="중국어" ${f.team==="중국어"?"selected":""}>통역-중국어</option><option value="일본어" ${f.team==="일본어"?"selected":""}>통역-일본어</option></select>
    <select onchange="empFilter.status=this.value; render()">
      <option value="재직" ${f.status==="재직"?"selected":""}>재직</option>
      <option value="퇴사" ${f.status==="퇴사"?"selected":""}>퇴사</option>
      <option value="">전체</option>
    </select>
    <div class="grow"></div>
    <span class="hint">${list.length}명</span>
  </div>
  <div class="panel"><div class="att-wrap">
    ${list.length? `<table>
      <thead><tr>
        <th class="num" style="width:56px">사번</th><th>이름</th><th>직무</th><th>고용형태</th>
        <th>팀</th><th>입사일</th><th class="num">연차잔여</th><th>상태</th>
      </tr></thead>
      <tbody>${list.map(e=>{
        const s=e.empType==="정규직"?summarizeLeave(e):null;
        return `<tr class="row-click" onclick="openCard(${e.id})">
          <td class="num">${e.employeeNo??"—"}</td>
          <td><span class="name">${esc(e.name)}</span></td>
          <td><span class="tag t-ice">${esc(e.role)}</span></td>
          <td>${esc(e.empType)}${e.closingDuty?' <span class="hint">(마감)</span>':""}</td>
          <td>${e.team==="중국어"?'<span class="tag t-cn">중국어</span>':e.team==="일본어"?'<span class="tag t-jp">일본어</span>':"—"}</td>
          <td>${fmtDate(e.joinDate)}</td>
          
          <td class="num">${s?`<b>${s.remaining}</b> / ${s.accrued}`:"—"}</td>
          <td>${statusTag(e.status)}</td>
        </tr>`;}).join("")}</tbody>
    </table>` : `<div class="empty"><div class="big">조건에 맞는 직원이 없어요</div><div>필터를 바꾸거나 새 직원을 등록해 보세요.</div></div>`}
  </div></div>`;
}
// 검색은 리렌더 없이 입력 유지 위해 부분 갱신
let softT=null;
function softRerender(){ clearTimeout(softT); softT=setTimeout(render,150); }

/* =========================== 직원 등록/수정 폼 =========================== */
function openForm(id){
  const e = id ? DB.employees.find(x=>x.id===id) : {};
  const isEdit=!!id;
  const defRole = e.role || "약무"; const defTeam = e.team || ""; const defType = e.empType || "정규직"; const defClosing = !!e.closingDuty; const nextNo = isEdit ? e.employeeNo : suggestEmployeeNo(defRole, defTeam, defType, defClosing);
  modal(`${isEdit?"인사정보 수정":"입사 등록"}`, `
    <div class="grid2">
      <div class="field"><label>사번</label><input id="f_no" type="number" value="${e.employeeNo??nextNo}"></div>
      <div class="field"><label>이름 <span class="req">*</span></label><input id="f_name" value="${esc(e.name||"")}"></div>
      <div class="field"><label>직무</label><select id="f_role" onchange="onEmpAutoNo(${id||0})">${ROLES.map(r=>`<option ${e.role===r?"selected":""}>${r}</option>`).join("")}</select></div>
      <div class="field"><label>고용형태</label><select id="f_type" onchange="onEmpAutoNo(${id||0})">${EMP_TYPES.map(r=>`<option ${e.empType===r?"selected":""}>${r}</option>`).join("")}</select></div>
      <div class="field" id="f_team_wrap" style="${defRole==="통역"?"":"display:none"}"><label>팀(통역) <span class="req">*</span></label><select id="f_team" onchange="onEmpAutoNo(${id||0})">${TEAMS.filter(t=>t).map(t=>`<option value="${t}" ${defTeam===t?"selected":""}>${t}</option>`).join("")}</select></div><div class="field" id="f_closing_wrap" style="${defType==="파트타임"?"":"display:none"}"><label style="display:flex;align-items:center;gap:8px;cursor:pointer"><input id="f_closing" type="checkbox" style="width:16px;height:16px" ${e.closingDuty?"checked":""} onchange="onEmpAutoNo(${id||0})"> 마감 담당 파트타임 (사번 X2XXX)</label></div>
      <div class="field"><label>입사일 <span class="req">*</span></label><input id="f_join" type="date" min="1950-01-01" max="2099-12-31" value="${(e.joinDate||todayStr()).slice(0,10)}"></div>
      <div class="field"><label>주 근무일 수 <span class="req">*</span></label><select id="f_workdays"><option value="1" ${(e.weeklyWorkDays||5)===1?"selected":""}>1</option><option value="2" ${(e.weeklyWorkDays||5)===2?"selected":""}>2</option><option value="3" ${(e.weeklyWorkDays||5)===3?"selected":""}>3</option><option value="4" ${(e.weeklyWorkDays||5)===4?"selected":""}>4</option><option value="5" ${(e.weeklyWorkDays||5)===5?"selected":""}>5</option><option value="6" ${(e.weeklyWorkDays||5)===6?"selected":""}>6</option><option value="7" ${(e.weeklyWorkDays||5)===7?"selected":""}>7</option></select></div>
      <div class="field"><label>연락처</label><input id="f_phone" value="${esc(e.phone||"")}"></div>
      <div class="field"><label>비자</label><input id="f_visa" value="${esc(e.visa||"")}" placeholder="F-5, F-6 등"></div>
      
      <div class="field full"><label>메모</label><textarea id="f_memo" placeholder="근무패턴 등 자유 메모">${esc(e.memo||"")}</textarea></div>
    </div>
  `, [
    isEdit?`<button class="btn danger" onclick="toggleRetire(${id})">${e.status==="퇴사"?"재직 처리":"퇴사 처리"}</button>`:"",
    `<div class="grow" style="flex:1"></div>`,
    `<button class="btn" onclick="closeModal()">취소</button>`,
    `<button class="btn primary" onclick="saveEmployee(${id||0})">${isEdit?"저장":"등록"}</button>`,
  ]);
}
function val(id){ const el=document.getElementById(id); return el?el.value.trim():""; } function onEmpAutoNo(id){ const role=val("f_role"); const twrap=document.getElementById("f_team_wrap"); if(twrap) twrap.style.display = role==="통역" ? "" : "none"; const empType0=val("f_type"); const cwrap=document.getElementById("f_closing_wrap"); if(cwrap) cwrap.style.display = empType0==="파트타임" ? "" : "none"; if(id) return; const team = role==="통역" ? val("f_team") : ""; const closingEl=document.getElementById("f_closing"); const closing = empType0==="파트타임" && closingEl ? closingEl.checked : false; const noEl=document.getElementById("f_no"); if(noEl) noEl.value = suggestEmployeeNo(role, team, empType0, closing, id||undefined); }
function isOwner(){ return sessionStorage.getItem("hr_role")==="owner"; }
function updateNavVisibility(){ const p=document.getElementById("navPayroll"); if(p) p.style.display = isOwner()? "" : "none"; }
function saveEmployee(id){
  const name=val("f_name"), join=val("f_join");
  if(!name){ toast("이름을 입력하세요"); return; }
  if(!join){ toast("입사일을 입력하세요"); return; } const roleV=val("f_role"); const teamV = roleV==="통역" ? val("f_team") : null; if(roleV==="통역" && !teamV){ toast("통역 직원은 팀(중국어/일본어)을 선택하세요"); return; } const empTypeV=val("f_type"); const closingEl2=document.getElementById("f_closing"); const closingV = empTypeV==="파트타임" && closingEl2 ? closingEl2.checked : false;
  const data={
    employeeNo: val("f_no")?Number(val("f_no")):null,
    name, role:roleV, empType:empTypeV, team:teamV, closingDuty:closingV,
    joinDate:join, weeklyWorkDays:val("f_workdays")?Number(val("f_workdays")):null,
    phone:val("f_phone")||null, visa:val("f_visa")||null, memo:val("f_memo")||null,
  };
  if(id){ Object.assign(DB.employees.find(x=>x.id===id), data); toast("수정했습니다"); }
  else { DB.employees.push({id:nextId(), status:"재직", leaveDate:null, ...data}); toast("등록했습니다"); }
  saveDB(); closeModal(); render();
}
function toggleRetire(id){
  const e=DB.employees.find(x=>x.id===id);
  if(e.status==="재직"){ e.status="퇴사"; e.leaveDate=todayStr(); toast("퇴사 처리했습니다"); }
  else { e.status="재직"; e.leaveDate=null; toast("재직 처리했습니다"); }
  saveDB(); closeModal(); render();
}
function deleteEmployee(id){
  if(!confirm("이 직원과 관련된 휴가·출근 기록이 모두 삭제됩니다. 계속할까요?")) return;
  DB.employees=DB.employees.filter(x=>x.id!==id);
  DB.leaves=DB.leaves.filter(l=>l.employeeId!==id);
  for(const k in DB.attendance){ if(DB.attendance[k].employeeId===id) delete DB.attendance[k]; }
  DB.shiftChanges=(DB.shiftChanges||[]).filter(c=>c.employeeId!==id && c.substituteId!==id); syncAll();
  saveDB(); closeModal(); render(); toast("삭제했습니다");
}

/* =========================== 인사기록카드 =========================== */
function openCard(id){
  const e=DB.employees.find(x=>x.id===id);
  const s=summarizeLeave(e);
  const myLeaves=DB.leaves.filter(l=>l.employeeId===id).sort((a,b)=>(b.startDate||"").localeCompare(a.startDate||""));
  const showLeave = e.empType==="정규직";
  modal(`${esc(e.name)} 인사기록카드`, `
    <div class="card-grid">
      <div>
        <dl class="info-list">
          <dt>사번</dt><dd>${e.employeeNo??"—"}</dd>
          <dt>직무 / 형태</dt><dd>${esc(e.role)} · ${esc(e.empType)}${e.team?` · ${esc(e.team)}`:""}</dd>
          <dt>상태</dt><dd>${statusTag(e.status)} ${e.leaveDate?`<span class="hint">(퇴사일 ${fmtDate(e.leaveDate)})</span>`:""}</dd>
          <dt>입사일</dt><dd>${fmtDate(e.joinDate)} <span class="hint">(근속 ${s.serviceMonths}개월)</span></dd>
          
          <dt>연락처</dt><dd>${esc(e.phone||"—")}</dd>
          <dt>비자</dt><dd>${esc(e.visa||"—")}</dd>
          
          <dt>메모</dt><dd style="font-weight:500; white-space:pre-wrap">${esc(e.memo||"—")}</dd>
        </dl>
      </div>
      <div>
        ${showLeave?`<div class="leave-box">
          <div class="hint" style="margin-bottom:4px">잔여 연차</div>
          <div class="rem">${s.remaining}<span style="font-size:16px; color:var(--muted)">일</span></div>
          <div style="margin-top:12px; border-top:1px solid #D3E0FB; padding-top:8px">
            <div class="leave-line">누적 발생 <b>${s.accrued}일</b></div>
            <div class="leave-line">사용 <b>${s.used}일</b></div>
          </div>
        </div>`:`<div class="leave-box" style="background:var(--gray-bg); border-color:var(--border)"><div class="hint">파트타임은 연차 자동계산 대상이 아니에요. 출근부에서 근무일을 관리하세요.</div></div>`}
      </div>
    </div>
    <div style="margin-top:18px">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px">
        <h3 style="font-size:14px; margin:0">휴가 내역</h3>
        <button class="btn sm" onclick="openLeaveForm(${id})">＋ 휴가 등록</button>
      </div>
      ${myLeaves.length?`<div class="panel"><table>
        <thead><tr><th>종류</th><th>기간</th><th class="num">일수</th><th>상태</th><th></th></tr></thead>
        <tbody>${myLeaves.map(l=>`<tr>
          <td>${esc(l.leaveType)}</td>
          <td>${fmtDate(l.startDate)}${l.endDate&&l.endDate!==l.startDate?` ~ ${fmtDate(l.endDate)}`:""}</td>
          <td class="num">${l.days}</td>
          <td>${leaveStatusTag(l.status)}</td>
          <td class="num"><button class="btn sm ghost" onclick="deleteLeave(${l.id}, ${id})">삭제</button></td>
        </tr>`).join("")}</tbody>
      </table></div>`:`<div class="hint">등록된 휴가가 없어요.</div>`}
    </div>
  `, [
    `<button class="btn danger" onclick="deleteEmployee(${id})">직원 삭제</button>`,
    `<div style="flex:1"></div>`,
    `<button class="btn" onclick="closeModal()">닫기</button>`,
    `<button class="btn primary" onclick="openForm(${id})">정보 수정</button>`,
  ], true);
}

/* =========================== 연차·휴가 =========================== */
function renderLeaves(){
  const regs=DB.employees.filter(e=>e.status==="재직" && e.empType==="정규직")
    .map(e=>({e,s:summarizeLeave(e)}))
    .sort((a,b)=>a.s.remaining-b.s.remaining);
  const pending=DB.leaves.filter(l=>l.status==="대기"); const lowLeave=regs.filter(x=>x.s.remaining<=3).slice(0,5); const twoMoAgo=new Date(); twoMoAgo.setMonth(twoMoAgo.getMonth()-2); const twoMoAgoStr=twoMoAgo.toISOString().slice(0,10); const recentLeaves=[...DB.leaves].filter(l=>leaveViewAll||(l.startDate||"")>=twoMoAgoStr).sort((a,b)=>(b.startDate||"").localeCompare(a.startDate||""));

  return `
  ${headHTML("연차·휴가","정규직 잔여 연차 자동계산 · 휴가 등록/승인", `<button class="btn primary" onclick="openLeaveForm()">＋ 휴가 등록</button>`)}${lowLeave.length?`<div class="panel" style="margin-bottom:20px"><div class="p-head"><h2>잔여 연차 주의 (정규직 ≤3일)</h2></div><table><tbody>${lowLeave.map(({e,s})=>`<tr class="row-click" onclick="openCard(${e.id})"><td><span class="name">${esc(e.name)}</span></td><td class="num"><b style="color:${s.remaining<=1?'var(--bad)':'var(--warn)'}">${s.remaining}</b> / ${s.accrued}일</td></tr>`).join("")}</tbody></table></div>`:""}
  ${pending.length?`<div class="panel" style="margin-bottom:20px">
    <div class="p-head"><h2>승인 대기 ${pending.length}건</h2></div>
    <table><thead><tr><th>직원</th><th>종류</th><th>기간</th><th class="num">일수</th><th></th></tr></thead>
    <tbody>${pending.map(l=>{const e=DB.employees.find(x=>x.id===l.employeeId)||{};return `<tr>
      <td><span class="name">${esc(e.name||"?")}</span></td><td>${esc(l.leaveType)}</td>
      <td>${fmtDate(l.startDate)}${l.endDate&&l.endDate!==l.startDate?` ~ ${fmtDate(l.endDate)}`:""}</td>
      <td class="num">${l.days}</td>
      <td class="num"><button class="btn sm primary" onclick="setLeaveStatus(${l.id},'승인')">승인</button>
        <button class="btn sm" onclick="setLeaveStatus(${l.id},'반려')">반려</button></td>
    </tr>`;}).join("")}</tbody></table>
  </div>`:""}
  <div class="panel">
    <div class="p-head"><h2>최근 휴가 내역</h2><button class="btn sm ghost" onclick="toggleLeaveViewAll()">${leaveViewAll?"최근 2개월만":"전체 보기"}</button></div>${recentLeaves.length?`<div class="att-wrap"><table><thead><tr><th>직원</th><th>종류</th><th>기간</th><th class="num">일수</th><th>상태</th><th></th></tr></thead><tbody>${recentLeaves.map(l=>{const e=DB.employees.find(x=>x.id===l.employeeId)||{};return `<tr><td><span class="name">${esc(e.name||"?")}</span></td><td>${esc(l.leaveType)}</td><td>${fmtDate(l.startDate)}${l.endDate&&l.endDate!==l.startDate?` ~ ${fmtDate(l.endDate)}`:""}</td><td class="num">${l.days}</td><td>${leaveStatusTag(l.status)} <select onchange="setLeaveStatus(${l.id}, this.value)">${LEAVE_STATUSES.map(s=>`<option ${l.status===s?"selected":""}>${s}</option>`).join("")}</select></td><td class="num"><button class="btn sm ghost" onclick="deleteLeave(${l.id},0)">삭제</button></td></tr>`;}).join("")}</tbody></table></div>`:`<div class="empty" style="padding:28px">최근 휴가 기록이 없어요.</div>`}</div><div class="panel"><div class="p-head"><h2>직원별 잔여 연차</h2><span class="hint">규칙: 1년 미만 매월 1일(최대 11) · 1년 이상 15일</span></div>
    <div class="att-wrap">${regs.length?`<table>
      <thead><tr><th>이름</th><th>입사일</th><th class="num">근속(개월)</th><th class="num">발생</th><th class="num">사용</th><th class="num">차감</th><th class="num">잔여</th><th></th></tr></thead>
      <tbody>${regs.map(({e,s})=>`<tr class="row-click" onclick="openCard(${e.id})">
        <td><span class="name">${esc(e.name)}</span></td>
        <td>${fmtDate(e.joinDate)}</td>
        <td class="num">${s.serviceMonths}</td>
        <td class="num">${s.accrued}</td>
        <td class="num">${s.used}</td>
        <td class="num">${s.adj?(s.adj>0?'+':'')+s.adj:'-'}</td><td class="num"><b style="color:${s.remaining<=1?'var(--bad)':s.remaining<=3?'var(--warn)':'var(--navy)'}">${s.remaining}</b></td><td class="num"><button class="btn sm ghost" onclick="event.stopPropagation(); toggleLeaveAdjRow(${e.id})">차감/내역</button></td></tr>${leaveAdjExpandedId===e.id?`<tr><td colspan="8" style="padding:0"><div style="padding:14px 6px 18px">${renderLeaveAdjPanel(e)}</div></td></tr>`:""}<tr class="adj-spacer" style="display:none"><td style="display:none">
      </tr>`).join("")}</tbody>
    </table>`:`<div class="empty"><div class="big">정규직 재직자가 없어요</div></div>`}</div>
  </div>`;
}
function openLeaveForm(empId){
  const emps=DB.employees.filter(e=>e.status==="재직");
  if(emps.length===0){ toast("먼저 직원을 등록하세요"); return; }
  modal("휴가 등록", `
    <div class="grid2">
      <div class="field full"><label>직원 <span class="req">*</span></label>
        <select id="l_emp">${emps.map(e=>`<option value="${e.id}" ${empId===e.id?"selected":""}>${esc(e.name)} (${e.role})</option>`).join("")}</select></div>
      <div class="field"><label>종류</label><select id="l_type" onchange="onLeaveType()">${LEAVE_TYPES.map(t=>`<option>${t}</option>`).join("")}</select></div>
      <div class="field"><label>상태</label><select id="l_status">${LEAVE_STATUSES.map(t=>`<option ${t==="승인"?"selected":""}>${t}</option>`).join("")}</select></div>
      <div class="field"><label>시작일 <span class="req">*</span></label><input id="l_start" type="date" value="${todayStr()}" onchange="autoDays()"></div>
      <div class="field"><label>종료일</label><input id="l_end" type="date" value="${todayStr()}" onchange="autoDays()"></div>
      <div class="field"><label>일수</label><input id="l_days" type="number" step="0.5" value="1"></div>
      <div class="field"><label>&nbsp;</label><div class="hint" style="padding-top:9px">반차는 0.5로 자동 설정돼요</div></div>
      <div class="field full"><label>메모</label><input id="l_memo" placeholder="사유 등"></div>
    </div>
  `, [
    `<button class="btn" onclick="closeModal()">취소</button>`,
    `<button class="btn primary" onclick="saveLeave()">등록</button>`,
  ]);
}
function onLeaveType(){
  const t=val("l_type"); const d=document.getElementById("l_days");
  if(t.startsWith("반차")) d.value="0.5"; else autoDays();
}
function autoDays(){
  const t=val("l_type"); if(t.startsWith("반차")){ document.getElementById("l_days").value="0.5"; return; }
  const a=new Date(val("l_start")), b=new Date(val("l_end"));
  if(isNaN(a)||isNaN(b)||b<a) return;
  const days=Math.round((b-a)/86400000)+1;
  document.getElementById("l_days").value=days;
}
function saveLeave(){
  const empId=Number(val("l_emp"));
  const start=val("l_start"); if(!start){ toast("시작일을 입력하세요"); return; }
  const end=val("l_end")||start;
  DB.leaves.push({
    id:nextId(), employeeId:empId, leaveType:val("l_type"),
    days:Number(val("l_days")||0), startDate:start, endDate:end,
    status:val("l_status"), memo:val("l_memo")||null,
  });
  syncAll(); saveDB(); closeModal(); render(); toast("휴가를 등록했습니다");
}
function setLeaveStatus(id, st){ const l=DB.leaves.find(x=>x.id===id); if(l){ l.status=st; syncAll(); saveDB(); render(); toast(st+" 처리했습니다"); } }
function deleteLeave(id, empId){ DB.leaves=DB.leaves.filter(x=>x.id!==id); syncAll(); saveDB(); if(document.getElementById("modalRoot").innerHTML && empId){ openCard(empId); } render(); toast("삭제했습니다"); } function renderLeaveAdjPanel(e){ if(!e) return ""; const list=(DB.leaveAdjustments||[]).filter(a=>a.employeeId===e.id).sort((a,b)=>(b.date||"").localeCompare(a.date||"")); return `<div class="panel adj-panel" style="margin-top:16px"><div class="p-head"><h2>${esc(e.name)} - 연차 조정</h2><button class="btn sm ghost" onclick="toggleLeaveAdjRow(${e.id})">닫기</button></div><div class="card-grid adj-grid"><div><div class="p-head"><h2 style="font-size:14px">연차 조정 추가</h2></div><div class="grid2"><div class="field"><label>방향</label><select id="adj_dir"><option value="차감">차감 (-)</option><option value="추가">추가 (+)</option></select></div><div class="field"><label>일수 (0.5 단위)</label><input id="adj_days" type="number" step="0.5" min="0.5" value="1"></div><div class="field"><label>사유 분류</label><select id="adj_reason">${LEAVE_ADJ_REASONS.map(r=>`<option>${r}</option>`).join("")}</select></div><div class="field"><label>적용일</label><input id="adj_date" type="date" value="${todayStr()}"></div><div class="field full"><label>메모</label><input id="adj_memo" placeholder="구체적 사유 (선택)"></div></div><button class="btn primary" style="margin-top:8px" onclick="addLeaveAdjustment(${e.id})">차감/조정 추가</button></div><div><div class="p-head"><h2 style="font-size:14px">차감/조정 내역</h2></div>${list.length?`<div class="att-wrap"><table><tbody>${list.map(a=>`<tr><td>${fmtDate(a.date)}</td><td>${a.direction==="추가"?'<span class="tag t-ok">+'+a.days+'일</span>':'<span class="tag t-bad">-'+a.days+'일</span>'}</td><td>${esc(a.reasonType||"")}</td><td class="hint">${esc(a.memo||"")}</td><td class="num"><button class="btn sm ghost" onclick="deleteLeaveAdjustment(${a.id})">삭제</button></td></tr>`).join("")}</tbody></table></div>`:`<div class="hint" style="padding:10px 4px">내역이 없습니다.</div>`}</div></div></div>`; } function addLeaveAdjustment(empId){ const dir=document.getElementById("adj_dir").value; const days=Number(document.getElementById("adj_days").value||0); if(!days){ toast("일수를 입력하세요"); return; } const reason=document.getElementById("adj_reason").value; const date=document.getElementById("adj_date").value||todayStr(); const memo=document.getElementById("adj_memo").value||null; DB.leaveAdjustments=DB.leaveAdjustments||[]; DB.leaveAdjustments.push({id:nextId(), employeeId:empId, direction:dir, days, reasonType:reason, date, memo}); saveDB(); render(); toast("연차를 조정했습니다"); } function deleteLeaveAdjustment(id){ DB.leaveAdjustments=(DB.leaveAdjustments||[]).filter(x=>x.id!==id); saveDB(); render(); toast("삭제했습니다"); }


/* =========================== 근무변경 (대체/시간변경/맞교대) =========================== */
const SHIFT_CHANGE_TYPES = ["대체","변경","교대"];
const SC_LABEL = {"대체":"대체근무","변경":"근무시간 변경","교대":"맞교대"};
/* 근무를 넘긴 사람을 급여에서 어떻게 처리할지 */
const SC_ABSENCE = [
  {key:"무급", label:"무급 (그냥 빠짐)",       hint:"그 날 급여 미지급 · 연차 차감 없음"},
  {key:"연차", label:"연차 사용",              hint:"유급 · 연차에서 차감되고 출근부에 연차로 표시"},
  {key:"교대", label:"맞교대 (다른 날 보충)",  hint:"다른 날 대신 근무하므로 총 근무일수는 그대로"},
];
const SC_ABSENCE_LABEL = Object.fromEntries(SC_ABSENCE.map(a=>[a.key,a.label]));
function absenceOf(c){ return c.type==="교대" ? "교대" : (c.absence||"무급"); }
function absenceTag(k){ return k==="연차"?'<span class="tag t-warn">연차</span>':k==="교대"?'<span class="tag t-ice">맞교대</span>':'<span class="tag t-bad">무급</span>'; }
let scViewAll = false;
function toggleScViewAll(){ scViewAll=!scViewAll; render(); }

// 해당 날짜의 주간 근무표 스케줄
function scheduleOn(empId, day){
  const p=String(day||"").split("-").map(Number);
  if(p.length!==3 || !p[0]) return {on:false,start:"09:00",end:"18:00",close:false};
  return getSchedule(empId, new Date(p[0],p[1]-1,p[2]).getDay());
}
function empName(id){ const e=DB.employees.find(x=>x.id===id); return e?e.name:"?"; }
// 받침 여부에 따른 조사 (이/가, 은/는, 을/를)
function hasBatchim(word){
  const c=String(word||"").trim().slice(-1).charCodeAt(0);
  return c>=0xAC00 && c<=0xD7A3 ? ((c-0xAC00)%28)!==0 : false;
}
function josa(word, withBatchim, without){ return word + (hasBatchim(word)?withBatchim:without); }

/* 근무변경에서 "연차 사용"으로 지정한 건을 실제 연차 기록으로 만들어 준다 (연차 잔여에 반영) */
function syncLinkedLeaves(){
  DB.leaves = (DB.leaves||[]).filter(l=>!l.fromShiftChange ||
    (DB.shiftChanges||[]).some(c=>c.id===l.fromShiftChange && c.status==="승인" && c.type==="대체" && c.absence==="연차"));
  (DB.shiftChanges||[]).forEach(c=>{
    if(c.type!=="대체" || c.status!=="승인" || c.absence!=="연차") return;
    const fields={ employeeId:c.employeeId, leaveType:"연차", days:Number(c.leaveDays||1),
      startDate:c.date, endDate:c.date, status:"승인",
      memo:`근무변경 — ${empName(c.substituteId)}가 대신 근무` };
    const l=DB.leaves.find(x=>x.fromShiftChange===c.id);
    if(l) Object.assign(l, fields); else DB.leaves.push({id:nextId(), fromShiftChange:c.id, ...fields});
  });
}
/* 휴가 → 출근부 → 근무변경 순서로 한 번에 다시 계산 */
function syncAll(){ syncLinkedLeaves(); syncLeaveAttendance(); syncShiftChanges(); }

/* 승인된 근무변경을 출근부에 투영한다. 이전 투영을 되돌린 뒤 다시 적용하므로 몇 번 호출해도 안전. */
function syncShiftChanges(){
  for(const k in DB.attendance){
    const r=DB.attendance[k];
    if(!r || !r.swap) continue;
    const prev=r.swap.prev||{};
    delete r.swap;
    if(prev.status===undefined) delete r.status; else r.status=prev.status;
    if(prev.closeOverride===undefined) delete r.closeOverride; else r.closeOverride=prev.closeOverride;
    if(r.status===undefined && !Object.prototype.hasOwnProperty.call(r,"closeOverride")) delete DB.attendance[k];
  }
  (DB.shiftChanges||[]).filter(c=>c.status==="승인").forEach(c=>{
    if(c.type==="변경"){
      const base=scheduleOn(c.employeeId, c.date);
      applySwapCell(c, c.employeeId, c.date, "변경", null, c.start||base.start, c.end||base.end, c.close!=null?c.close:!!base.close);
    } else if(c.type==="대체"){
      applySwapPair(c, c.employeeId, c.substituteId, c.date);
    } else if(c.type==="교대"){
      applySwapPair(c, c.employeeId, c.substituteId, c.date);
      applySwapPair(c, c.substituteId, c.employeeId, c.swapDate||c.date, true);
    }
  });
}
/* origId의 date 근무를 subId가 대신한다 */
function applySwapPair(c, origId, subId, day, isReturn){
  if(!origId || !subId || !day) return;
  const base=scheduleOn(origId, day);                       // 넘겨받는 근무는 원 근무자의 스케줄 기준
  const start = (!isReturn && c.start) ? c.start : base.start;
  const end   = (!isReturn && c.end)   ? c.end   : base.end;
  const close = (!isReturn && c.close!=null) ? c.close : !!base.close;
  applySwapCell(c, origId, day, "빠짐", subId, start, end, close);
  applySwapCell(c, subId,  day, "대체", origId, start, end, close);
}
function applySwapCell(c, empId, day, role, partnerId, start, end, close){
  if(!empId || !day) return;
  const key=attKey(empId, day);
  const rec=DB.attendance[key];
  const onLeave = rec && rec.status==="연차";
  const prev = {
    status: rec ? rec.status : undefined,
    closeOverride: (rec && Object.prototype.hasOwnProperty.call(rec,"closeOverride")) ? rec.closeOverride : undefined,
  };
  const next = {...(rec||{}), employeeId:empId, date:day};
  if(onLeave){ /* 연차가 우선 — 상태는 그대로 두고 표시만 남긴다 */ }
  else if(role==="빠짐"){ next.status="휴무"; next.closeOverride=false; }
  else { next.status="출근"; next.closeOverride=!!close; }
  next.swap={id:c.id, type:c.type, role, partnerId:partnerId||null, date:day, start:start||null, end:end||null, absence:absenceOf(c), prev};
  DB.attendance[key]=next;
}
function swapCellInfo(rec){
  if(!rec || !rec.swap) return null;
  const s=rec.swap, who=s.partnerId?empName(s.partnerId):"";
  const time = s.start&&s.end ? `${s.start}~${s.end}` : "";
  const tail = s.type==="교대" ? " · 맞교대" : "";
  const d = s.date ? fmtDate(s.date)+" " : "";
  // badge 는 출근/휴무 기호 옆에 붙는 작은 표시일 뿐, 기호 자체를 대신하지 않는다
  if(s.role==="변경") return {id:s.id, cls:"swap-time", badge:"변", working:true,
    title:`근무시간 변경 — 이 날은 ${time} 근무${tail}`};
  if(s.role==="대체") return {id:s.id, cls:"swap-in", badge:"대", working:true,
    title:`출근 — ${josa(who,"이","가")} 원래 맡던 ${d}근무를 대신함 (${time})${tail}`};
  const ab = s.absence==="연차" ? "연차 사용(유급)" : s.absence==="교대" ? "다른 날 보충" : "무급";
  return {id:s.id, cls:"swap-out", badge:s.absence==="연차"?"연":"↔", working:false,
    title:`${s.absence==="연차"?"연차":"휴무"} — 이 날 근무를 ${esc(who)}에게 넘김 · ${ab} (${time})${tail}`};
}

/* ---- 화면 ---- */
let scMonth = ymNow();
/* 급여 정산용 — 그 달의 근무변경을 사람별로 집계 */
function shiftChangeSummary(ym){
  const inM=d=>String(d||"").slice(0,7)===ym;
  const rows={};
  const row=id=>{ const e=DB.employees.find(x=>x.id===id); if(!e) return null;
    if(!rows[id]) rows[id]={e, sub:0, 연차:0, 무급:0, 교대:0, 변경:0};
    return rows[id]; };
  (DB.shiftChanges||[]).filter(c=>c.status==="승인").forEach(c=>{
    if(c.type==="변경"){ if(inM(c.date)){ const r=row(c.employeeId); if(r) r.변경++; } return; }
    if(inM(c.date)){
      const o=row(c.employeeId), sb=row(c.substituteId);
      if(o) o[absenceOf(c)]++;
      if(sb) sb.sub++;
    }
    if(c.type==="교대" && inM(c.swapDate)){
      const o=row(c.substituteId), sb=row(c.employeeId);
      if(o) o.교대++;
      if(sb) sb.sub++;
    }
  });
  return Object.values(rows).filter(r=>r.sub||r.연차||r.무급||r.교대||r.변경)
    .sort((a,b)=>(a.e.employeeNo||0)-(b.e.employeeNo||0));
}
function renderScSummary(){
  const list=shiftChangeSummary(scMonth);
  return `<div class="panel" style="margin-bottom:20px">
    <div class="p-head"><h2>급여 정산 요약</h2>
      <input type="month" value="${scMonth}" onchange="scMonth=this.value; render()" style="padding:6px 9px; border:1px solid var(--border-strong); border-radius:8px"></div>
    ${list.length?`<div class="att-wrap"><table>
      <thead><tr><th>이름</th><th class="num">대체 근무<div class="hint">남 대신 나옴</div></th>
      <th class="num">연차<div class="hint">유급</div></th><th class="num">무급<div class="hint">급여 차감</div></th>
      <th class="num">맞교대<div class="hint">상계</div></th><th class="num">시간변경</th><th class="num">근무일 증감</th></tr></thead>
      <tbody>${list.map(r=>{ const net=r.sub-r.무급;
        return `<tr><td><span class="name">${esc(r.e.name)}</span></td>
        <td class="num">${r.sub||"—"}</td><td class="num">${r.연차||"—"}</td>
        <td class="num">${r.무급?`<b style="color:var(--bad)">${r.무급}</b>`:"—"}</td>
        <td class="num">${r.교대||"—"}</td><td class="num">${r.변경||"—"}</td>
        <td class="num"><b style="color:${net>0?"#16A34A":net<0?"var(--bad)":"var(--muted)"}">${net>0?"+"+net:String(net)}</b></td></tr>`;}).join("")}</tbody>
    </table></div>
    <div class="legend"><span><b>대체 근무</b> 남의 근무를 대신 나온 날 — 급여 지급 대상</span><span><b>무급</b> 근무를 넘기고 보충 없이 빠진 날 — 급여 차감</span><span><b>연차</b> 유급이라 급여는 그대로, 연차 잔여만 차감</span><span><b>맞교대</b> 다른 날 보충하므로 총 근무일수 변동 없음</span><span><b>근무일 증감</b> = 대체 근무 − 무급</span></div>`
    :`<div class="empty" style="padding:26px">${scMonth}에 승인된 근무변경이 없어요.</div>`}
  </div>`;
}
function renderShiftChanges(){
  const pending=(DB.shiftChanges||[]).filter(c=>c.status==="대기").sort((a,b)=>(a.date||"").localeCompare(b.date||""));
  const twoMoAgo=new Date(); twoMoAgo.setMonth(twoMoAgo.getMonth()-2);
  const cut=twoMoAgo.toISOString().slice(0,10);
  const list=[...(DB.shiftChanges||[])].filter(c=>scViewAll||(c.date||"")>=cut).sort((a,b)=>(b.date||"").localeCompare(a.date||""));
  // 누가 어느 날 대신 나오는지 한 줄에 하나씩 — 맞교대는 두 줄
  const legs=(c)=>{
    const t=c.start&&c.end?`${c.start}~${c.end}`:"근무표 기준";
    if(c.type==="변경") return [{date:c.date, html:`<b>${esc(empName(c.employeeId))}</b> <span class="hint">시간변경</span>`, time:t}];
    const leg=(fromName,toName)=>`<span class="hint">${esc(fromName)}의 근무</span> <span class="hint">→</span> <b>${esc(toName)} 출근</b>`;
    const a=leg(empName(c.employeeId), empName(c.substituteId));
    const b=leg(empName(c.substituteId), empName(c.employeeId));
    if(c.type==="대체") return [{date:c.date, html:a, time:t}];
    return [{date:c.date, html:a, time:t},{date:c.swapDate, html:b, time:"근무표 기준"}];
  };
  const row=(c,withActions)=>{
    const L=legs(c);
    return `<tr>
      <td>${L.map(x=>`<div>${fmtDate(x.date)}</div>`).join("")}</td>
      <td><span class="tag t-gray">${SC_LABEL[c.type]||c.type}</span></td>
      <td>${c.type==="변경"?'<span class="hint">—</span>':absenceTag(absenceOf(c))}${c.type==="대체"&&absenceOf(c)==="연차"?`<div class="hint">${Number(c.leaveDays||1)}일 차감</div>`:""}</td>
      <td>${L.map(x=>`<div style="padding:1px 0">${x.html}</div>`).join("")}</td>
      <td>${L.map(x=>`<div style="padding:1px 0">${x.time}</div>`).join("")}${c.close?' <b class="close-tag">(마감)</b>':""}</td>
      <td class="hint">${esc(c.reason||"")}</td>
      <td>${leaveStatusTag(c.status)} ${withActions?`<select onchange="setShiftChangeStatus(${c.id}, this.value)">${LEAVE_STATUSES.map(s=>`<option ${c.status===s?"selected":""}>${s}</option>`).join("")}</select>`:""}</td>
      <td class="num"><button class="btn sm" onclick="openShiftChangeForm({id:${c.id}})">수정</button>
        <button class="btn sm ghost" onclick="deleteShiftChange(${c.id})">삭제</button></td>
    </tr>`;
  };
  return `
  ${headHTML("근무변경","대체근무 · 근무시간 변경 · 맞교대 등록/승인 — 승인되면 출근부에 자동 반영돼요", `<button class="btn primary" onclick="openShiftChangeForm()">＋ 근무변경 등록</button>`)}
  ${renderScSummary()}
  ${pending.length?`<div class="panel" style="margin-bottom:20px">
    <div class="p-head"><h2>승인 대기 ${pending.length}건</h2></div>
    <div class="att-wrap"><table><thead><tr><th>날짜</th><th>유형</th><th>처리</th><th>근무자</th><th>시간</th><th>사유</th><th>상태</th><th></th></tr></thead>
    <tbody>${pending.map(c=>`<tr>
      <td>${fmtDate(c.date)}${c.type==="교대"&&c.swapDate?`<div class="hint">↔ ${fmtDate(c.swapDate)}</div>`:""}</td>
      <td><span class="tag t-gray">${SC_LABEL[c.type]||c.type}</span></td>
      <td>${c.type==="변경"?'<span class="hint">—</span>':absenceTag(absenceOf(c))}</td>
      <td>${c.type==="변경"?esc(empName(c.employeeId)):`${esc(empName(c.employeeId))} <span class="hint">→</span> <b>${esc(empName(c.substituteId))}</b>`}</td>
      <td>${c.start&&c.end?`${c.start}~${c.end}`:"근무표 기준"}${c.close?' <b class="close-tag">(마감)</b>':""}</td>
      <td class="hint">${esc(c.reason||"")}</td>
      <td class="num"><button class="btn sm primary" onclick="setShiftChangeStatus(${c.id},'승인')">승인</button>
        <button class="btn sm" onclick="openShiftChangeForm({id:${c.id}})">수정</button>
        <button class="btn sm" onclick="setShiftChangeStatus(${c.id},'반려')">반려</button></td>
    </tr>`).join("")}</tbody></table></div>
  </div>`:""}
  <div class="panel">
    <div class="p-head"><h2>근무변경 내역</h2><button class="btn sm ghost" onclick="toggleScViewAll()">${scViewAll?"최근 2개월만":"전체 보기"}</button></div>
    ${list.length?`<div class="att-wrap"><table><thead><tr><th>날짜</th><th>유형</th><th>처리</th><th>근무자</th><th>시간</th><th>사유</th><th>상태</th><th></th></tr></thead><tbody>${list.map(c=>row(c,true)).join("")}</tbody></table></div>`:`<div class="empty" style="padding:28px">근무변경 기록이 없어요.</div>`}
  </div>
  <div class="legend"><span><b>대체근무</b> 원 근무자는 휴무, 대체자에게 출근·마감이 집계돼요</span><span><b>맞교대</b> 두 날짜를 서로 맞바꿔 양쪽 출근부가 동시에 바뀌어요</span><span><b>근무시간 변경</b> 같은 사람이 그날만 다른 시간에 근무</span></div>`;
}

/* ---- 등록/수정 폼 ---- */
function openShiftChangeForm(prefill){
  const emps=DB.employees.filter(e=>e.status==="재직").sort((a,b)=>(a.employeeNo||0)-(b.employeeNo||0));
  if(emps.length<1){ toast("먼저 직원을 등록하세요"); return; }
  let p=prefill||{}, editing=null;
  if(p.id!=null){
    editing=(DB.shiftChanges||[]).find(x=>x.id===p.id);
    if(!editing){ toast("해당 근무변경을 찾을 수 없습니다"); return; }
    p={...editing};
  }
  const day=p.date||todayStr();
  const eid=p.employeeId||emps[0].id;
  const sid=p.substituteId||(emps[1]?emps[1].id:emps[0].id);
  const opts=(sel)=>emps.map(e=>`<option value="${e.id}" ${sel===e.id?"selected":""}>${esc(e.name)} (${e.role})</option>`).join("");
  modal(editing?"근무변경 수정":"근무변경 등록", `
    <div class="grid2">
      <div class="field"><label>유형 <span class="req">*</span></label>
        <select id="sc_type" onchange="onScTypeChange()">${SHIFT_CHANGE_TYPES.map(t=>`<option value="${t}" ${p.type===t?"selected":""}>${SC_LABEL[t]}</option>`).join("")}</select></div>
      <div class="field"><label>날짜 <span class="req">*</span></label><input id="sc_date" type="date" value="${day}" onchange="onScFillTime()"></div>
      <div class="field full"><label id="sc_emp_label">원래 근무자 <span class="req">*</span></label>
        <select id="sc_emp" onchange="onScFillTime()">${opts(eid)}</select></div>
      <div class="field full" id="sc_sub_wrap"><label>실제 근무자(대체자) <span class="req">*</span></label>
        <select id="sc_sub" onchange="scPreview()">${opts(sid)}</select></div>
      <div class="field full" id="sc_swapdate_wrap" style="display:none"><label>맞교대 상대 날짜 <span class="req">*</span></label>
        <input id="sc_swapdate" type="date" value="${p.swapDate||day}" onchange="scPreview()">
        <div class="hint" style="margin-top:6px">이 날짜의 대체자 근무는 원래 근무자가 대신합니다.</div></div>
      <div class="field"><label>시작 시간</label><input id="sc_start" type="time" onchange="scPreview()"></div>
      <div class="field"><label>종료 시간</label><input id="sc_end" type="time" onchange="scPreview()"></div>
      <div class="field full" id="sc_close_wrap"><label style="display:flex;align-items:center;gap:8px;cursor:pointer">
        <input id="sc_close" type="checkbox" style="width:16px;height:16px"> 마감 근무 — 출근부에 (마감)으로 집계</label></div>
      <div class="field" id="sc_absence_wrap"><label>원 근무자 처리 <span class="req">*</span></label>
        <select id="sc_absence" onchange="onScAbsence()">${SC_ABSENCE.filter(a=>a.key!=="교대").map(a=>`<option value="${a.key}" ${(p.absence||"무급")===a.key?"selected":""}>${a.label}</option>`).join("")}</select>
        <div class="hint" id="sc_absence_hint" style="margin-top:6px"></div></div>
      <div class="field" id="sc_leavedays_wrap" style="display:none"><label>차감할 연차 일수</label>
        <input id="sc_leavedays" type="number" step="0.5" min="0" value="${p.leaveDays!=null?p.leaveDays:1}" onchange="scPreview()"></div>
      <div class="field"><label>상태</label><select id="sc_status">${LEAVE_STATUSES.map(x=>`<option ${(p.status||"대기")===x?"selected":""}>${x}</option>`).join("")}</select></div>
      <div class="field"><label>사유</label><input id="sc_reason" value="${esc(p.reason||"")}" placeholder="예: 병원 진료, 개인 사정"></div>
      <div class="field full"><label>메모</label><input id="sc_memo" value="${esc(p.memo||"")}" placeholder="선택"></div>
    </div>
    <div class="hint" id="sc_hint" style="margin-top:10px"></div>
    <div id="sc_preview" style="margin-top:10px;padding:11px 13px;border-radius:9px;background:rgba(14,165,233,.10);border:1px solid rgba(14,165,233,.35);line-height:1.8;font-size:13px"></div>
  `, [
    `<button class="btn" onclick="closeModal()">취소</button>`,
    `<button class="btn primary" onclick="saveShiftChange(${editing?editing.id:"null"})">${editing?"저장":"등록"}</button>`,
  ]);
  onScTypeChange(!!editing);
  if(editing){
    const st=document.getElementById("sc_start"), en=document.getElementById("sc_end"), cl=document.getElementById("sc_close");
    if(st) st.value=editing.start||"";
    if(en) en.value=editing.end||"";
    if(cl) cl.checked=!!editing.close;
    const ab=document.getElementById("sc_absence"); if(ab && editing.absence && editing.absence!=="교대") ab.value=editing.absence;
    const ld=document.getElementById("sc_leavedays"); if(ld && editing.leaveDays!=null) ld.value=editing.leaveDays;
    onScAbsence();
  }
}
function onScTypeChange(skipFill){
  const t=val("sc_type");
  const sub=document.getElementById("sc_sub_wrap"), sw=document.getElementById("sc_swapdate_wrap");
  const lab=document.getElementById("sc_emp_label");
  if(sub) sub.style.display = t==="변경" ? "none" : "";
  if(sw)  sw.style.display  = t==="교대" ? "" : "none";
  const abw=document.getElementById("sc_absence_wrap");
  if(abw) abw.style.display = t==="대체" ? "" : "none";
  onScAbsence();
  if(lab) lab.innerHTML = t==="변경" ? '직원 <span class="req">*</span>' : '원래 근무자 <span class="req">*</span>';
  if(skipFill) scPreview(); else onScFillTime();
}
function onScAbsence(){
  const k=val("sc_absence"), t=val("sc_type");
  const ld=document.getElementById("sc_leavedays_wrap");
  if(ld) ld.style.display = (t==="대체" && k==="연차") ? "" : "none";
  const h=document.getElementById("sc_absence_hint");
  const a=SC_ABSENCE.find(x=>x.key===k);
  if(h) h.textContent = t==="대체" && a ? a.hint : "";
  scPreview();
}
function onScFillTime(){
  const empId=Number(val("sc_emp")), day=val("sc_date");
  const s=scheduleOn(empId, day);
  const st=document.getElementById("sc_start"), en=document.getElementById("sc_end"), cl=document.getElementById("sc_close");
  if(st) st.value=s.start||"09:00";
  if(en) en.value=s.end||"18:00";
  if(cl) cl.checked=!!s.close;
  const h=document.getElementById("sc_hint");
  if(h) h.textContent = s.on
    ? `근무표 기준: ${empName(empId)}님은 이 날 ${s.start}~${s.end}${s.close?" (마감)":""} 근무 예정입니다. 필요하면 시간을 고쳐주세요.`
    : `근무표 기준: ${empName(empId)}님은 이 날 휴무입니다. 시간을 직접 입력해 주세요.`;
  scPreview();
}
/* 저장하면 출근부가 어떻게 바뀌는지 미리 보여준다 */
function scPreview(){
  const box=document.getElementById("sc_preview"); if(!box) return;
  const t=val("sc_type"), date=val("sc_date"), a=Number(val("sc_emp")), b=Number(val("sc_sub"));
  const sd=val("sc_swapdate"), st=val("sc_start"), en=val("sc_end");
  const time = st&&en ? `${st}~${en}` : "근무표 기준";
  const L=(d,who,other,tm,ab)=>`<div>· <b>${esc(fmtDate(d))}</b> — ${esc(who)} <span style="opacity:.7">${ab||"휴무"}</span> / <b>${esc(other)} 출근</b> <span style="opacity:.7">(${tm})</span></div>`;
  let html="", pay="";
  if(t==="변경"){
    html=`<div>· <b>${esc(fmtDate(date))}</b> — ${esc(empName(a))} 근무시간이 <b>${time}</b> 으로 변경</div>`;
  } else if(t==="대체"){
    const k=val("sc_absence")||"무급";
    const days=Number(val("sc_leavedays")||1);
    html=L(date, empName(a), empName(b), time, k==="연차"?"연차":"휴무");
    pay = k==="연차"
      ? `<div style="margin-top:6px;opacity:.85">급여: <b>${esc(empName(a))}</b> 유급(연차 ${days}일 차감) · <b>${esc(empName(b))}</b> 근무 1일 추가</div>`
      : `<div style="margin-top:6px;opacity:.85">급여: <b>${esc(empName(a))}</b> 무급(근무 1일 감소) · <b>${esc(empName(b))}</b> 근무 1일 추가</div>`;
  } else {
    const s2=scheduleOn(b, sd);
    html=L(date, empName(a), empName(b), time) + L(sd, empName(b), empName(a), s2.on?`${s2.start}~${s2.end}`:"근무표 기준");
    pay=`<div style="margin-top:6px;opacity:.85">급여: 서로 하루씩 맞바꾸므로 <b>양쪽 총 근무일수는 그대로</b></div>`;
  }
  box.innerHTML=`<div style="font-weight:700;margin-bottom:4px">저장하면 출근부가 이렇게 바뀝니다</div>${html}${pay}`;
}
function saveShiftChange(editId){
  const type=val("sc_type"), date=val("sc_date");
  const employeeId=Number(val("sc_emp"));
  const substituteId = type==="변경" ? null : Number(val("sc_sub"));
  const swapDate = type==="교대" ? val("sc_swapdate") : null;
  if(!date){ toast("날짜를 입력하세요"); return; }
  if(type!=="변경" && (!substituteId || substituteId===employeeId)){ toast("원래 근무자와 다른 대체자를 선택하세요"); return; }
  if(type==="교대" && !swapDate){ toast("맞교대 상대 날짜를 입력하세요"); return; }
  if(type==="교대" && swapDate===date){ toast("맞교대는 서로 다른 날짜여야 합니다"); return; }
  const tre=/^([01][0-9]|2[0-3]):[0-5][0-9]$/;
  const st=val("sc_start"), en=val("sc_end");
  const closeEl=document.getElementById("sc_close");
  const fields={
    type, date, employeeId, substituteId, swapDate,
    start: tre.test(st)?st:null, end: tre.test(en)?en:null,
    close: closeEl?closeEl.checked:false,
    absence: type==="교대" ? "교대" : (val("sc_absence")||"무급"),
    leaveDays: Number(val("sc_leavedays")||1),
    status: val("sc_status")||"대기",
    reason: val("sc_reason")||null, memo: val("sc_memo")||null,
  };
  DB.shiftChanges=DB.shiftChanges||[];
  if(editId!=null){
    const c=DB.shiftChanges.find(x=>x.id===editId);
    if(!c){ toast("해당 근무변경을 찾을 수 없습니다"); return; }
    Object.assign(c, fields);
  } else {
    DB.shiftChanges.push({id:nextId(), ...fields, createdAt: todayStr()});
  }
  syncAll(); saveDB(); closeModal(); render();
  if(view==="attendance") wireAttendance();
  toast(editId!=null?"근무변경을 수정했습니다":"근무변경을 등록했습니다");
}
function setShiftChangeStatus(id, st){
  const c=(DB.shiftChanges||[]).find(x=>x.id===id); if(!c) return;
  c.status=st; syncAll(); saveDB(); render();
  if(view==="attendance") wireAttendance();
  toast(st+" 처리했습니다");
}
function deleteShiftChange(id){
  DB.shiftChanges=(DB.shiftChanges||[]).filter(x=>x.id!==id);
  syncAll(); saveDB(); render();
  if(view==="attendance") wireAttendance();
  toast("삭제했습니다");
}
/* 출근부 셀에서 바로 열기 */
function openSwapFromCell(empId, day){
  const rec=DB.attendance[attKey(empId,day)];
  if(rec && rec.swap){
    const c=(DB.shiftChanges||[]).find(x=>x.id===rec.swap.id);
    if(c){
      const info=swapCellInfo(rec);
      modal("근무변경 상세", `<div class="hint" style="line-height:1.9">
        <div><b>${SC_LABEL[c.type]||c.type}</b> · ${fmtDate(c.date)}${c.swapDate?` ↔ ${fmtDate(c.swapDate)}`:""}</div>
        <div>${esc(empName(c.employeeId))}${c.substituteId?` → ${esc(empName(c.substituteId))}`:""}</div>
        <div>${c.start&&c.end?`${c.start}~${c.end}`:"근무표 기준"}${c.close?" (마감)":""} · ${c.status}</div>
        <div>이 칸: ${esc(info?info.title:"")}</div>
        ${c.reason?`<div>사유: ${esc(c.reason)}</div>`:""}${c.memo?`<div>메모: ${esc(c.memo)}</div>`:""}
      </div>`, [
        `<button class="btn" onclick="closeModal()">닫기</button>`,
        `<button class="btn" onclick="closeModal(); setView('shiftchanges')">근무변경 메뉴로</button>`,
        `<button class="btn primary" onclick="closeModal(); deleteShiftChange(${c.id})">이 근무변경 삭제</button>`,
      ]);
      return;
    }
  }
  openShiftChangeForm({date:day, employeeId:empId});
}

/* =========================== 출근부 =========================== */
function attKey(empId, day){ return empId+"|"+day; } function syncLeaveAttendance(){ for(const k in DB.attendance){ if(DB.attendance[k].status==="연차") delete DB.attendance[k]; } DB.leaves.filter(l=>l.leaveType==="연차" && l.status==="승인").forEach(l=>{ let cur=(l.startDate||"").slice(0,10); const endStr=(l.endDate||l.startDate||"").slice(0,10); while(cur && cur<=endStr){ DB.attendance[attKey(l.employeeId, cur)]={employeeId:l.employeeId, date:cur, status:"연차"}; const p=cur.split("-").map(Number); const nd=new Date(Date.UTC(p[0],p[1]-1,p[2]+1)); cur=nd.toISOString().slice(0,10); } }); }
function daysInMonth(ym){ const [y,m]=ym.split("-").map(Number); return new Date(y,m,0).getDate(); }
function renderAttendance(){
  const [y,m]=attMonth.split("-").map(Number);
  const dim=daysInMonth(attMonth);
  // 파트타임 재직자 + 그 달에 걸치는 사람
  const emps=DB.employees.filter(e=>{
    if(e.status==="퇴사" && !e.leaveDate) return false;
    const first=attMonth+"-01", last=attMonth+"-"+String(dim).padStart(2,"0");
    if((e.joinDate||"").slice(0,10) > last) return false;
    if(e.leaveDate && e.leaveDate.slice(0,10) < first) return false;
    return true;
  });
  emps.sort((a,b)=>(a.employeeNo||0)-(b.employeeNo||0));const dayHdr=[];
  for(let d=1; d<=dim; d++){ const dow=new Date(y,m-1,d).getDay(); dayHdr.push({d,we:(dow===0||dow===6)}); }

  const body = emps.map(e=>{
    let worked=0,closeCnt=0,holCnt=0,subCnt=0,outCnt=0;
    const cells=dayHdr.map(({d})=>{
      const day=attMonth+"-"+String(d).padStart(2,"0");
      const rec=DB.attendance[attKey(e.id,day)];
const st=rec?.status || "";
      const dow=new Date(y,m-1,d).getDay();
      const sc=(DB.weeklySchedule&&DB.weeklySchedule[e.id])?DB.weeklySchedule[e.id][dow]:null; const isHol=(DB.holidays||[]).includes(day);
const scClose=!!(sc&&sc.on&&sc.close);
const closeOv=(rec&&Object.prototype.hasOwnProperty.call(rec,"closeOverride"))?rec.closeOverride:null;
const effClose= closeOv===true?true:(closeOv===false?false:scClose);
      const cls=st==="연차"?"leave":st==="출근"?"on":st==="결근"?"absent":st==="휴무"?"off":(sc?(sc.on?"sched-on":"sched-off"):"");
if(st==="출근"){ worked++; if(isHol) holCnt++; } if(effClose && st!=="연차"){ closeCnt++; }      const mark=st==="연차"?
   "연":st==="출근"?"○":st==="결근"?"×":st==="휴무"?"–":(sc?(sc.on?"○":"–"):"");
const swp=swapCellInfo(rec); if(swp){ if(swp.cls==="swap-in") subCnt++; else if(swp.cls==="swap-out") outCnt++; }
const closeCls = closeOv===true?" close close-forced":(closeOv===false?(scClose?" close-off":""):(scClose?" close":""));
const closeTitle = closeOv===true?"마감 강제 지정 (우클릭으로 해제)":(closeOv===false?"마감 강제 해제됨 (우클릭으로 초기화)":(scClose?`마감조 (${sc.start}~${sc.end})`:""));
const cellTitle = swp ? swp.title + (closeTitle?` · ${closeTitle}`:"") : closeTitle;
const swapBadge = swp ? `<i class="swap-badge">${swp.badge}</i>` : "";
return `<td class="${cls}${closeCls}${swp?" "+swp.cls:""}${isHol?" holiday":""}"${swp?` data-swapid="${swp.id}"`:""}${cellTitle?` title="${esc(cellTitle)}"`:""}><button class="cell" data-emp="${e.id}" data-day="${day}">${mark}${swapBadge}</button></td>`;    }).join("");
return `<tr><td class="emp">${esc(e.name)} <span class="hint">(${worked}, 마감 ${closeCnt}, 휴일 ${holCnt}${subCnt?`, 대체 ${subCnt}`:""}${outCnt?`, 대체빠짐 ${outCnt}`:""})</span></td>${cells}</tr>`;  }).join("");

  return `
  ${headHTML("출근부","직원 월별 근무 기록 · 셀 클릭으로 상태 변경")}
  <div class="toolbar">
    <div class="seg"><button class="btn sm active" onclick="setAttMode('month')">월간</button><button class="btn sm" onclick="setAttMode('week')">주간</button></div>
    <button class="btn sm" onclick="shiftMonth(-1)">‹ 이전달</button>
    <input type="month" value="${attMonth}" onchange="attMonth=this.value; render()" style="padding:8px 11px; border:1px solid var(--border-strong); border-radius:9px">
    <button class="btn sm" onclick="shiftMonth(1)">다음달 ›</button>
    <button class="btn sm" onclick="applyScheduleToMonth()">근무표 반영</button>
    <button class="btn sm" onclick="openShiftChangeForm()">＋ 근무변경</button>
    <div class="grow"></div>
<span class="hint">${emps.length}명 · 괄호(출근,마감,휴일근로) · 날짜 클릭 시 휴일 지정</span>  </div>
  <div class="panel"><div class="att-wrap">
    ${emps.length? `<table class="att">
<thead><tr><th class="emp">직원</th>${dayHdr.map(h=>{const hday=attMonth+"-"+String(h.d).padStart(2,"0");const hhol=(DB.holidays||[]).includes(hday);return `<th class="${h.we?'we':''}${hhol?' holiday':''}" style="cursor:pointer" title="클릭하여 휴일 지정/해제" onclick="toggleHoliday('${hday}')">${h.d}</th>`;}).join("")}</tr></thead>      <tbody>${body}</tbody>
    </table>`:`<div class="empty"><div class="big">이 달에 표시할 파트타임 직원이 없어요</div><div>직원을 파트타임으로 등록하면 여기에 나타납니다.</div></div>`}
  </div></div>
  <div class="legend"><span><b>○</b> 출근</span><span><b>–</b> 휴무</span><span><b>×</b> 결근</span><span><b style="color:#DC2626">연</b> 연차</span><span><i style="display:inline-block;width:10px;height:3px;background:#8B5CF6;border-radius:2px;vertical-align:middle;margin-right:5px"></i>마감조 (근무표에서 지정)</span><span><i style="display:inline-block;width:10px;height:3px;background:#F59E0B;border-radius:2px;vertical-align:middle;margin-right:5px"></i>마감 수동 지정(우클릭)</span><span><i style="display:inline-block;width:10px;height:3px;background:#CBD5E1;border-radius:2px;vertical-align:middle;margin-right:5px"></i>마감 수동 해제(우클릭)</span><span>○<b style="color:#0369A1;font-size:9px;vertical-align:super">대</b> 남의 근무를 대신함(출근)</span><span>–<b style="color:#0369A1;font-size:9px;vertical-align:super">↔</b> 내 근무를 넘김(휴무)</span><span>○<b style="color:#0369A1;font-size:9px;vertical-align:super">변</b> 근무시간 변경</span><span>클릭: 출근 → 휴무 → 결근 → 없음 순환</span><span><b>Shift+클릭</b>: 근무변경 등록/상세</span><span style="opacity:.75">대체 칸에 마우스를 올리면 바뀐 상대 칸과 이름이 함께 반짝여요</span><span>우클릭: 마감 수동 지정 → 해제 → 자동 순환</span><span style="opacity:.55">연하게 표시된 칸 = 근무표 기준 예정</span></div>`;
}
function wireAttendance(){
  document.querySelectorAll(".att .cell").forEach(btn=>{
    btn.onclick=(ev)=>{
      const emp=Number(btn.dataset.emp), day=btn.dataset.day, key=attKey(emp,day);
      const rec=DB.attendance[key];
      if(ev && ev.shiftKey){ openSwapFromCell(emp, day); return; }
const cur=rec?.status || "";
      if(cur==="연차"){ toast("연차는 휴가 등록에서 관리돼요"); return; }
      if(rec && rec.swap){ toast("근무변경으로 지정된 날이에요 — Shift+클릭으로 확인/삭제하세요"); return; } const nextMap={"":"출근","출근":"휴무","휴무":"결근","결근":""};
      const nx=nextMap[cur];
      if(nx===""){ if(rec && Object.prototype.hasOwnProperty.call(rec,"closeOverride")){ delete rec.status; } else delete DB.attendance[key]; }
      else { DB.attendance[key]={...(rec||{}), employeeId:emp, date:day, status:nx}; }
      saveDB(); render(); wireAttendance();
    };
    btn.oncontextmenu=(ev)=>{
      ev.preventDefault();
      const emp=Number(btn.dataset.emp), day=btn.dataset.day, key=attKey(emp,day);
      const rec=DB.attendance[key];
      const cur=(rec && Object.prototype.hasOwnProperty.call(rec,"closeOverride")) ? rec.closeOverride : null;
      const nextOv = cur===null ? true : (cur===true ? false : null);
      if(nextOv===null){
        if(rec){ delete rec.closeOverride; if(!rec.status) delete DB.attendance[key]; }
      } else {
        DB.attendance[key]={...(rec||{employeeId:emp, date:day}), closeOverride:nextOv};
      }
      saveDB(); render(); wireAttendance();
      toast(nextOv===true?"마감으로 강제 지정했습니다": nextOv===false?"마감을 강제 해제했습니다":"마감 수동 설정을 초기화했습니다 (근무표 기준으로 복귀)");
    };
  });
  wireSwapHighlight();
}
/* 근무변경 칸에 마우스를 올리면 짝이 되는 칸과 상대 직원 이름이 함께 반짝인다 */
function clearSwapHighlight(){
  document.querySelectorAll(".swap-hl,.swap-hl-self,.swap-hl-emp").forEach(x=>x.classList.remove("swap-hl","swap-hl-self","swap-hl-emp"));
}
function wireSwapHighlight(){
  document.querySelectorAll(".att td[data-swapid]").forEach(td=>{
    td.onmouseenter=()=>{
      clearSwapHighlight();
      const id=td.dataset.swapid;
      document.querySelectorAll(`.att td[data-swapid="${id}"]`).forEach(x=>{
        if(x===td){ x.classList.add("swap-hl-self"); return; }
        x.classList.add("swap-hl");
        const tr=x.closest("tr"), nameCell=tr&&tr.querySelector("td.emp");
        if(nameCell) nameCell.classList.add("swap-hl-emp");
      });
    };
    td.onmouseleave=clearSwapHighlight;
  });
}
const DOW_LABELS=["일","월","화","수","목","금","토"];
const DOW_ORDER=[1,2,3,4,5,6,0];
const DEFAULT_SHIFT_TYPES=[
{id:"A", name:"A", start:"10:00", end:"20:00"},
{id:"B", name:"B", start:"13:00", end:"23:00"},
];
function getShiftTypes(){
if(!DB.shiftTypes || !Array.isArray(DB.shiftTypes) || !DB.shiftTypes.length){
DB.shiftTypes = DEFAULT_SHIFT_TYPES.map(t=>({...t}));
}
return DB.shiftTypes;
}
const SHIFT_PALETTE=[
{bg:"#EAF1FE", fg:"#1E2761"},
{bg:"#FBF1DC", fg:"#B7791F"},
{bg:"#F3E8FF", fg:"#6B21A8"},
{bg:"#FCE7F3", fg:"#9D174D"},
{bg:"#E0F2FE", fg:"#075985"},
{bg:"#FEF3C7", fg:"#92400E"},
{bg:"#DCFCE7", fg:"#166534"},
{bg:"#FFE4E6", fg:"#9F1239"},
];
function shiftColorFor(id){
if(id==="A") return SHIFT_PALETTE[0];
if(id==="B") return SHIFT_PALETTE[1];
const types=getShiftTypes();
const idx=types.findIndex(t=>t.id===id);
if(idx<0) return SHIFT_PALETTE[2];
return SHIFT_PALETTE[(idx+2) % SHIFT_PALETTE.length];
}
function shiftTypeOf(s){
const types=getShiftTypes();
const m=types.find(t=>t.start===s.start && t.end===s.end);
return m ? m.id : "custom";
}
function getSchedule(empId, dow){
  const ws=DB.weeklySchedule||{};
  const e=ws[empId]||{};
  return e[dow]||{on:false,start:"09:00",end:"18:00",close:false};
}
function renderSchedule(){
  DB.weeklySchedule = DB.weeklySchedule || {};
  const emps=DB.employees.filter(e=>e.status!=="퇴사").sort((a,b)=>(a.employeeNo||0)-(b.employeeNo||0));
  if(!emps.length){
    return headHTML("근무표","반복되는 주간 근무 스케줄을 등록하세요.", `<button class="btn" onclick="()">근무 타입 관리</button>`) + `<div class="panel" style="padding:40px;text-align:center;color:var(--muted)">등록된 직원이 없어요.</div>`;
  }
  const head = `<tr><th class="emp">이름</th>${DOW_ORDER.map(d=>`<th class="${d===0?"we":""}">${DOW_LABELS[d]}</th>`).join("")}</tr>`;
  const body = emps.map(e=>{
    const cells = DOW_ORDER.map(d=>{
      const s=getSchedule(e.id,d);
      const __typeId = s.on? shiftTypeOf(s):"off";
      const cls = "shift-"+__typeId+(s.on&&s.close?" closing":"");
      const mark = s.on? `${s.start}~${s.end}${s.close?' <b class="close-tag">(마감)</b>':""}`:"휴무";
      const __c = (s.on && __typeId!=="custom") ? shiftColorFor(__typeId) : null;
      const __styleAttr = __c ? ` style="background:${__c.bg};color:${__c.fg}"` : "";
      return `<td class="${cls}"><button class="cell"${__styleAttr} data-emp="${e.id}" data-dow="${d}">${mark}</button></td>`;
    }).join("");
    return `<tr><td class="emp">${esc(e.name)}</td>${cells}</tr>`;
  }).join("");
  return `
    ${headHTML("근무표","반복되는 주간 근무 스케줄을 등록하면 출근부에 자동으로 반영돼요.", `<button class="btn" onclick="openShiftTypeManager()">근무 타입 관리</button>`)}
    <div class="panel"><div class="att-wrap">
    <table class="att"><thead>${head}</thead><tbody>${body}</tbody></table>
    </div>
    <div class="legend"><span>셀을 클릭해 근무 시간을 설정하거나 휴무로 전환하세요</span><span>매주 반복 적용됩니다</span></div>
    </div>`;
}
function wireSchedule(){
  document.querySelectorAll(".att .cell").forEach(btn=>{
    btn.onclick=()=>{
      const emp=Number(btn.dataset.emp), dow=Number(btn.dataset.dow);
      openScheduleForm(emp,dow);
    };
  });
}
function openScheduleForm(empId, dow){
const s=getSchedule(empId,dow);
const curType=!s.on?"off":shiftTypeOf(s);
const body = `
<div class="field" style="display:none"><label>근무 여부</label>
<select id="sf_on"><option value="1" ${s.on?"selected":""}>근무</option><option value="0" ${!s.on?"selected":""}>휴무</option></select>
</div>
<div class="field"><label>근무 타입</label>
<select id="sf_type" onchange="onShiftTypeChange()"><option value="off" ${curType==="off"?"selected":""}>휴무</option>
${getShiftTypes().map(t=>`<option value="${t.id}" ${curType===t.id?"selected":""}>${esc(t.name)} (${t.start}~${t.end})</option>`).join("")}
<option value="custom" ${curType==="custom"?"selected":""}>직접입력</option>
</select>
</div>
<div class="field" id="sf_close_wrap" style="${curType==="off"?"display:none":""}"><label style="display:flex;align-items:center;gap:8px;cursor:pointer"><input id="sf_close" type="checkbox" style="width:16px;height:16px" ${s.close?"checked":""}> 마감조 (23:00 이후 마감 근무) — 출근부에 (마감) 표시</label></div><div class="grid2" id="sf_time_wrap" style="${curType==="custom"?"":"display:none"}">
<div class="field"><label>시작 시간</label><input id="sf_start" type="time" value="${s.start||"09:00"}"></div>
<div class="field"><label>종료 시간</label><input id="sf_end" type="time" value="${s.end||"18:00"}"></div>
</div>`;
modal(`${DOW_LABELS[dow]}요일 근무 설정`, body, [
`<button class="btn" onclick="closeModal()">취소</button>`,
`<button class="btn primary" onclick="saveScheduleEntry(${empId},${dow})">저장</button>`
]);
}
function onShiftTypeChange(){
const t=val("sf_type");
const wrap=document.getElementById("sf_time_wrap");
if(wrap) wrap.style.display = t==="custom" ? "" : "none"; const cwrap=document.getElementById("sf_close_wrap"); if(cwrap) cwrap.style.display = t==="off" ? "none" : "";
}
function saveScheduleEntry(empId, dow){
const type=val("sf_type"); const on=type!=="off";

let start, end;
const __matchedType=getShiftTypes().find(t=>t.id===type);
if(__matchedType){ start=__matchedType.start; end=__matchedType.end; }
else if(type==="custom"){ const st=val("sf_start"), en=val("sf_end"), tre=/^([01][0-9]|2[0-3]):[0-5][0-9]$/; start = tre.test(st)?st:"09:00"; end = tre.test(en)?en:"18:00"; } else { start="09:00"; end="18:00"; }
DB.weeklySchedule = DB.weeklySchedule || {};
DB.weeklySchedule[empId] = DB.weeklySchedule[empId] || {};
const closeEl=document.getElementById("sf_close"); const close = on && closeEl ? closeEl.checked : false; DB.weeklySchedule[empId][dow] = {on, start, end, close};
saveDB();
closeModal();
render();
wireSchedule();
}
let editingShiftTypes = null;
function openShiftTypeManager(){
editingShiftTypes = getShiftTypes().map(t=>({...t}));
modal("근무 타입 관리", renderShiftTypeManagerBody(), [
  `<button class="btn" onclick="closeModal()">취소</button>`,
  `<button class="btn primary" onclick="saveShiftTypes()">저장</button>`
], true);
}
function renderShiftTypeManagerBody(){
const header = editingShiftTypes.length ? `
<div class="stm-header">
<span class="stm-color"></span>
<span class="stm-name">이름</span>
<span class="stm-time">시작</span>
<span class="stm-time">종료</span>
<span class="stm-del"></span>
</div>` : "";
const rows = editingShiftTypes.map((t,i)=>{
const col = shiftColorFor(t.id);
return `
<div class="stm-row">
<span class="stm-color" style="background:${col.bg}"></span>
<input class="stm-name" value="${esc(t.name)}" oninput="updateShiftTypeField(${i},'name',this.value)" placeholder="이름">
<input class="stm-time" type="time" value="${t.start}" oninput="updateShiftTypeField(${i},'start',this.value)">
<input class="stm-time" type="time" value="${t.end}" oninput="updateShiftTypeField(${i},'end',this.value)">
<button class="stm-del" onclick="removeShiftTypeRow(${i})" title="삭제">✕</button>
</div>`;
}).join("") || `<div class="stm-empty">등록된 근무 타입이 없어요.</div>`;
return `<div id="shiftTypeRows">${header}${rows}</div><button class="btn" style="margin-top:12px" onclick="addShiftTypeRow()">+ 타입 추가</button>`;
}
function addShiftTypeRow(){
editingShiftTypes.push({id:"t"+Date.now()+Math.floor(Math.random()*1000), name:"새 타입", start:"09:00", end:"18:00"});
refreshShiftTypeManagerBody();
}
function removeShiftTypeRow(i){
editingShiftTypes.splice(i,1);
refreshShiftTypeManagerBody();
}
function updateShiftTypeField(i, field, value){
if(editingShiftTypes[i]) editingShiftTypes[i][field] = value;
}
function refreshShiftTypeManagerBody(){
const body = document.querySelector("#modalRoot .m-body");
if(body) body.innerHTML = renderShiftTypeManagerBody();
}
function saveShiftTypes(){
const tre = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
for(const t of editingShiftTypes){
if(!t.name || !t.name.trim()){ toast("타입 이름을 입력하세요"); return; }
if(!tre.test(t.start) || !tre.test(t.end)){ toast("시간 형식이 올바르지 않아요"); return; }
}
DB.shiftTypes = editingShiftTypes.map(t=>({...t, name:t.name.trim()}));
saveDB();
closeModal();
render();
}
function applyScheduleToMonth(){
  DB.weeklySchedule = DB.weeklySchedule || {};
  const dim=daysInMonth(attMonth);
  const [y,m]=attMonth.split("-").map(Number);
  const emps=DB.employees.filter(e=>{
    if(e.status==="퇴사" && !e.leaveDate) return false;
    const first=attMonth+"-01", last=attMonth+"-"+String(dim).padStart(2,"0");
    if((e.joinDate||"").slice(0,10) > last) return false;
    if(e.leaveDate && e.leaveDate.slice(0,10) < first) return false;
    return true;
  });
  let count=0;
  emps.forEach(e=>{
    for(let d=1; d<=dim; d++){
      const day=attMonth+"-"+String(d).padStart(2,"0");
      const key=attKey(e.id,day);
      if(DB.attendance[key] && (DB.attendance[key].status==="연차" || DB.attendance[key].status==="결근" || DB.attendance[key].swap)) continue;
      const dow=new Date(y,m-1,d).getDay();
      const sc=getSchedule(e.id, dow);
       (function(){const __co=sc.on&&sc.start&&sc.start>="23:00"; DB.attendance[key]={employeeId:e.id, date:day, status:(sc.on&&!__co)?"출근":"휴무", closeOverride:__co?true:null};})();
      count++;
    }
  });
  syncAll();
  saveDB();
  render();
  wireAttendance();
  toast(`근무표를 출근부에 반영했어요 (${count}건)`);
}
function shiftMonth(delta){
  let [y,m]=attMonth.split("-").map(Number); m+=delta;
  if(m<1){m=12;y--;} if(m>12){m=1;y++;}
  attMonth=y+"-"+String(m).padStart(2,"0"); render();
}


/* =========================== 출근부 — 주간 보기 =========================== */
let attMode = "month";                 // "month" | "week"
let weekStart = mondayStr(todayStr());
function ymdLocal(d){ return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0"); }
function dateOf(s){ const p=String(s||"").split("-").map(Number); return new Date(p[0],(p[1]||1)-1,p[2]||1); }
function addDays(s,n){ const d=dateOf(s); d.setDate(d.getDate()+n); return ymdLocal(d); }
function mondayStr(s){ const d=dateOf(s); d.setDate(d.getDate()-((d.getDay()+6)%7)); return ymdLocal(d); }
function toMin(t){ const m=/^(\d{1,2}):(\d{2})$/.exec(t||""); return m?(+m[1])*60+(+m[2]):null; }
function fromMin(v){ return String(Math.floor(v/60)%24).padStart(2,"0")+":"+String(v%60).padStart(2,"0"); }
function setAttMode(m){ attMode=m; render(); if(attMode==="month") wireAttendance(); else wireWeek(); }
function shiftWeek(n){ weekStart=addDays(weekStart, n*7); render(); wireWeek(); }
function thisWeek(){ weekStart=mondayStr(todayStr()); render(); wireWeek(); }

/* 직무별 색 — 약사 / 중국어 / 일본어 / 물류 / 기타 */
const WK_GROUPS=[
  {key:"약무",   label:"약사",   bg:"#DBEAFE", fg:"#1E3A8A"},
  {key:"중국어", label:"중국어", bg:"#FEE2E2", fg:"#991B1B"},
  {key:"일본어", label:"일본어", bg:"#DCFCE7", fg:"#14532D"},
  {key:"물류",   label:"물류",   bg:"#FEF3C7", fg:"#78350F"},
  {key:"기타",   label:"기타",   bg:"#E2E8F0", fg:"#1E293B"},
];
function empGroup(e){
  const k = e && e.role==="통역" ? (e.team||"기타") : (e?e.role:"기타");
  return WK_GROUPS.find(g=>g.key===k) || WK_GROUPS[WK_GROUPS.length-1];
}
function empColor(e){ const g=empGroup(e); return [g.bg,g.fg]; }

/* 그 날 실제로 근무하는 사람들 — 근무변경 반영 */
function dayShifts(day){
  const dow=dateOf(day).getDay();
  const list=[];
  DB.employees.forEach(e=>{
    if((e.joinDate||"").slice(0,10) > day) return;
    if(e.leaveDate && e.leaveDate.slice(0,10) < day) return;
    if(e.status==="퇴사" && !e.leaveDate) return;
    const rec=DB.attendance[attKey(e.id,day)];
    const st=rec?rec.status:null;
    if(st==="연차"||st==="결근"||st==="휴무") return;
    const sc=getSchedule(e.id,dow);
    const sw=rec&&rec.swap;
    let start=null,end=null;
    if(sw&&sw.start&&sw.end){ start=sw.start; end=sw.end; }
    else if(sc.on){ start=sc.start; end=sc.end; }
    else if(st==="출근"){ start=sc.start||"09:00"; end=sc.end||"18:00"; }
    if(!start||!end) return;
    const close = (rec && rec.closeOverride!=null) ? rec.closeOverride : !!sc.close;
    list.push({e, start, end, close, swap:sw||null, planned: !st});
  });
  return list.sort((a,b)=>(a.start||"").localeCompare(b.start||"")||(a.e.employeeNo||0)-(b.e.employeeNo||0));
}
function dayAbsences(day){
  const out=[];
  DB.employees.forEach(e=>{
    const rec=DB.attendance[attKey(e.id,day)];
    if(!rec) return;
    if(rec.swap && rec.swap.role==="빠짐") out.push({name:e.name, status:"넘김", who:empName(rec.swap.partnerId)});
    else if(rec.status==="연차"||rec.status==="결근") out.push({name:e.name, status:rec.status});
  });
  return out;
}

function renderAttendanceWeek(){
  const days=[0,1,2,3,4,5,6].map(i=>addDays(weekStart,i));
  const shifts=days.map(dayShifts);
  const absents=days.map(dayAbsences);

  // 표시할 시간 범위를 실제 근무에서 계산 (기본 10:00~23:00)
  let lo=10*60, hi=23*60;
  shifts.flat().forEach(s=>{
    const a=toMin(s.start); let b=toMin(s.end);
    if(a==null||b==null) return;
    if(b<=a) b+=24*60;
    lo=Math.min(lo,a); hi=Math.max(hi,b);
  });
  lo=Math.floor(lo/60)*60; hi=Math.ceil(hi/60)*60;
  const SLOT=30, rows=Math.max(1,(hi-lo)/SLOT);
  const hours=[]; for(let m=lo;m<=hi;m+=60) hours.push(m);

  const today=todayStr();
  const laneCount=shifts.map(l=>Math.max(1,l.length));
  const tmpl="58px "+laneCount.map(n=>`minmax(${n*66+10}px,1fr)`).join(" ");
  const head=days.map((d,i)=>{
    const dt=dateOf(d), we=(i>=5);
    const hol=(DB.holidays||[]).includes(d);
    return `<div class="wk-h${we?" we":""}${hol?" hol":""}${d===today?" today":""}">
      <b>${DOW_LABELS[dt.getDay()]}</b><span>${dt.getMonth()+1}/${dt.getDate()}</span></div>`;
  }).join("");

  const cols=days.map((d,i)=>{
    const list=shifts[i];
    const lanes=laneCount[i];
    const blocks=list.map((s,li)=>{
      const a=toMin(s.start); let b=toMin(s.end); if(b<=a) b+=24*60;
      const r1=Math.round((a-lo)/SLOT)+1, r2=Math.round((b-lo)/SLOT)+1;
      const [bg,fg]=empColor(s.e);
      const tag = s.swap ? (s.swap.role==="대체"?"대":s.swap.role==="변경"?"변":"") : "";
      const title=`${s.e.name} ${s.start}~${s.end}${s.close?" (마감)":""}${s.swap?" · "+ (s.swap.role==="대체"?`${empName(s.swap.partnerId)} 대신 근무`:"근무시간 변경"):""}${s.planned?" · 근무표 기준 예정":""}`;
      return `<div class="wk-b${s.planned?" planned":""}" style="grid-row:${r1}/${r2};grid-column:${li+1};background:${bg};color:${fg}" title="${esc(title)}"${s.swap?` data-swapid="${s.swap.id}"`:""}>
        <b>${esc(s.e.name)}</b>${tag?`<i class="wk-tag">${tag}</i>`:""}
        <span>${s.start}~${s.end}</span>${s.close?'<span class="wk-close">마감</span>':""}
      </div>`;
    }).join("");
    const off=absents[i].length?`<div class="wk-off">${absents[i].map(x=>x.status==="넘김"?`${esc(x.name)} <span class="wk-gave">→ ${esc(x.who)}</span>`:`${esc(x.name)} <span>${x.status}</span>`).join(" · ")}</div>`:"";
    return `<div class="wk-col"><div class="wk-grid" style="grid-template-rows:repeat(${rows},var(--wk-rh));grid-template-columns:repeat(${lanes},minmax(62px,1fr))">
      ${Array.from({length:rows},(_,r)=>`<div class="wk-line" style="grid-row:${r+1};grid-column:1/-1${(lo+r*SLOT)%60===0?"":";border-top-style:dotted"}"></div>`).join("")}
      ${blocks}</div>${off}</div>`;
  }).join("");

  const total=shifts.reduce((n,l)=>n+l.length,0);
  const usedKeys=[...new Set(shifts.flat().map(s=>empGroup(s.e).key))];
  const gLegend=WK_GROUPS.filter(g=>usedKeys.includes(g.key)).map(g=>
    `<span><i style="display:inline-block;width:11px;height:11px;border-radius:3px;background:${g.bg};border:1px solid rgba(0,0,0,.14);vertical-align:-1px;margin-right:5px"></i>${g.label}</span>`).join("");
  return `
  ${headHTML("출근부","주간 근무표 — 요일별 실제 근무 시간을 한눈에")}
  <div class="toolbar">
    <div class="seg"><button class="btn sm" onclick="setAttMode('month')">월간</button><button class="btn sm active" onclick="setAttMode('week')">주간</button></div>
    <button class="btn sm" onclick="shiftWeek(-1)">‹ 지난주</button>
    <button class="btn sm" onclick="thisWeek()">이번주</button>
    <button class="btn sm" onclick="shiftWeek(1)">다음주 ›</button>
    <input type="date" value="${weekStart}" onchange="weekStart=mondayStr(this.value); render(); wireWeek()" style="padding:8px 11px; border:1px solid var(--border-strong); border-radius:9px">
    <button class="btn sm" onclick="openShiftChangeForm()">＋ 근무변경</button>
    <div class="grow"></div>
    <span class="hint">${fmtDate(weekStart)} ~ ${fmtDate(addDays(weekStart,6))} · 근무 ${total}건</span>
  </div>
  <div class="panel"><div class="att-wrap">
    <div class="wk" style="--wk-rh:17px">
      <div class="wk-hrow" style="grid-template-columns:${tmpl}"><div class="wk-h corner"></div>${head}</div>
      <div class="wk-brow" style="grid-template-columns:${tmpl}">
        <div class="wk-times" style="grid-template-rows:repeat(${rows},var(--wk-rh))">
          ${hours.map(m=>{const r=Math.round((m-lo)/SLOT)+1; return `<div class="wk-t" style="grid-row:${r}${r<=rows?"/span 2":""}">${m>=24*60?"24:00":fromMin(m)}</div>`;}).join("")}
        </div>
        ${cols}
      </div>
    </div>
  </div>
  <div class="legend">${gLegend}<span style="opacity:.45">|</span><span>블록 = 실제 근무 시간 (근무변경 반영)</span><span><b>대</b> 대체 근무 · <b>변</b> 시간 변경</span><span style="opacity:.55">연한 블록 = 출근부 미기록, 근무표 기준 예정</span><span>블록에 마우스를 올리면 바뀐 상대 블록이 함께 반짝여요</span><span>블록 클릭 → 근무변경 등록/상세</span></div>
  </div>`;
}
function wireWeek(){
  document.querySelectorAll(".wk-b").forEach(el=>{
    el.onclick=()=>{ const d=el.closest(".wk-col"); const i=[...document.querySelectorAll(".wk-col")].indexOf(d);
      const day=addDays(weekStart,i); const nm=(el.querySelector("b")||{}).textContent||"";
      const emp=DB.employees.find(x=>x.name===nm); if(emp) openSwapFromCell(emp.id, day); };
  });
  document.querySelectorAll(".wk-b[data-swapid]").forEach(el=>{
    el.onmouseenter=()=>{ clearSwapHighlight();
      document.querySelectorAll(`.wk-b[data-swapid="${el.dataset.swapid}"]`).forEach(x=>x.classList.add(x===el?"swap-hl-self":"swap-hl")); };
    el.onmouseleave=clearSwapHighlight;
  });
}

/* =========================== 급여관리 (약국장 전용) =========================== */
function renderPayroll(){
if(!isOwner()){ return `<div class="panel" style="padding:40px;text-align:center;color:var(--muted)">권한이 없습니다.</div>`; }
const list=[...DB.employees].sort((a,b)=>(a.employeeNo||0)-(b.employeeNo||0));
return `
${headHTML("급여관리","약국장 전용 · 급여·계좌·이메일 관리")}
<div class="panel"><div class="att-wrap">
${list.length? `<table>
<thead><tr><th class="num" style="width:56px">사번</th><th>이름</th><th>직무</th><th>급여형태</th><th class="num">급여액</th><th>계좌</th><th>이메일</th><th>상태</th><th></th></tr></thead>
<tbody>${list.map(e=>`<tr>
<td class="num">${e.employeeNo??"—"}</td>
<td><span class="name">${esc(e.name)}</span></td>
<td><span class="tag t-ice">${esc(e.role)}</span></td>
<td>${PAY_LABEL[e.payType]||"—"}</td>
<td class="num">${e.payAmount?won(e.payAmount):"—"}</td>
<td>${esc(e.bankAccount||"—")}</td>
<td>${esc(e.email||"—")}</td>
<td>${statusTag(e.status)}</td>
<td class="num"><button class="btn sm" onclick="openPayrollForm(${e.id})">수정</button></td>
</tr>`).join("")}</tbody>
</table>`:`<div class="empty"><div class="big">등록된 직원이 없어요</div></div>`}
</div></div>`;
}
function openPayrollForm(id){
const e=DB.employees.find(x=>x.id===id);
if(!e) return;
modal(`${esc(e.name)} 급여정보 수정`, `
<div class="grid2">
<div class="field"><label>급여형태</label><select id="p_paytype">${PAY_TYPES.map(p=>`<option value="${p.value}" ${e.payType===p.value?"selected":""}>${p.label}</option>`).join("")}</select></div>
<div class="field"><label>급여액</label><input id="p_payamount" type="number" min="0" value="${e.payAmount??""}" placeholder="숫자만 입력"></div>
<div class="field full"><label>계좌</label><input id="p_bank" value="${esc(e.bankAccount||"")}" placeholder="은행 + 계좌번호"></div>
<div class="field full"><label>이메일</label><input id="p_email" type="email" value="${esc(e.email||"")}" placeholder="example@mail.com"></div>
</div>
`, [
`<button class="btn" onclick="closeModal()">취소</button>`,
`<button class="btn primary" onclick="savePayroll(${id})">저장</button>`,
]);
}
function savePayroll(id){
const e=DB.employees.find(x=>x.id===id);
if(!e) return;
e.payType = val("p_paytype")||null;
e.payAmount = val("p_payamount")?Number(val("p_payamount")):null;
e.bankAccount = val("p_bank")||null;
e.email = val("p_email")||null;
saveDB(); closeModal(); render(); toast("급여정보를 저장했습니다");
}

/* =========================== 공통 UI =========================== */
function headHTML(title, desc, actions=""){
  return `<div class="head"><div><h1>${title}</h1><div class="desc">${desc}</div></div><div>${actions}</div></div>`;
}
function modal(title, bodyHTML, footBtns=[], wide=false){
  document.getElementById("modalRoot").innerHTML=`
    <div class="modal-bg" onclick="if(event.target===this)closeModal()">
      <div class="modal ${wide?'wide':''}">
        <div class="m-head"><h3>${title}</h3><button class="x" onclick="closeModal()">×</button></div>
        <div class="m-body">${bodyHTML}</div>
        <div class="m-foot">${footBtns.join("")}</div>
      </div>
    </div>`;
}
function closeModal(){ document.getElementById("modalRoot").innerHTML=""; }

/* =========================== 백업/복원/샘플 =========================== */
function exportData(){
  const blob=new Blob([JSON.stringify(DB,null,2)],{type:"application/json"});
  const a=document.createElement("a"); a.href=URL.createObjectURL(blob);
  a.download=`인사관리_백업_${todayStr()}.json`; a.click(); URL.revokeObjectURL(a.href);
  toast("백업 파일을 저장했습니다");
}
function importData(file){
  const r=new FileReader();
  r.onload=()=>{ try{
    const d=JSON.parse(r.result);
    if(!d.employees) throw 0;
    if(!confirm("현재 데이터를 이 백업으로 덮어씁니다. 계속할까요?")) return;
    DB=d; DB.attendance||={}; DB.seq||=1; saveDB(); render(); toast("백업을 불러왔습니다");
  }catch(e){ toast("올바른 백업 파일이 아니에요"); } };
  r.readAsText(file);
}
function seedSample(){
  const base=[
    ["김지현","약무","정규직","",  "2022-03-02","MONTHLY",3200000],
    ["이수민","통역","정규직","중국어","2024-08-01","MONTHLY",2600000],
    ["박준호","통역","정규직","일본어","2025-11-03","MONTHLY_NET",2400000],
    ["최유나","물류","파트타임","","2025-05-12","HOURLY",12000],
    ["장하람","약무","파트타임","","2026-02-10","DAILY",90000],
  ];
  base.forEach((b,i)=>DB.employees.push({
    id:nextId(), employeeNo:i+1, name:b[0], role:b[1], empType:b[2], team:b[3]||null,
    status:"재직", leaveDate:null, joinDate:b[4], payType:b[5], payAmount:b[6],
    phone:null, visa:null, bankAccount:null, memo:null, email:null,
  }));
  // 샘플 휴가 몇 건
  const chr=DB.employees.find(e=>e.name==="김지현");
  if(chr){ DB.leaves.push({id:nextId(),employeeId:chr.id,leaveType:"연차",days:2,startDate:"2026-05-04",endDate:"2026-05-05",status:"승인",memo:null});
           DB.leaves.push({id:nextId(),employeeId:chr.id,leaveType:"반차(오후)",days:0.5,startDate:"2026-06-11",endDate:"2026-06-11",status:"대기",memo:"병원"}); }
  saveDB(); render(); toast("샘플 데이터를 채웠습니다");
}

/* =========================== 로그인/부팅 =========================== */
function doLogin(){
  const pw=document.getElementById("pw").value;
  if(pw===ADMIN_PW || pw===STAFF_PW){
    sessionStorage.setItem("hr_auth","1");
    sessionStorage.setItem("hr_role", pw===ADMIN_PW?"owner":"staff");
updateNavVisibility();
    document.getElementById("login").classList.add("hidden");
    document.getElementById("app").classList.remove("hidden");
    render();
  } else {
    document.getElementById("loginErr").textContent="비밀번호가 올바르지 않습니다.";
  }
}
async function boot(){
  await loadDB();
  document.getElementById("loginBranch").textContent=BRANCH+" · 인사관리 시스템";
updateNavVisibility();
  document.getElementById("sideBranch").textContent=BRANCH;
  document.getElementById("loginBtn").onclick=doLogin;
  document.getElementById("pw").addEventListener("keydown",e=>{ if(e.key==="Enter") doLogin(); });
  document.querySelectorAll("#nav button").forEach(b=>b.onclick=()=>setView(b.dataset.view));
  document.getElementById("logoutBtn").onclick=()=>{ sessionStorage.removeItem("hr_auth"); location.reload(); };
  document.getElementById("exportBtn").onclick=exportData;
  document.getElementById("importBtn").onclick=()=>document.getElementById("importFile").click();
  document.getElementById("importFile").onchange=e=>{ if(e.target.files[0]) importData(e.target.files[0]); e.target.value=""; };
  if(sessionStorage.getItem("hr_auth")==="1"){
updateNavVisibility();
    document.getElementById("login").classList.add("hidden");
    document.getElementById("app").classList.remove("hidden");
    render();
  }
}
boot();
