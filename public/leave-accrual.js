/* =========================================================================
   연차 발생·잔여 (근로기준법 제60조) — 시간 단위 장부
   - 안에서는 모두 "시간"으로 쌓고 빼고, 화면에서만 0.5일 단위(내림) + 정확한 시간으로 보여준다.
   - 기준일: 입사일 (매 입사기념일에 발생)
   - 1년 미만: 입사 후 한 달을 채울 때마다, 그 한 달 동안 결근이 없으면 8h × (주 소정시간 ÷ 40) — 최대 11번
               1주년이 되면 남은 시간 소멸 (60조 7항)
   - 1년 이상: 매 입사기념일에 지난 1년 출근율 계산
               80% 이상 → (15 + ⌊(근속연수−1)/2⌋, 최대 25)일 × 8h × (주 소정시간 ÷ 40)
               80% 미만 → 그 1년 중 결근 없는 달 수 × 8h × (주 소정시간 ÷ 40)
               발생일로부터 1년 지나면 남은 시간 소멸 (설정에서 "이월"로 바꿀 수 있음)
   - 주 소정근로시간 15시간 미만은 연차 없음 (18조 3항)
   - 휴직(휴가 종류 '휴직'): 그 날은 소정근로일에서 뺀다. 한 달 내내 휴직이면 그 달 월차 없음,
             1년 이상은 출근율을 휴직 뺀 날로 보고 15일을 근로일÷(근로일+휴직일)로 비례
   - 근무변경: 결근 → 결근 / 대체로 빠진 날·근무일자 변경으로 비운 날 → 쉬는 날(소정근로일 아님) /
             옮겨 간 날·맞교대로 받은 날 → 근무일 / 원래 쉬는 날 대신 나온 날(추가 근무) → 소정근로일에 안 넣음 /
             근무시간 변경·일부 이동·지각·조퇴·외출 → 그날 출근 그대로 / 연차·출산휴가·육아휴직·병가·경조사 → 출근으로 봄
   - 출근율: 출근부 기준. 근무표상 근무일(출근·반차·연차·휴가·결근) 중 "결근"만 빠진 날로 센다
             (연차·병가·경조사 등 승인된 휴가는 결근이 아님)
   - 사용: 연차 1일 = 그 날 근무표상 소정근로시간(휴게 제외, 8h 상한 — 20~23시면 3h), 반차 = 그 절반.
           근무표가 없는 날은 1일 소정시간. 소멸일이 빠른 발생분부터 차감
   - 주 소정근로시간: 직원 정보 입력값 > 근무표로 계산(요일별 근로시간 8h 상한의 합) > 주 근무일 × 8
     발생량은 그 달(1년 이상은 그 1년)의 근무표 이력으로 평균을 내서 비례 — 근무시간이 바뀐 직원도 기간별로 맞게 쌓인다
   ========================================================================= */
const LEAVE_FULL_WEEK_H = 40;   // 통상근로자 주 소정근로시간
const LEAVE_DAY_H = 8;          // 통상근로자 1일 소정근로시간
const LEAVE_MIN_WEEK_H = 15;    // 이 미만이면 연차 없음
const LEAVE_MODES = [
  {value:"", label:"기본값"},
  {value:"auto", label:"법정 연차 계산"},
  {value:"none", label:"연차 없음"},
];

/* ---- 날짜 (YYYY-MM-DD 문자열) ---- */
/* n개월 뒤 같은 날 — 그 달에 그 날이 없으면 말일 (1/31 + 1개월 = 2/28) */
function addMonthsYmd(ymd, n){
  const [y,m,d]=String(ymd).slice(0,10).split("-").map(Number);
  const t=(m-1)+n, Y=y+Math.floor(t/12), M=((t%12)+12)%12;
  const last=new Date(Y, M+1, 0).getDate();
  return Y+"-"+String(M+1).padStart(2,"0")+"-"+String(Math.min(d,last)).padStart(2,"0");
}
function minYmd(a,b){ return !a ? b : !b ? a : (a<b?a:b); }

/* ---- 직원별 기준값 ---- */
/* 그 날 근무표상 소정근로시간 — 근로시간(휴게 제외) 중 8시간까지 (넘는 건 연장근로)
   예) 10:00~20:00 → 근로 9h → 소정 8h / 20:00~23:00 → 3h / 19:00~23:00 → 4h. 근무표에 없는 날은 null */
function schedWorkH(empId, day){
  const sc=scheduleOn(empId, day); if(!sc || !sc.on || !sc.start || !sc.end) return null;
  const h=segHours(sc.start, sc.end); if(!(h>0)) return null;
  const brk = h<4 ? 0 : h<8 ? 0.5 : 1;   // 근로기준법 54조 휴게
  return Math.min(LEAVE_DAY_H, h-brk);
}
/* 근무표의 한 주 소정근로시간 (격주 근무는 절반으로) — 근무표가 없으면 null */
function schedWeekH(empId, day){
  const w=weekFor(empId, day||todayStr()); let sum=0, any=false;
  for(let dow=0; dow<7; dow++){
    const s=w && w[dow]; if(!s || !s.on || !s.start || !s.end) continue;
    const h=segHours(s.start, s.end); if(!(h>0)) continue;
    any=true; sum += Math.min(LEAVE_DAY_H, h-(h<4?0:h<8?0.5:1)) * (s.biweek ? 0.5 : 1);
  }
  return any ? Math.round(sum*100)/100 : null;
}
/* 주 소정근로시간 — 직원 정보에 입력한 값 > 근무표로 계산한 값 > 주 근무일 수 × 8 (최대 40) */
function weeklyHoursOf(e){
  const v=Number(e && e.weeklyHours);
  if(v>0) return v;
  const s=e && e.id!=null ? schedWeekH(e.id) : null;
  if(s) return Math.min(LEAVE_FULL_WEEK_H, s);
  return Math.min(LEAVE_FULL_WEEK_H, (Number(e && e.weeklyWorkDays)||5) * LEAVE_DAY_H);
}
/* 한 구간 [from, toExcl)의 평균 주 소정근로시간 — 근무표가 바뀐 이력(근무표 버전·격주)을 날짜별로 따라간다.
   직원 정보에 주 소정근로시간을 직접 넣었으면 그 값. 그 구간에 근무표가 하나도 없으면 지금 값 */
function periodWeekH(e, from, toExcl){
  const v=Number(e && e.weeklyHours); if(v>0) return v;
  // 날마다 그날 적용되는 주간 근무표의 주 소정시간을 구해 평균 (달력상 요일 수 차이에 흔들리지 않게)
  let sum=0, n=0;
  for(let d=from, g=0; d<toExcl && g<400; d=addDays(d,1), g++){ const w=schedWeekH(e.id, d); if(w!=null){ sum+=w; n++; } }
  if(!n) return weeklyHoursOf(e);
  return Math.min(LEAVE_FULL_WEEK_H, Math.round(sum/n*100)/100);
}
/* 1일 소정근로시간 — 주 소정시간 ÷ 주 근무일 수 (최대 8) · 화면에서 시간을 일수로 바꿀 때 쓰는 단위 */
function dayHoursOf(e){
  const days=Number(e && e.weeklyWorkDays)||5;
  return Math.min(LEAVE_DAY_H, weeklyHoursOf(e)/days) || LEAVE_DAY_H;
}
/* 연차 사용 기록 하나가 빼는 시간 — 쉰 날마다 그 날 근무표상 소정근로시간(8h 상한), 반차는 그 절반.
   근무표가 없는 날은 1일 소정시간으로 */
function leaveUseHours(e, l){
  const days=leaveDeductDays(l); if(!days) return 0;
  const a=(l.startDate||"").slice(0,10), b=(l.endDate||l.startDate||"").slice(0,10), dh=dayHoursOf(e);
  if(!a || a===b) return days * (schedWorkH(e.id, a) ?? dh);
  let sum=0, n=0;
  for(let d=a, g=0; d<=b && g<400; d=addDays(d,1), g++){ const h=schedWorkH(e.id, d); if(h!=null){ sum+=h; n++; } }
  if(!n) return days*dh;
  return sum * (days/n);   // 일수를 손으로 줄였으면 비례
}
/* 연차 계산 대상인지 — 직원 정보에서 정한 값 > 기본값
   기본값: 정규직은 계산 / 급여정산 구분이 "일용"·"제외"인 직원은 지금처럼 연차 없음 / 그 외 파트타임은 계산 */
function leaveModeOf(e){
  if(e.annualLeaveMode==="auto" || e.annualLeaveMode==="none") return {mode:e.annualLeaveMode, byDefault:false};
  if(e.empType==="정규직") return {mode:"auto", byDefault:true};
  const cat = (typeof payCfg==="function") ? payCfg(e).cat : null;
  if(cat==="일용" || cat==="제외") return {mode:"none", byDefault:true, why:`급여정산 구분이 ${cat==="일용"?"일용직":"정산 제외"}`};
  return {mode:"auto", byDefault:true};
}
function leaveEligibility(e){
  const m=leaveModeOf(e), w=weeklyHoursOf(e);
  if(m.mode==="none") return {ok:false, reason: m.byDefault ? `${m.why} — 기본값으로 연차 없음 (직원 정보에서 바꿀 수 있어요)` : "직원 정보에서 '연차 없음'으로 정했어요"};
  if(w < LEAVE_MIN_WEEK_H) return {ok:false, reason:`주 소정근로시간 ${fmtLeaveH(w)} — 15시간 미만은 연차가 없어요`};
  return {ok:true};
}

/* ---- 출근부에서 한 구간의 근무일·결근 세기 [from, toExcl) ---- */
const SCHED_DAY_ST = new Set(["출근","반차","연차","휴가","결근"]);
function leaveAttStats(e, from, toExcl){
  const stop=minYmd(toExcl, e.leaveDate ? addDays(e.leaveDate.slice(0,10),1) : null);
  let sched=0, absent=0, off=0, d=from, guard=0;
  while(d<stop && guard++<400){
    const info=attDayInfo(e, d), st=info.st;
    const sw=info.rec && info.rec.swap;
    if(st==="휴가" && info.rec && info.rec.leaveKind==="휴직") off++;   // 휴직한 날은 소정근로일에서 뺀다
    else if(sw && sw.role==="대체" && !scheduleOn(e.id, d).on){}      // 원래 쉬는 날 남의 근무를 대신 나온 날 — 소정근로일 아님
    else if(SCHED_DAY_ST.has(st)){ sched++; if(st==="결근") absent++; }
    d=addDays(d,1);
  }
  return {sched, absent, off};
}

/* ---- 발생 내역 (asOf 날짜까지) ---- */
function leaveGrants(e, asOf=todayStr()){
  const j=(e.joinDate||"").slice(0,10); if(!j) return [];
  const el=leaveEligibility(e); if(!el.ok) return [];
  // 발생량은 그 발생분을 만든 기간(한 달 / 1년)의 평균 주 소정근로시간으로 비례 — 중간에 근무시간이 바뀌어도 기간별로 반영
  const perDay=(from,to)=>{ const w=periodWeekH(e, from, to); return {w, h: w<LEAVE_MIN_WEEK_H ? 0 : LEAVE_DAY_H*w/LEAVE_FULL_WEEK_H}; };
  const last=minYmd(asOf, e.leaveDate ? e.leaveDate.slice(0,10) : null);   // 발생일에 재직 중이어야 발생
  const carry=!!(DB.settings && DB.settings.leaveCarryOver);
  const out=[];
  // 1년 미만 — 월 단위
  for(let k=1;k<=11;k++){
    const gd=addMonthsYmd(j,k); if(gd>last) break;
    const a=leaveAttStats(e, addMonthsYmd(j,k-1), gd);
    const allOff = a.off>0 && a.sched===0;   // 한 달 내내 휴직 — 근로가 없어 발생 없음
    const full=a.absent===0 && !allOff, pd=perDay(addMonthsYmd(j,k-1), gd);
    out.push({kind:"월차", date:gd, expire: carry?"9999-12-31":addMonthsYmd(j,12), hours: full?pd.h:0, days: full&&pd.h?1:0, weekH:pd.w, from:addMonthsYmd(j,k-1), sched:a.sched, absent:a.absent, off:a.off, allOff, full, n:k,
      basis: allOff ? `${k}개월째 휴직 ${a.off}일 — 근로 없어 발생 없음` : !full ? `${k}개월째 결근 ${a.absent}일 — 발생 없음` : !pd.h ? `${k}개월째 · 주 ${fmtLeaveH(pd.w)} (15시간 미만) — 발생 없음` : `${k}개월째 개근${a.sched?"":" (근무표 없음)"} · 주 ${fmtLeaveH(pd.w)}`});
  }
  // 1년 이상 — 매 입사기념일
  for(let n=1;n<=60;n++){
    const gd=addMonthsYmd(j,12*n); if(gd>last) break;
    let sched=0, absent=0, off=0, fullMonths=0;
    for(let k=0;k<12;k++){
      const a=leaveAttStats(e, addMonthsYmd(j,12*(n-1)+k), addMonthsYmd(j,12*(n-1)+k+1));
      sched+=a.sched; absent+=a.absent; off+=a.off; if(a.absent===0 && !(a.off>0 && a.sched===0)) fullMonths++;
    }
    const rate = sched ? (sched-absent)/sched : (off ? 0 : 1);
    // 출근율은 휴직일을 뺀 소정근로일로 보고, 80% 이상이면 휴직한 만큼 비례해서 줄인다 (근로일 ÷ (근로일+휴직일))
    const share = off ? sched/(sched+off) : 1;
    const baseDays = Math.min(25, 15+Math.floor((n-1)/2));
    const days = rate>=0.8 ? Math.round(baseDays*share*100)/100 : fullMonths;
    const pd=perDay(addMonthsYmd(j,12*(n-1)), gd);
    out.push({kind:"연차", date:gd, expire: carry?"9999-12-31":addMonthsYmd(gd,12), hours: days*pd.h, days, baseDays, share, rate, weekH:pd.w, from:addMonthsYmd(j,12*(n-1)), sched, absent, off, fullMonths, n,
      basis: (rate>=0.8 ? `${n}년 근속 · 출근율 ${Math.round(rate*1000)/10}%` : `출근율 ${Math.round(rate*1000)/10}% (80% 미만) — 개근한 ${fullMonths}개월분`) + ` · 평균 주 ${fmtLeaveH(pd.w)}`});
  }
  return out;
}

/* ---- 장부: 발생 → 사용·조정 → 소멸, 시간 단위 ---- */
function leaveLedger(e, asOf=todayStr()){
  if(e.leaveDate) asOf=minYmd(asOf, e.leaveDate.slice(0,10));   // 퇴사자는 퇴사일 기준으로 정산
  const el=leaveEligibility(e);
  const dh=dayHoursOf(e);
  const grants=leaveGrants(e, asOf);
  const ev=[];
  grants.filter(g=>g.hours>0).forEach(g=>ev.push({t:"add", date:g.date, expire:g.expire, hours:g.hours, src:g}));
  const pr=leavePeriod(e.joinDate, asOf);
  (DB.leaveAdjustments||[]).filter(a=>a.employeeId===e.id).forEach(a=>{
    const date=(a.date||asOf).slice(0,10), h=Number(a.days||0)*dh;
    if(a.direction==="추가") ev.push({t:"add", date, expire: (DB.settings&&DB.settings.leaveCarryOver)?"9999-12-31":leavePeriod(e.joinDate, dateOf(date)).to, hours:h, adj:true});
    else ev.push({t:"use", date, hours:h, adj:true});
  });
  (DB.leaves||[]).filter(l=>l.employeeId===e.id && l.status==="승인").forEach(l=>{
    const h=leaveUseHours(e, l); if(!h) return;
    const date=(l.startDate||"").slice(0,10);
    ev.push({t:"use", date: date>asOf ? asOf : date, realDate:date, hours:h});   // 앞으로 쓸 승인 연차는 지금 잔여에서 미리 뺀다
  });
  ev.sort((a,b)=>a.date.localeCompare(b.date) || (a.t==="add"?-1:1)+(b.t==="add"?1:-1));

  let buckets=[], debt=0, expiredH=0;
  const expireUntil=d=>{ buckets=buckets.filter(b=>{ if(b.expire<=d){ expiredH+=b.left; return false; } return true; }); };
  ev.forEach(x=>{
    expireUntil(x.date);
    if(x.t==="add"){
      let h=x.hours; const pay=Math.min(debt,h); debt-=pay; h-=pay;
      if(h>0) buckets.push({left:h, expire:x.expire, date:x.date});
    } else {
      let h=x.hours;
      buckets.sort((a,b)=>a.expire.localeCompare(b.expire));
      for(const b of buckets){ if(h<=0) break; const take=Math.min(b.left,h); b.left-=take; h-=take; }
      buckets=buckets.filter(b=>b.left>1e-9);
      debt+=h;   // 남은 연차보다 많이 쓰면 다음 발생분에서 메움 (잔여가 마이너스로 보임)
    }
  });
  expireUntil(asOf);
  const balanceH=round2(buckets.reduce((s,b)=>s+b.left,0)-debt);
  const inP=d=>d>=pr.from && d<pr.to;
  const accruedH=round2(grants.filter(g=>inP(g.date)).reduce((s,g)=>s+g.hours,0));
  const usedH=round2(ev.filter(x=>x.t==="use" && !x.adj && inP(x.realDate||x.date)).reduce((s,x)=>s+x.hours,0));
  const adjH=round2(ev.filter(x=>x.adj && inP(x.date)).reduce((s,x)=>s+(x.t==="add"?x.hours:-x.hours),0));
  const next=buckets.filter(b=>b.expire<"9999").sort((a,b)=>a.expire.localeCompare(b.expire))[0];
  return { eligible:el.ok, reason:el.reason, weeklyHours:weeklyHoursOf(e), dayHours:dh,
    grants, balanceH, accruedH, usedH, adjH, expiredH:round2(expiredH),
    nextExpire: next ? {date:next.expire, hours:round2(next.left)} : null, period:pr };
}
function round2(n){ return Math.round(n*100)/100; }

/* ---- 화면 표시 ---- */
function fmtLeaveH(h){ return (Math.round(Number(h||0)*10)/10)+"시간"; }
/* 0.5일 단위로 내림 — 실제보다 많아 보이지 않게. 정확한 값은 옆의 시간으로 */
function leaveDaysFloor(h, dh){ return Math.floor((Number(h||0)/(dh||LEAVE_DAY_H))*2 + 1e-9)/2; }
function fmtLeaveBal(h, dh, html=true){
  const d=leaveDaysFloor(h, dh);
  return html ? `${d}일 <span class="hint">(${fmtLeaveH(h)})</span>` : `${d}일 (${fmtLeaveH(h)})`;
}

/* 예전 화면들이 쓰던 요약 형태 + 시간 장부 */
function summarizeLeave(emp){
  const L=leaveLedger(emp);
  return { ...L, serviceMonths:monthsSince(emp.joinDate),
    remaining: leaveDaysFloor(L.balanceH, L.dayHours) };
}

/* 인사기록카드 — 잔여 연차 상자 */
function leaveBoxHTML(e){
  const s=summarizeLeave(e);
  if(!s.eligible) return `<div class="leave-box" style="background:var(--gray-bg); border-color:var(--border)"><div class="hint" style="margin-bottom:4px">연차</div><div class="hint">${esc(s.reason)}</div></div>`;
  const retired = e.status==="퇴사";
  const recent=[...s.grants].reverse().slice(0,14);
  return `<div class="leave-box">
    <div class="hint" style="margin-bottom:4px">${retired?"퇴사 시점 미사용 연차":"잔여 연차"}</div>
    <div class="rem">${leaveDaysFloor(s.balanceH, s.dayHours)}일 <span style="font-size:15px; font-weight:600">(${fmtLeaveH(s.balanceH)})</span></div>
    <div style="margin-top:12px; border-top:1px solid #D3E0FB; padding-top:8px">
      <div class="leave-line">주 소정근로 <b>${fmtLeaveH(s.weeklyHours)}</b> · 1일 <b>${fmtLeaveH(s.dayHours)}</b>${e.weeklyHours?"":` <span class="hint">(${schedWeekH(e.id)?"근무표로 계산":"주 근무일 수로 계산"})</span>`}</div>
      <div class="leave-line">연차 기간 <b>${fmtDate(s.period.from)} ~ ${fmtDate(addDays(s.period.to,-1))}</b></div>
      <div class="leave-line">이번 기간 발생 <b>${fmtLeaveH(s.accruedH)}</b> · 사용 <b>${fmtLeaveH(s.usedH)}</b>${s.adjH?` · 조정 <b>${s.adjH>0?"+":""}${fmtLeaveH(s.adjH)}</b>`:""}</div>
      ${s.nextExpire&&!retired?`<div class="leave-line">${fmtDate(s.nextExpire.date)} 소멸 예정 <b>${fmtLeaveH(s.nextExpire.hours)}</b></div>`:""}
      ${s.expiredH?`<div class="leave-line">지난 기간 소멸 <b>${fmtLeaveH(s.expiredH)}</b></div>`:""}
      ${retired&&s.balanceH>0?`<div class="leave-line" style="color:var(--warn)">퇴사 정산: 미사용 <b>${fmtLeaveH(s.balanceH)}</b> × 통상시급 = 연차수당</div>`:""}
    </div>
    ${recent.length?`<details style="margin-top:8px"><summary class="hint" style="cursor:pointer">발생 내역 ${s.grants.length}건</summary>
      <table style="margin-top:6px; font-size:12px"><tbody>${recent.map(g=>`<tr><td>${fmtDate(g.date)}</td><td>${g.kind}</td><td class="num">${g.hours?"+"+fmtLeaveH(g.hours):"—"}</td><td class="hint">${esc(g.basis)}</td></tr>`).join("")}</tbody></table></details>`:""}
  </div>`;
}

/* 이월 설정 (관리자) */
function setLeaveCarryOver(on){
  if(typeof isOwner==="function" && !isOwner()){ toast("관리자만 바꿀 수 있어요"); render(); return; }
  DB.settings=DB.settings||{}; DB.settings.leaveCarryOver=!!on; saveDB(); render();
  toast(on?"남은 연차를 다음 기간으로 이월해요":"발생 1년 뒤 남은 연차는 소멸해요");
}

/* 직원별 잔여 연차 › "이번 기간 발생" 클릭 — 발생분마다 산정 근거 */
function leaveCalcText(g){
  const w=Math.round(g.weekH*100)/100, ratio=`${w}/${LEAVE_FULL_WEEK_H}`;
  if(g.kind==="월차"){
    if(g.allOff) return `휴직 → 발생 없음`;
    if(!g.full) return `결근 ${g.absent}일 → 발생 없음`;
    if(!g.hours) return `주 ${fmtLeaveH(w)} (15시간 미만) → 발생 없음`;
    return `1일 × 8시간 × ${ratio}`;
  }
  if(!g.hours) return g.weekH<LEAVE_MIN_WEEK_H ? `주 ${fmtLeaveH(w)} (15시간 미만) → 발생 없음` : `개근한 달 없음 → 발생 없음`;
  if(g.off && g.rate>=0.8) return `${g.baseDays}일 × ${g.sched}/${g.sched+g.off}(휴직 비례) × 8시간 × ${ratio}`;
  return `${g.days}일 × 8시간 × ${ratio}`;
}
function openLeaveBasis(empId){
  const e=DB.employees.find(x=>x.id===empId); if(!e) return;
  const s=summarizeLeave(e);
  const inP=d=>d>=s.period.from && d<s.period.to;
  const list=s.grants.filter(g=>inP(g.date));
  const attTxt=g=> g.kind==="월차"
    ? (g.allOff ? `휴직 ${g.off}일 (근로 없음)` : g.sched ? `근무일 ${g.sched}일 · 결근 ${g.absent}일${g.off?` · 휴직 ${g.off}일`:""}${g.full?" (개근)":""}` : "근무표 없음 → 개근으로 봄")
    : `근무일 ${g.sched}일 · 결근 ${g.absent}일${g.off?` · 휴직 ${g.off}일`:""} · 출근율 ${Math.round(g.rate*1000)/10}%${g.rate>=0.8?"":` (80% 미만 → 개근한 ${g.fullMonths}개월분)`}`;
  const rule = list.some(g=>g.kind==="연차")
    ? "1년 이상: 매 입사기념일에 지난 1년 출근율 80% 이상이면 15일 + 2년마다 1일(최대 25일), 80% 미만이면 개근한 달 수만큼. 1일 = 8시간 × 주 소정시간/40"
    : "1년 미만: 입사 후 한 달을 결근 없이 채울 때마다 1일(최대 11번). 1일 = 8시간 × 그 달 평균 주 소정시간/40";
  modal(`${esc(e.name)} — 연차 산정 근거`, `
    <div class="hint" style="line-height:1.7; margin-bottom:12px">
      입사일 <b>${fmtDate(e.joinDate)}</b> · 이번 연차 기간 <b>${fmtDate(s.period.from)} ~ ${fmtDate(addDays(s.period.to,-1))}</b><br>
      ${rule}<br>
      주 소정시간: ${e.weeklyHours?`직원 정보에 입력한 값 <b>${fmtLeaveH(e.weeklyHours)}</b>`:"그 기간에 적용된 근무표의 평균 (요일별 근로시간 중 8시간까지, 휴게 제외)"} · 출근율·개근은 출근부의 결근 기록 기준
    </div>
    ${list.length?`<div class="att-wrap"><table>
      <thead><tr><th>발생일</th><th>구분</th><th>산정 기간</th><th>출근</th><th class="num" style="white-space:nowrap">주 소정</th><th>계산</th><th class="num">발생</th><th style="white-space:nowrap">소멸 예정</th></tr></thead>
      <tbody>${list.map(g=>`<tr>
        <td>${fmtDate(g.date)}</td>
        <td style="white-space:nowrap">${g.kind==="월차"?`${g.n}개월째`:`${g.n}년차`}</td>
        <td style="white-space:nowrap">${fmtDate(g.from)} ~ ${fmtDate(addDays(g.date,-1))}</td>
        <td class="hint">${attTxt(g)}</td>
        <td class="num" style="white-space:nowrap">${fmtLeaveH(g.weekH)}</td>
        <td style="white-space:nowrap">${leaveCalcText(g)}</td>
        <td class="num" style="white-space:nowrap"><b>${g.hours?fmtLeaveH(g.hours):"0시간"}</b></td>
        <td>${g.expire<"9999"?fmtDate(g.expire):"이월"}</td>
      </tr>`).join("")}
      <tr><td colspan="6" style="text-align:right"><b>이번 기간 발생 합계</b></td><td class="num" style="white-space:nowrap"><b>${fmtLeaveH(s.accruedH)}</b></td><td></td></tr>
      </tbody></table></div>`:`<div class="hint">이번 기간에 아직 발생한 연차가 없어요.</div>`}
    <div class="hint" style="margin-top:10px">사용 ${fmtLeaveH(s.usedH)}${s.adjH?` · 조정 ${s.adjH>0?"+":""}${fmtLeaveH(s.adjH)}`:""}${s.expiredH?` · 지난 기간 소멸 ${fmtLeaveH(s.expiredH)}`:""} → 잔여 <b>${fmtLeaveBal(s.balanceH, s.dayHours, false)}</b></div>
  `, [`<div style="flex:1"></div>`, `<button class="btn" onclick="closeModal()">닫기</button>`], true);
}
