# Thám Hiểm Đại Dương — bản chơi online trên Vercel

- **Chơi game ngay:** mở trang gốc `/` của trang này (file `index.html` là
  toàn bộ game đóng gói 1 file — bản v13: có Gói VIP + mã kích hoạt,
  thời tiết & thủy triều, bạn đồng hành, chợ giao dịch, giải đấu mùa).
- **Máy chủ online:** các đường `/api/*` chạy qua `api/index.mjs`
  (đăng ký/đăng nhập, đồng bộ bản lưu, bạn bè, tổ đội, boss thế giới,
  chat) — dữ liệu bền trong Upstash KV. Kiểm tra: `/api/health`.
- Game tự điền sẵn địa chỉ máy chủ này trong mục "Online & tổ đội".

© 2026 By Hoàng Kim Long - Email: tonyhoang.oliver@gmail.com
