
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
let attMonth = ymNow();let leaveViewAll=false;function toggleLeaveViewAll(){ leaveViewAll=!leaveViewAll; render(); }let leaveAdjExpandedId=null;function toggleLeaveAdjRow(empId){ leaveAdjExpandedId=leaveAdjExpandedId===empId?null:empId; render(); }

/* =========================== 저장/로드 =========================== */
async function loadDB(){
  try{
    const r = await fetch("/api/db").then(x=>x.json());
    if(r && r.data){ DB = r.data; }
  }catch(e){ /* 최초 실행 = 데이터 없음 */ }
  DB.employees ||= []; DB.leaves ||= []; DB.attendance ||= {}; DB.weeklySchedule ||= {}; DB.seq ||= 1; DB.leaveAdjustments ||= []; migrateEmployeeNoFormat(); syncLeaveAttendance();
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
function todayStr(){ const d=new Date(); return d.toISOString().slice(0,10); }
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
  else if(view==="attendance"){ m.innerHTML=renderAttendance(); wireAttendance(); }
  else if(view==="schedule"){ m.innerHTML=renderSchedule(); wireSchedule(); }
else if(view==="payroll"){ m.innerHTML=renderPayroll(); }
}

/* =========================== 대시보드 =========================== */
function renderDashboard(){
  const emps=DB.employees;
  const active=emps.filter(e=>e.status==="재직");
  const parttime=active.filter(e=>e.empType==="파트타임").length;
  const pending=DB.leaves.filter(l=>l.status==="대기").length;
  // 이번 달 입사자 / 잔여연차 낮은 직원
  const todayDow=new Date().getDay();
    const todaySchedule=active.map(e=>({e,s:getSchedule(e.id,todayDow)})).filter(x=>x.s.on).sort((a,b)=>(a.s.start||"").localeCompare(b.s.start||""));
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
  </div>
  <div class="card-grid">
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
    <div class="panel">
      <div class="p-head"><h2>오늘 근무표 (${DOW_LABELS[todayDow]})</h2><button class="btn sm ghost" onclick="setView('schedule')">근무표 전체</button></div>
      ${todaySchedule.length? `<table><tbody>
        ${todaySchedule.map(({e,s})=>`<tr class="row-click" onclick="openCard(${e.id})">
          <td><span class="name">${esc(e.name)}</span></td>
          <td class="num">${s.start}~${s.end}${s.close?' <b class="close-tag">(마감)</b>':""}</td>
        </tr>`).join("")}
      </tbody></table>` : `<div class="empty" style="padding:28px">오늘 근무 예정인 직원이 없어요.</div>`}
    </div>
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
  syncLeaveAttendance(); saveDB(); closeModal(); render(); toast("휴가를 등록했습니다");
}
function setLeaveStatus(id, st){ const l=DB.leaves.find(x=>x.id===id); if(l){ l.status=st; syncLeaveAttendance(); saveDB(); render(); toast(st+" 처리했습니다"); } }
function deleteLeave(id, empId){ DB.leaves=DB.leaves.filter(x=>x.id!==id); syncLeaveAttendance(); saveDB(); if(document.getElementById("modalRoot").innerHTML && empId){ openCard(empId); } render(); toast("삭제했습니다"); } function renderLeaveAdjPanel(e){ if(!e) return ""; const list=(DB.leaveAdjustments||[]).filter(a=>a.employeeId===e.id).sort((a,b)=>(b.date||"").localeCompare(a.date||"")); return `<div class="panel" style="margin-top:16px"><div class="p-head"><h2>${esc(e.name)} - 연차 조정</h2><button class="btn sm ghost" onclick="toggleLeaveAdjRow(${e.id})">닫기</button></div><div class="card-grid"><div><div class="p-head"><h2 style="font-size:14px">연차 조정 추가</h2></div><div class="grid2"><div class="field"><label>방향</label><select id="adj_dir"><option value="차감">차감 (-)</option><option value="추가">추가 (+)</option></select></div><div class="field"><label>일수 (0.5 단위)</label><input id="adj_days" type="number" step="0.5" min="0.5" value="1"></div><div class="field"><label>사유 분류</label><select id="adj_reason">${LEAVE_ADJ_REASONS.map(r=>`<option>${r}</option>`).join("")}</select></div><div class="field"><label>적용일</label><input id="adj_date" type="date" value="${todayStr()}"></div><div class="field full"><label>메모</label><input id="adj_memo" placeholder="구체적 사유 (선택)"></div></div><button class="btn primary" style="margin-top:8px" onclick="addLeaveAdjustment(${e.id})">차감/조정 추가</button></div><div><div class="p-head"><h2 style="font-size:14px">차감/조정 내역</h2></div>${list.length?`<div class="att-wrap"><table><tbody>${list.map(a=>`<tr><td>${fmtDate(a.date)}</td><td>${a.direction==="추가"?'<span class="tag t-ok">+'+a.days+'일</span>':'<span class="tag t-bad">-'+a.days+'일</span>'}</td><td>${esc(a.reasonType||"")}</td><td class="hint">${esc(a.memo||"")}</td><td class="num"><button class="btn sm ghost" onclick="deleteLeaveAdjustment(${a.id})">삭제</button></td></tr>`).join("")}</tbody></table></div>`:`<div class="hint" style="padding:10px 4px">내역이 없습니다.</div>`}</div></div></div>`; } function addLeaveAdjustment(empId){ const dir=document.getElementById("adj_dir").value; const days=Number(document.getElementById("adj_days").value||0); if(!days){ toast("일수를 입력하세요"); return; } const reason=document.getElementById("adj_reason").value; const date=document.getElementById("adj_date").value||todayStr(); const memo=document.getElementById("adj_memo").value||null; DB.leaveAdjustments=DB.leaveAdjustments||[]; DB.leaveAdjustments.push({id:nextId(), employeeId:empId, direction:dir, days, reasonType:reason, date, memo}); saveDB(); render(); toast("연차를 조정했습니다"); } function deleteLeaveAdjustment(id){ DB.leaveAdjustments=(DB.leaveAdjustments||[]).filter(x=>x.id!==id); saveDB(); render(); toast("삭제했습니다"); }

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
    let worked=0;
    const cells=dayHdr.map(({d})=>{
      const day=attMonth+"-"+String(d).padStart(2,"0");
      const st=DB.attendance[attKey(e.id,day)]?.status || "";
      const dow=new Date(y,m-1,d).getDay();
      const sc=(DB.weeklySchedule&&DB.weeklySchedule[e.id])?DB.weeklySchedule[e.id][dow]:null;
      const cls=st==="연차"?"leave":st==="출근"?"on":st==="결근"?"absent":st==="휴무"?"off":(sc?(sc.on?"sched-on":"sched-off"):"");
      if(st==="출근") worked++;
      const mark=st==="연차"?"연":st==="출근"?"○":st==="결근"?"×":st==="휴무"?"–":(sc?(sc.on?"○":"–"):"");
      return `<td class="${cls}${(sc&&sc.on&&sc.close)?" close":""}"${(sc&&sc.on&&sc.close)?` title="마감조 (${sc.start}~${sc.end})"`:""}><button class="cell" data-emp="${e.id}" data-day="${day}">${mark}</button></td>`;
    }).join("");
    return `<tr><td class="emp">${esc(e.name)} <span class="hint">(${worked})</span></td>${cells}</tr>`;
  }).join("");

  return `
  ${headHTML("출근부","직원 월별 근무 기록 · 셀 클릭으로 상태 변경")}
  <div class="toolbar">
    <button class="btn sm" onclick="shiftMonth(-1)">‹ 이전달</button>
    <input type="month" value="${attMonth}" onchange="attMonth=this.value; render()" style="padding:8px 11px; border:1px solid var(--border-strong); border-radius:9px">
    <button class="btn sm" onclick="shiftMonth(1)">다음달 ›</button>
    <button class="btn sm" onclick="applyScheduleToMonth()">근무표 반영</button>
    <div class="grow"></div>
    <span class="hint">${emps.length}명 · 괄호 안은 출근일수</span>
  </div>
  <div class="panel"><div class="att-wrap">
    ${emps.length? `<table class="att">
      <thead><tr><th class="emp">직원</th>${dayHdr.map(h=>`<th class="${h.we?'we':''}">${h.d}</th>`).join("")}</tr></thead>
      <tbody>${body}</tbody>
    </table>`:`<div class="empty"><div class="big">이 달에 표시할 파트타임 직원이 없어요</div><div>직원을 파트타임으로 등록하면 여기에 나타납니다.</div></div>`}
  </div></div>
  <div class="legend"><span><b>○</b> 출근</span><span><b>–</b> 휴무</span><span><b>×</b> 결근</span><span><b style="color:#DC2626">연</b> 연차</span><span><i style="display:inline-block;width:10px;height:3px;background:#8B5CF6;border-radius:2px;vertical-align:middle;margin-right:5px"></i>마감조 (근무표에서 지정)</span><span>클릭할 때마다: 출근 → 휴무 → 결근 → 없음 순환</span><span style="opacity:.55">연하게 표시된 칸 = 근무표 기준 예정</span></div>`;
}
function wireAttendance(){
  document.querySelectorAll(".att .cell").forEach(btn=>{
    btn.onclick=()=>{
      const emp=Number(btn.dataset.emp), day=btn.dataset.day, key=attKey(emp,day);
      const cur=DB.attendance[key]?.status || "";
      if(cur==="연차"){ toast("연차는 휴가 등록에서 관리돼요"); return; } const nextMap={"":"출근","출근":"휴무","휴무":"결근","결근":""};
      const nx=nextMap[cur];
      if(nx==="") delete DB.attendance[key];
      else DB.attendance[key]={employeeId:emp, date:day, status:nx};
      saveDB(); render(); wireAttendance();
    };
  });
}
const DOW_LABELS=["일","월","화","수","목","금","토"];
const DOW_ORDER=[1,2,3,4,5,6,0];
const SHIFT_PRESETS = {
A:{start:"10:00", end:"20:00", label:"A (10:00~20:00)"},
B:{start:"13:00", end:"23:00", label:"B (13:00~23:00)"},
};
function shiftTypeOf(s){
if(s.start===SHIFT_PRESETS.A.start && s.end===SHIFT_PRESETS.A.end) return "A";
if(s.start===SHIFT_PRESETS.B.start && s.end===SHIFT_PRESETS.B.end) return "B";
return "custom";
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
    return headHTML("근무표","반복되는 주간 근무 스케줄을 등록하세요.") + `<div class="panel" style="padding:40px;text-align:center;color:var(--muted)">등록된 직원이 없어요.</div>`;
  }
  const head = `<tr><th class="emp">이름</th>${DOW_ORDER.map(d=>`<th class="${d===0?"we":""}">${DOW_LABELS[d]}</th>`).join("")}</tr>`;
  const body = emps.map(e=>{
    const cells = DOW_ORDER.map(d=>{
      const s=getSchedule(e.id,d);
      const cls = "shift-"+(s.on? shiftTypeOf(s):"off")+(s.on&&s.close?" closing":"");
      const mark = s.on? `${s.start}~${s.end}${s.close?' <b class="close-tag">(마감)</b>':""}`:"휴무";
      return `<td class="${cls}"><button class="cell" data-emp="${e.id}" data-dow="${d}">${mark}</button></td>`;
    }).join("");
    return `<tr><td class="emp">${esc(e.name)}</td>${cells}</tr>`;
  }).join("");
  return `
    ${headHTML("근무표","반복되는 주간 근무 스케줄을 등록하면 출근부에 자동으로 반영돼요.")}
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
<option value="A" ${curType==="A"?"selected":""}>${SHIFT_PRESETS.A.label}</option>
<option value="B" ${curType==="B"?"selected":""}>${SHIFT_PRESETS.B.label}</option>
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
if(type==="A"){ start=SHIFT_PRESETS.A.start; end=SHIFT_PRESETS.A.end; }
else if(type==="B"){ start=SHIFT_PRESETS.B.start; end=SHIFT_PRESETS.B.end; }
else if(type==="custom"){ const st=val("sf_start"), en=val("sf_end"), tre=/^([01][0-9]|2[0-3]):[0-5][0-9]$/; start = tre.test(st)?st:"09:00"; end = tre.test(en)?en:"18:00"; } else { start="09:00"; end="18:00"; }
DB.weeklySchedule = DB.weeklySchedule || {};
DB.weeklySchedule[empId] = DB.weeklySchedule[empId] || {};
const closeEl=document.getElementById("sf_close"); const close = on && closeEl ? closeEl.checked : false; DB.weeklySchedule[empId][dow] = {on, start, end, close};
saveDB();
closeModal();
render();
wireSchedule();
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
    const ws=DB.weeklySchedule[e.id];
    if(!ws) return;
    for(let d=1; d<=dim; d++){
      const day=attMonth+"-"+String(d).padStart(2,"0");
      const key=attKey(e.id,day);
      if(DB.attendance[key]) continue;
      const dow=new Date(y,m-1,d).getDay();
      const sc=ws[dow];
      if(!sc) continue;
      DB.attendance[key]={employeeId:e.id, date:day, status: sc.on?"출근":"휴무"};
      count++;
    }
  });
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
