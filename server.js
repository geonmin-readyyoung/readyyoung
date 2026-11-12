const path = require("path");
const crypto = require("crypto");
const express = require("express");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "5mb" }));

/* ---- 로그인 / 관리자 권한 ----
   비밀번호는 서버에서만 확인한다 (화면 JS에 비밀번호를 두지 않음).
   관리자(약국장) 로그인에만 서명된 토큰을 주고, 급여 파일 추출(엑셀 양식 내려받기)은 이 토큰이 있어야 된다.
   비밀번호는 Railway 환경변수 HR_ADMIN_PW / HR_STAFF_PW 로 바꿀 수 있다 (없으면 기존 값). */
const ADMIN_PW = process.env.HR_ADMIN_PW || "admin1234";
const STAFF_PW = process.env.HR_STAFF_PW || "staff2024";
const TOKEN_SECRET = process.env.HR_TOKEN_SECRET || crypto.createHash("sha256").update("hr-token:" + ADMIN_PW).digest("hex");
const TOKEN_TTL_MS = 12 * 60 * 60 * 1000;

function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function signToken(role) {
  const body = Buffer.from(JSON.stringify({ role, exp: Date.now() + TOKEN_TTL_MS })).toString("base64url");
  const sig = crypto.createHmac("sha256", TOKEN_SECRET).update(body).digest("base64url");
  return body + "." + sig;
}
function readToken(req) {
  const m = /^Bearer (.+)$/.exec(req.get("authorization") || "");
  if (!m) return null;
  const [body, sig] = m[1].split(".");
  if (!body || !sig) return null;
  const want = crypto.createHmac("sha256", TOKEN_SECRET).update(body).digest("base64url");
  if (!safeEqual(sig, want)) return null;
  try {
    const t = JSON.parse(Buffer.from(body, "base64url").toString());
    return t && t.exp > Date.now() ? t : null;
  } catch (_) { return null; }
}
function requireAdmin(req, res, next) {
  const t = readToken(req);
  if (!t || t.role !== "owner") return res.status(403).json({ error: "admin_only" });
  next();
}

app.post("/api/login", (req, res) => {
  const pw = String((req.body && req.body.pw) || "");
  if (safeEqual(pw, ADMIN_PW)) return res.json({ role: "owner", token: signToken("owner") });
  if (safeEqual(pw, STAFF_PW)) return res.json({ role: "staff" });
  res.status(401).json({ error: "bad_password" });
});

// 데이터 백업(내보내기) — 관리자 로그인만
app.get("/api/backup", requireAdmin, async (req, res) => {
  try {
    const r = await pool.query("SELECT data FROM hr_store WHERE id = $1", ["v1"]);
    res.set("Cache-Control", "no-store");
    res.json({ data: r.rows[0] ? r.rows[0].data : null });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "backup_failed" });
  }
});

// 급여 파일(근무시간기록표·급여변경사항) 엑셀 양식 — 관리자 로그인만
const TEMPLATE_DIR = path.join(__dirname, "templates");
const TEMPLATES = new Set(["worktime-template.xlsx", "payroll-changes-template.xlsx"]);
app.get("/api/payroll-template/:name", requireAdmin, (req, res) => {
  if (!TEMPLATES.has(req.params.name)) return res.status(404).json({ error: "not_found" });
  res.set("Cache-Control", "no-store");
  res.sendFile(path.join(TEMPLATE_DIR, req.params.name));
});

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes("localhost") ? false : { rejectUnauthorized: false },
});

async function ensureTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS hr_store (
      id TEXT PRIMARY KEY,
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}
ensureTable().catch((e) => console.error("DB init error:", e));

/* 승인·반려는 관리자만 — 직원 계정(토큰 없음)의 저장에서 휴가·근무변경 상태를 바꾸려 하면 막는다.
   직원은 새 요청을 '대기'로만 올리고, 대기 중인 요청만 고치거나 지울 수 있다.
   근무변경 연동 연차(fromShiftChange)는 승인된 근무변경에서 자동으로 생기는 것이라 그 근무변경 기준으로 본다. */
function approvalViolation(prev, next) {
  if (!prev) return null;
  const prevSc = new Map((prev.shiftChanges || []).map((c) => [c.id, c]));
  const nextSc = new Map((next.shiftChanges || []).map((c) => [c.id, c]));
  const check = (label, prevList, nextList) => {
    const pm = new Map(prevList.map((x) => [x.id, x]));
    const nm = new Map(nextList.map((x) => [x.id, x]));
    for (const x of nextList) {
      const p = pm.get(x.id);
      if (!p) { if (x.status !== "대기") return `${label} ${x.id}: 새 요청은 대기로만`; continue; }
      if (p.status === "대기" ? x.status !== "대기" : x.status !== p.status) return `${label} ${x.id}: 상태 변경`;
    }
    for (const p of prevList) if (p.status !== "대기" && !nm.has(p.id)) return `${label} ${p.id}: 승인·반려된 기록 삭제`;
    return null;
  };
  const own = (l) => !l.fromShiftChange;
  const v = check("근무변경", prev.shiftChanges || [], next.shiftChanges || [])
    || check("휴가", (prev.leaves || []).filter(own), (next.leaves || []).filter(own));
  if (v) return v;
  // 연동 연차는 승인된 근무변경(이전 판 기준, 그대로 승인 상태)에 붙은 것만
  for (const l of next.leaves || []) {
    if (!l.fromShiftChange) continue;
    const c = prevSc.get(l.fromShiftChange), n = nextSc.get(l.fromShiftChange);
    const wasLinked = (prev.leaves || []).some((x) => x.id === l.id && x.fromShiftChange === l.fromShiftChange);
    if (!wasLinked && !(c && c.status === "승인" && n && n.status === "승인")) return `연동 연차 ${l.id}`;
  }
  return null;
}

app.get("/api/db", async (req, res) => {
  try {
    const r = await pool.query("SELECT data FROM hr_store WHERE id = $1", ["v1"]);
    res.json({ data: r.rows[0] ? r.rows[0].data : null });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "load_failed" });
  }
});

// 저장 충돌 방지: 클라이언트가 불러온 판(_rev)과 서버의 현재 판이 같을 때만 저장한다.
// (다른 창·옛 화면이 먼저 저장된 최신 데이터를 덮어쓰지 못하게)
app.put("/api/db", async (req, res) => {
  const client = await pool.connect();
  try {
    const data = req.body || {};
    await client.query("BEGIN");
    const cur = await client.query("SELECT data FROM hr_store WHERE id = $1 FOR UPDATE", ["v1"]);
    const curRev = cur.rows[0] && cur.rows[0].data ? Number(cur.rows[0].data._rev || 0) : 0;
    const baseRev = Number(data._rev || 0);
    if (cur.rows[0] && baseRev !== curRev) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "conflict", rev: curRev });
    }
    const tok = readToken(req);
    if (!(tok && tok.role === "owner")) {
      const v = approvalViolation(cur.rows[0] && cur.rows[0].data, data);
      if (v) {
        await client.query("ROLLBACK");
        return res.status(403).json({ error: "approve_admin_only", detail: v });
      }
    }
    const next = curRev + 1;
    data._rev = next;
    await client.query(
      `INSERT INTO hr_store (id, data, updated_at) VALUES ('v1', $1, now())
       ON CONFLICT (id) DO UPDATE SET data = $1, updated_at = now()`,
      [data]
    );
    await client.query("COMMIT");
    res.json({ ok: true, rev: next });
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch (_) {}
    console.error(e);
    res.status(500).json({ error: "save_failed" });
  } finally {
    client.release();
  }
});

app.use(express.static(path.join(__dirname, "public")));

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log("HR server listening on port " + PORT);
});
