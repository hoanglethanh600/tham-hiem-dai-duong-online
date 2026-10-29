/*
 * Điểm vào serverless cho Vercel: mọi đường /api/* được vercel.json
 * chuyển về hàm này; logic dùng chung ở core.mjs (thư mục gốc).
 */
import { handleApi } from "../core.mjs";

export default async function handler(req, res) {
  try {
    await handleApi(req, res);
  } catch (error) {
    console.error(error);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "Máy chủ gặp lỗi, thử lại sau." }));
    }
  }
}
