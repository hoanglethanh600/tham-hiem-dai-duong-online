/*
 * Lớp lưu trữ cho máy chủ Thám Hiểm Đại Dương — 2 chế độ:
 *
 * 1) KV (khuyên dùng khi chạy trên Vercel): nếu có biến môi trường
 *    KV_REST_API_URL + KV_REST_API_TOKEN (Vercel KV / Upstash Redis cấp sẵn),
 *    toàn bộ dữ liệu nằm trong 1 key Redis "hocau_db" -> dữ liệu BỀN qua
 *    mọi lần khởi động lại của serverless.
 * 2) File JSON: khi chạy máy chủ thường trực (local/Render/VPS) dùng file
 *    data.json ghi atomic; trên Vercel mà chưa gắn KV thì rơi về /tmp
 *    (chỉ để demo — dữ liệu mất khi instance lạnh khởi động lại).
 */

import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const KV_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "";
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "";
export const KV_ENABLED = !!(KV_URL && KV_TOKEN);
const KV_KEY = "hocau_db";

const FILE_PATH =
  process.env.DATA_FILE ||
  (process.env.VERCEL ? "/tmp/hocau-data.json" : join(dirname(fileURLToPath(import.meta.url)), "data.json"));

export function emptyDb() {
  return { users: [], sessions: [], states: {}, friendRequests: [], teams: [], seq: 1 };
}

function normalize(parsed) {
  if (!parsed || typeof parsed !== "object") return emptyDb();
  return { ...emptyDb(), ...parsed };
}

export async function loadDb() {
  if (KV_ENABLED) {
    try {
      const response = await fetch(`${KV_URL}/get/${KV_KEY}`, {
        headers: { Authorization: `Bearer ${KV_TOKEN}` },
      });
      if (response.ok) {
        const data = await response.json();
        if (typeof data?.result === "string" && data.result) return normalize(JSON.parse(data.result));
        return emptyDb();
      }
    } catch (error) {
      console.error("KV load failed:", error);
    }
    return emptyDb();
  }
  try {
    if (existsSync(FILE_PATH)) return normalize(JSON.parse(readFileSync(FILE_PATH, "utf8")));
  } catch {
    /* file hỏng -> db trống */
  }
  return emptyDb();
}

export async function saveDb(db) {
  if (KV_ENABLED) {
    const response = await fetch(`${KV_URL}/set/${KV_KEY}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${KV_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(db),
    });
    if (!response.ok) throw new Error(`KV save failed: ${response.status}`);
    return;
  }
  mkdirSync(dirname(FILE_PATH), { recursive: true });
  const tmp = `${FILE_PATH}.tmp`;
  writeFileSync(tmp, JSON.stringify(db));
  renameSync(tmp, FILE_PATH);
}

export const STORE_LABEL = KV_ENABLED ? "Vercel KV (Upstash)" : `file ${FILE_PATH}`;
