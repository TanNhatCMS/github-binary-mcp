# github-binary-mcp

MCP server riêng (stdio, Node zero-dependency) để push file nhị phân lên
GitHub — vá đúng chỗ tool GitHub chính thức thiếu: tool gốc chỉ nhận text
và tự base64, nên ảnh gửi qua đó thành chuỗi base64 chứ không phải ảnh.
Server này nhận `content_base64` và chuyển nguyên văn cho GitHub API.

## Tools

- `push_binary_file` — 1 file nhị phân (Contents API).
- `push_binary_files` — tối đa 20 file trong 1 commit (Git Data API).
- `get_binary_file` — đọc file về dạng base64.
- `delete_file` — xoá file trong phạm vi cho phép.

## Cơ chế bảo mật (fail-closed)

- Token GitHub chỉ lấy từ env `GITHUB_TOKEN`. Không log, không trả về
  trong kết quả tool, không xuất hiện trong thông báo lỗi.
- Allowlist repo `GITHUB_BINARY_ALLOWED_REPOS` (dạng `owner/repo`, cách nhau
  bằng dấu phẩy). Không đặt biến này = từ chối mọi push.
- Allowlist đường dẫn `GITHUB_BINARY_ALLOWED_PATHS` (mặc định:
  `assets/,public/,docs/,static/,images/`). File ngoài các tiền tố này bị từ chối.
- Denylist luôn thắng: `.github/workflows/`, `.git/`, `*.env*`, `*.pem`,
  `*.key`, tên chứa `credentials` hoặc `secret`. Chặn leo thư mục `..`.
- Chặn file thực thi: exe, dll, so, dylib, bat, com, scr, msi, appimage, deb, rpm.
- Base64 phải hợp lệ và round-trip đúng, nếu không từ chối trước khi gọi API.
- Audit log: 1 dòng JSON mỗi lần gọi (tool, repo, path, size, sha, ok/error),
  ra stderr. Không ghi content, không ghi token.

## Giới hạn

- 10 MB mỗi file (sau giải mã), 50 MB mỗi commit nhiều file, tối đa 20 file/commit.
- 30 lần ghi/xoá mỗi giờ (rolling window, theo process). Đọc không giới hạn.
- Không bypass branch protection: nếu nhánh bị bảo vệ, GitHub API tự từ chối.

## Chạy và kiểm thử

```sh
GITHUB_BINARY_MOCK=1 node test.mjs   # 14/14 pass, không chạm mạng
GITHUB_TOKEN=... GITHUB_BINARY_ALLOWED_REPOS=TanNhatCMS/dia-nguc-live node server.mjs
```

Mock mode (`GITHUB_BINARY_MOCK=1`) luôn thắng và mọi kết quả đều gắn
`mock:true`, không bao giờ nhầm thành push thật.

## Triển khai lên gateway (chưa làm — cần chốt)

1. Tạo token GitHub cho server này (fine-grained, chỉ các repo trong allowlist,
   quyền Contents: Read and write).
2. Đặt server lên flex (STDIO) hoặc đóng gói chạy HTTP, đăng ký vào MetaMCP
   gateway, gắn vào namespace Public với tool policy allowlist.
3. Kiểm thử push thật lên 1 repo thử trước khi mở allowlist cho repo chính.

Trạng thái hiện tại: code + test mock xong, đã push lên GitHub tại
https://github.com/TanNhatCMS/github-binary-mcp. Chưa triển khai lên flex,
chưa có token thật, chưa kiểm thử push thật.
