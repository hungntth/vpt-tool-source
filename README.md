# Flash Game Player

Ứng dụng Electron để chạy Flash Game sử dụng Flash Player.

## Cài đặt

1. Cài đặt Node.js (nếu chưa có)
2. Cài đặt dependencies:
```bash
npm install
```

## Chạy ứng dụng

```bash
npm start
```

## Cấu trúc dự án

- `main.js` - File chính của Electron, xử lý việc mở Flash Player
- `index.html` - Giao diện của ứng dụng
- `flash.exe` - Flash Player executable
- `package.json` - Cấu hình dự án và dependencies

## Lưu ý

- Đảm bảo file `flash.exe` có trong thư mục dự án
- Flash Player sẽ mở trong cửa sổ riêng khi ứng dụng khởi động
- URL game được cấu hình trong file `main.js`

# vpt-tool-source
