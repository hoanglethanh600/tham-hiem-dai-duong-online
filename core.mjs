/*
 * Lõi xử lý API của máy chủ Thám Hiểm Đại Dương — dùng chung cho:
 * - server.mjs (máy chủ thường trực: local/Render/VPS)
 * - api/index.mjs (Vercel serverless)
 * Toàn bộ trạng thái đọc/ghi qua store.mjs (KV hoặc file).
 */

import { randomBytes, scryptSync, timingSafeEqual, createHash } from "node:crypto";
import { loadDb as loadFromStore, saveDb as saveToStore, KV_ENABLED, STORE_LABEL } from "./store.mjs";

const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_BODY = 8 * 1024 * 1024;

let db = null;
let dirty = false;

async function ensureDb() {
  // KV: nạp bản mới nhất mỗi request (nhiều instance dùng chung 1 kho).
  // File: nạp 1 lần rồi giữ trong bộ nhớ.
  if (KV_ENABLED || !db) db = await loadFromStore();
}

function saveDb() {
  dirty = true;
  void persist();
}

async function persist() {
  if (!db) return;
  const snapshot = db;
  try {
    await saveToStore(snapshot);
    if (db === snapshot) dirty = false;
  } catch (error) {
    console.error("Không lưu được dữ liệu:", error);
  }
}

const nextId = (prefix) => `${prefix}_${(db.seq++).toString(36)}${randomBytes(3).toString("hex")}`;

function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  try {
    const [salt, hash] = String(stored).split(":");
    const candidate = scryptSync(password, salt, 64);
    const expected = Buffer.from(hash, "hex");
    return candidate.length === expected.length && timingSafeEqual(candidate, expected);
  } catch {
    return false;
  }
}

function createSession(userId) {
  const token = randomBytes(32).toString("hex");
  db.sessions = db.sessions.filter((s) => s.expiresAt > Date.now());
  db.sessions.push({ tokenHash: createHash("sha256").update(token).digest("hex"), userId, expiresAt: Date.now() + TOKEN_TTL_MS });
  saveDb();
  return token;
}

function userFromRequest(req) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) return null;
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const session = db.sessions.find((s) => s.tokenHash === tokenHash && s.expiresAt > Date.now());
  if (!session) return null;
  return db.users.find((u) => u.id === session.userId) ?? null;
}

/* ------------------------------------------------------------------ */
/* Tiện ích HTTP                                                       */
/* ------------------------------------------------------------------ */

function send(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error("too_large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
      } catch {
        reject(new Error("bad_json"));
      }
    });
    req.on("error", reject);
  });
}

const publicUser = (u) => ({
  id: u.id,
  username: u.username,
  displayName: u.displayName,
  createdAt: u.createdAt,
});

function stateSummary(userId) {
  const state = db.states[userId];
  if (!state) return null;
  return { version: state.version, updatedAt: state.updatedAt, summary: state.summary ?? null };
}

function publicProfile(u) {
  const state = db.states[u.id];
  const summary = state?.summary ?? {};
  const team = db.teams.find((t) => t.members.some((m) => m.userId === u.id));
  return {
    ...publicUser(u),
    level: Number(summary.level) || 1,
    xp: Number(summary.xp) || 0,
    bestScore: Number(summary.bestScore) || 0,
    wallet: Number(summary.wallet) || 0,
    bossWins: Number(summary.bossWins) || 0,
    teamId: team?.id ?? null,
    teamName: team?.name ?? null,
    lastActiveAt: state?.updatedAt ?? u.createdAt,
  };
}

function relationBetween(meId, otherId) {
  const request = db.friendRequests.find(
    (r) =>
      (r.fromId === meId && r.toId === otherId) || (r.fromId === otherId && r.toId === meId),
  );
  if (!request) return "none";
  if (request.status === "accepted") return "friend";
  if (request.status === "pending") return request.fromId === meId ? "outgoing" : "incoming";
  return "none";
}

function teamOf(userId) {
  return db.teams.find((t) => t.members.some((m) => m.userId === userId)) ?? null;
}

function publicTeam(team) {
  return {
    id: team.id,
    name: team.name,
    desc: team.desc,
    leaderId: team.leaderId,
    createdAt: team.createdAt,
    score: Number(team.score) || 0,
    memberCount: team.members.length,
    members: team.members.map((m) => {
      const user = db.users.find((u) => u.id === m.userId);
      const profile = user ? publicProfile(user) : null;
      return {
        userId: m.userId,
        username: user?.username ?? m.userId,
        displayName: user?.displayName ?? m.userId,
        role: m.userId === team.leaderId ? "leader" : "member",
        joinedAt: m.joinedAt,
        contrib: Number(m.contrib) || 0,
        level: profile?.level ?? 1,
        xp: profile?.xp ?? 0,
        bestScore: profile?.bestScore ?? 0,
      };
    }),
    totalXp: team.members.reduce((sum, m) => {
      const user = db.users.find((u) => u.id === m.userId);
      return sum + (user ? Number(db.states[user.id]?.summary?.xp) || 0 : 0);
    }, 0),
  };
}

const rateBuckets = new Map();
function rateLimited(key, limit, windowMs) {
  const now = Date.now();
  const bucket = (rateBuckets.get(key) ?? []).filter((t) => now - t < windowMs);
  bucket.push(now);
  rateBuckets.set(key, bucket);
  return bucket.length > limit;
}

/* ------------------------------------------------------------------ */
/* Boss thế giới + hộp thư + chat (đợt 4)                              */
/* ------------------------------------------------------------------ */

const WORLD_BOSSES = [
  { name: "Mực Quỷ Biển Sâu", emoji: "🦑" },
  { name: "Cá Mập Cổ Đại Megalodon", emoji: "🦈" },
  { name: "Bạch Tuộc Kraken", emoji: "🐙" },
  { name: "Rùa Thần Ngàn Năm", emoji: "🐢" },
  { name: "Cá Voi Bóng Ma", emoji: "🐋" },
  { name: "Rồng Biển Leviathan", emoji: "🐉" },
];
const BOSS_HITS_PER_DAY = 10;
const dayKeyUtc = () => new Date().toISOString().slice(0, 10);

function spawnWorldBoss(cycle) {
  const def = WORLD_BOSSES[(cycle - 1) % WORLD_BOSSES.length];
  return {
    cycle,
    name: def.name,
    emoji: def.emoji,
    maxHp: 1500 + (cycle - 1) * 600,
    hp: 1500 + (cycle - 1) * 600,
    contributions: {},
    hits: {},
    spawnedAt: Date.now(),
  };
}

/** Khi boss bị hạ: chia quỹ thưởng theo tỉ lệ sát thương, gửi vào hộp thư từng người. */
function settleWorldBoss(boss, killerId) {
  const entries = Object.entries(boss.contributions).filter(([, dmg]) => dmg > 0);
  const totalDamage = entries.reduce((sum, [, dmg]) => sum + dmg, 0);
  if (totalDamage <= 0) return;
  const pool = 1000 + (boss.cycle - 1) * 200;
  for (const [userId, dmg] of entries) {
    const share = Math.max(10, Math.floor((pool * dmg) / totalDamage));
    db.inbox.push({
      id: nextId("ib"),
      toId: userId,
      fromId: null,
      fromName: "Boss thế giới",
      kind: "boss",
      coins: share,
      text: `Bạn gây ${dmg} sát thương lên ${boss.emoji} ${boss.name} (chu kỳ ${boss.cycle}) — phần thưởng ${share} xu.`,
      createdAt: Date.now(),
      claimedAt: null,
    });
  }
  const killer = db.users.find((u) => u.id === killerId);
  db.chats.push({
    id: nextId("chat"),
    scope: "global",
    fromId: null,
    fromName: "📣 Cảng Online",
    text: `${boss.emoji} Boss thế giới "${boss.name}" (chu kỳ ${boss.cycle}) đã bị hạ${killer ? ` bởi đòn kết liễu của ${killer.displayName}` : ""}! Thưởng đã gửi vào hộp thư của mọi ngư dân tham gia.`,
    createdAt: Date.now(),
  });
}

function ensureWorldBoss() {
  if (!db.worldBoss) {
    db.worldBoss = spawnWorldBoss(1);
    saveDb();
  }
  return db.worldBoss;
}

function publicWorldBoss(boss, meId) {
  const today = dayKeyUtc();
  const myHit = boss.hits[meId];
  const hitsUsed = myHit && myHit.day === today ? myHit.count : 0;
  const top = Object.entries(boss.contributions)
    .filter(([, dmg]) => dmg > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([userId, dmg]) => {
      const user = db.users.find((u) => u.id === userId);
      return { userId, displayName: user?.displayName ?? userId, damage: dmg };
    });
  return {
    cycle: boss.cycle,
    name: boss.name,
    emoji: boss.emoji,
    maxHp: boss.maxHp,
    hp: boss.hp,
    totalDamage: boss.maxHp - boss.hp,
    myDamage: boss.contributions[meId] ?? 0,
    hitsLeft: Math.max(0, BOSS_HITS_PER_DAY - hitsUsed),
    hitsPerDay: BOSS_HITS_PER_DAY,
    top,
    spawnedAt: boss.spawnedAt,
  };
}

function publicInboxItem(item) {
  return {
    id: item.id,
    kind: item.kind,
    coins: item.coins,
    text: item.text,
    fromName: item.fromName,
    createdAt: item.createdAt,
    claimed: !!item.claimedAt,
  };
}

export async function handleApi(req, res) {
  await ensureDb();
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = req.method;

  if (method === "OPTIONS") return send(res, 204, {});
  try {
    if (path === "/api/health" && method === "GET") {
      return send(res, 200, { ok: true, name: "tham-hiem-dai-duong-online", users: db.users.length, teams: db.teams.length, time: new Date().toISOString() });
    }

    /* ---------------- Tài khoản ---------------- */
    if (path === "/api/auth/register" && method === "POST") {
      const ip = req.socket.remoteAddress ?? "ip";
      if (rateLimited(`register:${ip}`, 10, 60_000)) return send(res, 429, { error: "Thử lại sau ít phút." });
      const body = await readBody(req);
      const username = String(body.username ?? "").trim().toLowerCase();
      const password = String(body.password ?? "");
      const displayName = String(body.displayName ?? "").trim().slice(0, 40) || username;
      if (!/^[a-z0-9_.-]{3,24}$/.test(username)) return send(res, 400, { error: "Tên đăng nhập phải 3–24 ký tự: chữ thường, số, . _ -" });
      if (password.length < 6) return send(res, 400, { error: "Mật khẩu tối thiểu 6 ký tự." });
      if (db.users.some((u) => u.username === username)) return send(res, 409, { error: "Tên đăng nhập đã có người dùng." });
      const user = { id: nextId("u"), username, displayName, passwordHash: hashPassword(password), createdAt: Date.now() };
      db.users.push(user);
      const token = createSession(user.id);
      saveDb();
      return send(res, 201, { token, user: publicUser(user) });
    }

    if (path === "/api/auth/login" && method === "POST") {
      const ip = req.socket.remoteAddress ?? "ip";
      if (rateLimited(`login:${ip}`, 20, 60_000)) return send(res, 429, { error: "Đăng nhập quá nhiều lần, thử lại sau." });
      const body = await readBody(req);
      const username = String(body.username ?? "").trim().toLowerCase();
      const user = db.users.find((u) => u.username === username);
      if (!user || !verifyPassword(String(body.password ?? ""), user.passwordHash)) {
        return send(res, 401, { error: "Tên đăng nhập hoặc mật khẩu chưa đúng." });
      }
      const token = createSession(user.id);
      return send(res, 200, { token, user: publicUser(user), state: stateSummary(user.id) });
    }

    // Từ đây trở xuống cần đăng nhập
    const me = userFromRequest(req);
    const needAuth = () => {
      if (!me) send(res, 401, { error: "Chưa đăng nhập online hoặc phiên đã hết hạn." });
      return !!me;
    };

    if (path === "/api/auth/logout" && method === "POST") {
      if (!needAuth()) return;
      const header = req.headers.authorization || "";
      const tokenHash = createHash("sha256").update(header.slice(7)).digest("hex");
      db.sessions = db.sessions.filter((s) => s.tokenHash !== tokenHash);
      saveDb();
      return send(res, 200, { ok: true });
    }

    if (path === "/api/me" && method === "GET") {
      if (!needAuth()) return;
      const team = teamOf(me.id);
      return send(res, 200, { user: publicUser(me), state: stateSummary(me.id), team: team ? publicTeam(team) : null });
    }

    /* ---------------- Lưu trữ chơi tiếp ---------------- */
    if (path === "/api/me/state" && method === "GET") {
      if (!needAuth()) return;
      const state = db.states[me.id];
      if (!state) return send(res, 404, { error: "Tài khoản chưa có bản lưu online nào." });
      return send(res, 200, { bundle: state.bundle, summary: state.summary, version: state.version, updatedAt: state.updatedAt });
    }

    if (path === "/api/me/state" && method === "PUT") {
      if (!needAuth()) return;
      const body = await readBody(req);
      if (!body.bundle || typeof body.bundle !== "object") return send(res, 400, { error: "Thiếu dữ liệu bản lưu." });
      const existing = db.states[me.id];
      const baseVersion = Number(body.baseVersion) || 0;
      if (existing && baseVersion !== existing.version && !body.force) {
        return send(res, 409, {
          error: "Bản lưu online đã mới hơn (có thể bạn vừa chơi trên thiết bị khác).",
          version: existing.version,
          updatedAt: existing.updatedAt,
        });
      }
      const version = (existing?.version ?? 0) + 1;
      db.states[me.id] = {
        bundle: body.bundle,
        summary: body.summary && typeof body.summary === "object" ? body.summary : {},
        version,
        updatedAt: Date.now(),
      };
      saveDb();
      return send(res, 200, { ok: true, version, updatedAt: db.states[me.id].updatedAt });
    }

    /* ---------------- Tìm người chơi / bảng xếp hạng ---------------- */
    if (path === "/api/players/search" && method === "GET") {
      if (!needAuth()) return;
      const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();
      const limit = Math.min(30, Math.max(1, Number(url.searchParams.get("limit")) || 20));
      const results = db.users
        .filter((u) => u.id !== me.id)
        .filter((u) => !q || u.username.includes(q) || u.displayName.toLowerCase().includes(q))
        .map((u) => ({ ...publicProfile(u), relation: relationBetween(me.id, u.id) }))
        .sort((a, b) => b.xp - a.xp)
        .slice(0, limit);
      return send(res, 200, { results });
    }

    if (path === "/api/leaderboard" && method === "GET") {
      if (!needAuth()) return;
      const limit = Math.min(50, Math.max(1, Number(url.searchParams.get("limit")) || 20));
      const results = db.users.map((u) => publicProfile(u)).sort((a, b) => b.xp - a.xp || b.bestScore - a.bestScore).slice(0, limit);
      return send(res, 200, { results });
    }

    /* ---------------- Bạn bè ---------------- */
    if (path === "/api/friends" && method === "GET") {
      if (!needAuth()) return;
      const friends = [];
      const incoming = [];
      const outgoing = [];
      for (const r of db.friendRequests) {
        if (r.status === "accepted" && (r.fromId === me.id || r.toId === me.id)) {
          const other = db.users.find((u) => u.id === (r.fromId === me.id ? r.toId : r.fromId));
          if (other) friends.push(publicProfile(other));
        } else if (r.status === "pending" && r.toId === me.id) {
          const from = db.users.find((u) => u.id === r.fromId);
          if (from) incoming.push({ requestId: r.id, user: publicProfile(from), createdAt: r.createdAt });
        } else if (r.status === "pending" && r.fromId === me.id) {
          const to = db.users.find((u) => u.id === r.toId);
          if (to) outgoing.push({ requestId: r.id, user: publicProfile(to), createdAt: r.createdAt });
        }
      }
      return send(res, 200, { friends, incoming, outgoing });
    }

    if (path === "/api/friends/request" && method === "POST") {
      if (!needAuth()) return;
      const body = await readBody(req);
      const target = db.users.find((u) => u.id === body.toId || u.username === String(body.toUsername ?? "").toLowerCase());
      if (!target) return send(res, 404, { error: "Không tìm thấy người chơi đó." });
      if (target.id === me.id) return send(res, 400, { error: "Không thể kết bạn với chính mình." });
      const relation = relationBetween(me.id, target.id);
      if (relation === "friend") return send(res, 409, { error: "Đã là bạn bè rồi." });
      if (relation === "outgoing") return send(res, 409, { error: "Đã gửi lời mời rồi, đang chờ trả lời." });
      if (relation === "incoming") return send(res, 409, { error: "Người này đã mời bạn — hãy chấp nhận ở mục Lời mời." });
      const request = { id: nextId("fr"), fromId: me.id, toId: target.id, status: "pending", createdAt: Date.now() };
      db.friendRequests.push(request);
      saveDb();
      return send(res, 201, { ok: true, requestId: request.id });
    }

    if (path === "/api/friends/respond" && method === "POST") {
      if (!needAuth()) return;
      const body = await readBody(req);
      const request = db.friendRequests.find((r) => r.id === body.requestId && r.toId === me.id && r.status === "pending");
      if (!request) return send(res, 404, { error: "Không tìm thấy lời mời." });
      request.status = body.accept ? "accepted" : "declined";
      saveDb();
      return send(res, 200, { ok: true, status: request.status });
    }

    const unfriendMatch = path.match(/^\/api\/friends\/([^/]+)$/);
    if (unfriendMatch && method === "DELETE") {
      if (!needAuth()) return;
      const otherId = unfriendMatch[1];
      db.friendRequests = db.friendRequests.filter(
        (r) => !(r.status === "accepted" && ((r.fromId === me.id && r.toId === otherId) || (r.fromId === otherId && r.toId === me.id))),
      );
      saveDb();
      return send(res, 200, { ok: true });
    }

    /* ---------------- Tổ đội ---------------- */
    if (path === "/api/teams" && method === "GET") {
      if (!needAuth()) return;
      const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();
      const results = db.teams
        .filter((t) => !q || t.name.toLowerCase().includes(q))
        .map((t) => publicTeam(t))
        .sort((a, b) => b.score - a.score || b.totalXp - a.totalXp)
        .slice(0, 30);
      return send(res, 200, { results });
    }

    if (path === "/api/teams" && method === "POST") {
      if (!needAuth()) return;
      const body = await readBody(req);
      const name = String(body.name ?? "").trim().slice(0, 40);
      const desc = String(body.desc ?? "").trim().slice(0, 120);
      if (name.length < 3) return send(res, 400, { error: "Tên tổ đội tối thiểu 3 ký tự." });
      if (teamOf(me.id)) return send(res, 409, { error: "Bạn đang ở trong 1 tổ đội — hãy rời đội hiện tại trước." });
      if (db.teams.some((t) => t.name.toLowerCase() === name.toLowerCase())) return send(res, 409, { error: "Tên tổ đội đã có người dùng." });
      const team = { id: nextId("team"), name, desc, leaderId: me.id, createdAt: Date.now(), members: [{ userId: me.id, joinedAt: Date.now() }] };
      db.teams.push(team);
      saveDb();
      return send(res, 201, { ok: true, team: publicTeam(team) });
    }

    if (path === "/api/me/team" && method === "GET") {
      if (!needAuth()) return;
      const team = teamOf(me.id);
      return send(res, 200, { team: team ? publicTeam(team) : null });
    }

    const teamAction = path.match(/^\/api\/teams\/([^/]+)\/(join|leave|kick)$/);
    if (teamAction && method === "POST") {
      if (!needAuth()) return;
      const [, teamId, action] = teamAction;
      const team = db.teams.find((t) => t.id === teamId);
      if (!team) return send(res, 404, { error: "Không tìm thấy tổ đội." });
      if (action === "join") {
        if (teamOf(me.id)) return send(res, 409, { error: "Bạn đang ở trong 1 tổ đội — hãy rời đội hiện tại trước." });
        team.members.push({ userId: me.id, joinedAt: Date.now() });
        saveDb();
        return send(res, 200, { ok: true, team: publicTeam(team) });
      }
      if (action === "leave") {
        if (!team.members.some((m) => m.userId === me.id)) return send(res, 400, { error: "Bạn không ở trong tổ đội này." });
        team.members = team.members.filter((m) => m.userId !== me.id);
        if (team.members.length === 0) {
          db.teams = db.teams.filter((t) => t.id !== team.id);
          saveDb();
          return send(res, 200, { ok: true, disbanded: true });
        }
        if (team.leaderId === me.id) {
          team.leaderId = [...team.members].sort((a, b) => a.joinedAt - b.joinedAt)[0].userId;
        }
        saveDb();
        return send(res, 200, { ok: true, team: publicTeam(team) });
      }
      if (action === "kick") {
        if (team.leaderId !== me.id) return send(res, 403, { error: "Chỉ đội trưởng mới được mời thành viên ra khỏi đội." });
        const body = await readBody(req);
        const targetId = String(body.userId ?? "");
        if (targetId === me.id) return send(res, 400, { error: "Đội trưởng không thể tự kick mình — hãy dùng Rời đội." });
        team.members = team.members.filter((m) => m.userId !== targetId);
        saveDb();
        return send(res, 200, { ok: true, team: publicTeam(team) });
      }
    }

    const teamDetail = path.match(/^\/api\/teams\/([^/]+)$/);
    if (teamDetail && method === "GET") {
      if (!needAuth()) return;
      const team = db.teams.find((t) => t.id === teamDetail[1]);
      if (!team) return send(res, 404, { error: "Không tìm thấy tổ đội." });
      return send(res, 200, { team: publicTeam(team) });
    }

    /* ---------------- Đóng góp điểm tổ đội ---------------- */
    if (path === "/api/teams/contribute" && method === "POST") {
      if (!needAuth()) return;
      if (rateLimited(`contrib:${me.id}`, 60, 60_000)) return send(res, 429, { error: "Đóng góp quá nhanh, thử lại sau." });
      const body = await readBody(req);
      const points = Math.max(1, Math.min(50, Math.floor(Number(body.points) || 0)));
      if (!points) return send(res, 400, { error: "Điểm đóng góp không hợp lệ." });
      const team = teamOf(me.id);
      if (!team) return send(res, 400, { error: "Bạn chưa có tổ đội để đóng góp điểm." });
      team.score = (Number(team.score) || 0) + points;
      const member = team.members.find((m) => m.userId === me.id);
      if (member) member.contrib = (Number(member.contrib) || 0) + points;
      saveDb();
      return send(res, 200, { ok: true, score: team.score, myContrib: member?.contrib ?? 0 });
    }

    /* ---------------- Boss thế giới ---------------- */
    if (path === "/api/worldboss" && method === "GET") {
      if (!needAuth()) return;
      const boss = ensureWorldBoss();
      return send(res, 200, { boss: publicWorldBoss(boss, me.id) });
    }

    if (path === "/api/worldboss/hit" && method === "POST") {
      if (!needAuth()) return;
      if (rateLimited(`bosshit:${me.id}`, 30, 60_000)) return send(res, 429, { error: "Ra đòn quá nhanh, nghỉ tay một chút." });
      const boss = ensureWorldBoss();
      const today = dayKeyUtc();
      const myHit = boss.hits[me.id];
      const hitsUsed = myHit && myHit.day === today ? myHit.count : 0;
      if (hitsUsed >= BOSS_HITS_PER_DAY) {
        return send(res, 429, { error: `Bạn đã hết ${BOSS_HITS_PER_DAY} lượt đánh boss hôm nay — mai quay lại nhé.` });
      }
      const summary = db.states[me.id]?.summary ?? {};
      const level = Math.max(1, Number(summary.level) || 1);
      const damage = 25 + level * 4 + Math.floor(Math.random() * 21);
      boss.hits[me.id] = { day: today, count: hitsUsed + 1 };
      boss.contributions[me.id] = (boss.contributions[me.id] ?? 0) + damage;
      boss.hp = Math.max(0, boss.hp - damage);
      let killed = false;
      if (boss.hp <= 0) {
        killed = true;
        settleWorldBoss(boss, me.id);
        db.worldBoss = spawnWorldBoss(boss.cycle + 1);
      }
      saveDb();
      return send(res, 200, { ok: true, damage, killed, boss: publicWorldBoss(db.worldBoss, me.id) });
    }

    /* ---------------- Hộp thư & tặng quà ---------------- */
    if (path === "/api/inbox" && method === "GET") {
      if (!needAuth()) return;
      const items = db.inbox
        .filter((i) => i.toId === me.id)
        .sort((a, b) => Number(!!a.claimedAt) - Number(!!b.claimedAt) || b.createdAt - a.createdAt)
        .slice(0, 50)
        .map(publicInboxItem);
      return send(res, 200, { items, unclaimed: items.filter((i) => !i.claimed).length });
    }

    if (path === "/api/inbox/claim" && method === "POST") {
      if (!needAuth()) return;
      const body = await readBody(req);
      const item = db.inbox.find((i) => i.id === body.id && i.toId === me.id);
      if (!item) return send(res, 404, { error: "Không tìm thấy thư/quà này." });
      if (item.claimedAt) return send(res, 409, { error: "Mục này đã nhận rồi." });
      item.claimedAt = Date.now();
      saveDb();
      return send(res, 200, { ok: true, coins: item.coins });
    }

    if (path === "/api/friends/gift" && method === "POST") {
      if (!needAuth()) return;
      const body = await readBody(req);
      const target = db.users.find((u) => u.id === body.toId);
      if (!target) return send(res, 404, { error: "Không tìm thấy người chơi đó." });
      if (relationBetween(me.id, target.id) !== "friend") {
        return send(res, 400, { error: "Chỉ tặng quà được cho bạn bè đã kết bạn." });
      }
      const today = dayKeyUtc();
      db.giftLog = db.giftLog.filter((g) => g.day === today);
      if (db.giftLog.some((g) => g.fromId === me.id && g.toId === target.id)) {
        return send(res, 409, { error: "Hôm nay bạn đã tặng quà cho bạn này rồi — mai tặng tiếp nhé." });
      }
      db.giftLog.push({ fromId: me.id, toId: target.id, day: today });
      db.inbox.push({
        id: nextId("ib"),
        toId: target.id,
        fromId: me.id,
        fromName: me.displayName,
        kind: "gift",
        coins: 30,
        text: `${me.displayName} gửi tặng bạn 30 xu — chúc ra khơi may mắn! 🎁`,
        createdAt: Date.now(),
        claimedAt: null,
      });
      saveDb();
      return send(res, 201, { ok: true });
    }

    /* ---------------- Trò chuyện ---------------- */
    if (path === "/api/chat" && method === "GET") {
      if (!needAuth()) return;
      const scopeParam = url.searchParams.get("scope") === "team" ? "team" : "global";
      let scopeKey = "global";
      if (scopeParam === "team") {
        const team = teamOf(me.id);
        if (!team) return send(res, 200, { messages: [], scope: "team", teamName: null });
        scopeKey = `team:${team.id}`;
      }
      const messages = db.chats
        .filter((c) => c.scope === scopeKey)
        .slice(-50)
        .map((c) => ({
          id: c.id,
          fromName: c.fromName ?? db.users.find((u) => u.id === c.fromId)?.displayName ?? "Ngư dân",
          text: c.text,
          createdAt: c.createdAt,
          mine: c.fromId === me.id,
          system: !c.fromId,
        }));
      return send(res, 200, { messages, scope: scopeParam });
    }

    if (path === "/api/chat" && method === "POST") {
      if (!needAuth()) return;
      if (rateLimited(`chat:${me.id}`, 15, 30_000)) return send(res, 429, { error: "Bạn nhắn quá nhanh, chờ một chút." });
      const body = await readBody(req);
      const text = String(body.text ?? "").trim().slice(0, 200);
      if (!text) return send(res, 400, { error: "Tin nhắn trống." });
      let scopeKey = "global";
      if (body.scope === "team") {
        const team = teamOf(me.id);
        if (!team) return send(res, 400, { error: "Bạn chưa có tổ đội để chat đội." });
        scopeKey = `team:${team.id}`;
      }
      db.chats.push({ id: nextId("chat"), scope: scopeKey, fromId: me.id, fromName: me.displayName, text, createdAt: Date.now() });
      if (db.chats.length > 600) db.chats = db.chats.slice(-600);
      saveDb();
      return send(res, 201, { ok: true });
    }

    return send(res, 404, { error: "Đường dẫn không tồn tại." });
  } catch (error) {
    if (error.message === "too_large") return send(res, 413, { error: "Dữ liệu quá lớn." });
    if (error.message === "bad_json") return send(res, 400, { error: "Dữ liệu gửi lên không hợp lệ." });
    console.error(error);
    return send(res, 500, { error: "Máy chủ gặp lỗi, thử lại sau." });
  }
  if (dirty) await persist();
}

export { STORE_LABEL };
