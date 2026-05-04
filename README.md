# Better Agent Workspace

Better Agent Workspace 是一個 macOS-first 的 Electron 工作台，用來在同一個視窗中管理多個專案工作區、一般 shell、Claude Code、Codex、檔案編輯與本機通知。

目前程式碼已不再是舊版 Windows terminal aggregator；本 README 依目前工作區實作更新。

## 功能總覽

- 多工作區管理：每個 workspace 對應一個專案資料夾。
- 多終端分頁：同一 workspace 可同時開一般 shell、Claude agent、Codex agent。
- Claude / Codex 啟動：可從 UI 建立 agent terminal，並保持背景 session 持續運行。
- Claude session 追蹤：讀取 `~/.claude/projects/<encoded-cwd>/sessions-index.json`，協助對應 Claude session label。
- 通知 hook：提供本機 notify server，並可安裝 Claude / Codex stop hook。
- WebSocket remote control：可選擇啟用本機 WebSocket server，供外部工具訂閱輸出或送入文字。
- Git 狀態：切換 workspace 或視窗 focus 時刷新 Git / subrepo 資訊。
- Files 分頁：內建檔案樹、CodeMirror 編輯器、mtime 衝突檢查、Markdown preview。

## 技術架構

```text
better-agent/
├── electron/
│   ├── main.ts                    # Electron main process，集中管理 IPC / 視窗 / hook / WS / notify
│   ├── preload.ts                 # contextBridge 暴露 renderer 可用 API
│   ├── pty-manager.ts             # PTY / shell process 管理
│   ├── notify-server.ts           # 127.0.0.1 notify HTTP endpoint
│   ├── ws-server.ts               # WebSocket server 與 remote control
│   ├── file-system.ts             # workspace 內檔案讀寫與安全檢查
│   ├── git-status.ts              # git status 查詢
│   └── claude-sessions.ts         # Claude session index 讀取與 watch
├── src/
│   ├── App.tsx                    # renderer 主要流程與 agent 建立邏輯
│   ├── components/
│   │   ├── MainPanel.tsx          # workspace 主畫面與 terminal / files 切換
│   │   ├── TerminalPanel.tsx      # xterm.js terminal renderer
│   │   ├── Sidebar.tsx            # workspace / agent / WS 狀態側欄
│   │   ├── FilesTab.tsx           # 檔案樹、CodeMirror、Markdown preview
│   │   ├── files-editor-runtime.ts
│   │   └── files-markdown-runtime.ts
│   ├── stores/                    # workspace / terminal / settings state
│   └── styles/main.css
├── package.json
└── README.md
```

主要技術：

- Electron 28
- React 18 + TypeScript
- Vite 5
- xterm.js
- optional `node-pty`
- CodeMirror 6
- markdown-it
- ws

## 執行與建置

```bash
npm install
npm run compile
npm start
```

完整 PTY 體驗需要 native `node-pty` 可用。`node-pty` 目前列在 `optionalDependencies`，安裝後若 Electron native module 不相容，需要手動 rebuild：

```bash
npx @electron/rebuild -f -w node-pty
```

若 `node-pty` 載入失敗，程式會 fallback 到 `child_process` pipe。fallback 可以執行基本 shell，但不是完整 pseudo-terminal，互動式 CLI 的行為可能和真實終端不同。

## Agent 啟動與通知

Claude agent 預設啟動指令：

```bash
claude -c --permission-mode bypassPermissions
```

Codex agent 預設啟動指令：

```bash
codex resume --last -c approval_policy=never -c sandbox_mode=workspace-write || codex -s workspace-write -a never
```

通知機制由本機 notify server 接收 hook 呼叫：

- 監聽 `127.0.0.1`
- token 檔案位於 `~/.claude/better-agent/notify-auth.txt`
- 設定檔位於 `~/.claude/better-agent/notify-settings.json`
- hook script 位於 `~/.claude/hooks/better-agent-notify.sh`
- Claude hook 合併到 `~/.claude/settings.json`
- Codex hook 合併到 `~/.codex/config.toml` 與 `~/.codex/hooks.json`

Codex Stop hook 的目的，是在 Codex 任務自然結束時送出通知。若直接從外部 kill process，通常不等於 Codex 自己觸發 Stop hook。

## WebSocket Remote Control

WebSocket server 預設關閉，需從 UI 啟用。啟用後會使用：

- token 驗證
- client 數量上限
- 每分鐘訊息與 input rate limit
- heartbeat ping
- 訂閱數與 input 長度限制

WS 設定檔位於：

```text
~/.claude/better-agent/ws-settings.json
```

WS token 位於：

```text
~/.claude/better-agent/ws-auth.json
```

## Files 與 Markdown Preview

Files 分頁提供 workspace 內的檔案瀏覽、編輯與 Markdown preview。

檔案讀寫的主要保護：

- 所有檔案路徑都會 resolve 在 workspace root 底下，避免 path traversal。
- 單檔讀取上限為 5MB。
- 會偵測 binary 檔案並拒絕用文字模式開啟。
- 儲存時會帶入 mtime，若磁碟上的檔案已被其他程序修改，會回報衝突。
- 最多同時開 10 個檔案，避免 CodeMirror view 無限制累積。

### Markdown preview 現況

Markdown preview 的實作位置：

- `src/components/FilesTab.tsx`
- `src/components/files-markdown-runtime.ts`

目前流程：

1. 只有切到 preview 模式且該 preview active 時才載入 markdown runtime。
2. `files-markdown-runtime.ts` 透過 dynamic import 載入 `markdown-it` 與 `markdown-it-inject-linenumbers`。
3. `markdown-it` 會把 Markdown 轉成 HTML 字串。
4. `markdown-it-inject-linenumbers` 會在 block element 加上 `data-source-line`，供 Edit / Preview 雙向行級捲動同步。
5. `FilesTab.tsx` 最後用 React `dangerouslySetInnerHTML` 將 HTML 字串放進 `.markdown-body`。

目前已做的安全限制：

- `html: false`：Markdown 內直接撰寫的 raw HTML 不會被當成 HTML 執行。
- `linkify: false`：純文字 URL 不會自動變成連結。
- `typographer: false`、`breaks: false`：避免額外文字轉換造成不可預期輸出。
- 點擊連結時，只有 `http://` 與 `https://` 會交給 Electron `shell.openExternal`。
- `#anchor` 只會在 preview container 內部捲動。
- 其他 scheme，例如 `file:`, `javascript:`, `data:`，點擊時不會被程式主動開啟。

### Markdown preview 問題與殘餘風險

Markdown preview 仍然是一個需要被視為安全邊界的區域，原因是它最後使用 `dangerouslySetInnerHTML`。目前 `html: false` 已降低 raw HTML XSS 風險，但安全性仍依賴 `markdown-it`、外掛與 renderer 規則都維持目前設定。

需要注意的情況：

- 若未來開啟 `html: true`，Markdown 檔案中的 HTML 會進入 DOM，必須先加入 sanitizer，例如 DOMPurify，並重新審查 Electron renderer 安全設定。
- 若未來新增 markdown-it plugin 或自訂 renderer，外掛產生的 HTML 也會經由 `dangerouslySetInnerHTML` 進入 DOM，需要逐一確認是否會產生不可信 attribute、scriptable URL 或 inline event handler。
- Markdown image 語法可能產生 `<img src="...">`。即使點擊連結有 scheme 限制，圖片載入仍可能對外發送請求，造成隱私、追蹤或效能問題。
- 目前渲染是同步的。`setTimeout(0)` 只是在開始渲染前讓出一拍，真正 `markdown-it.render()` 執行時仍會佔用 renderer main thread。大型 Markdown 檔案可能造成 preview 瞬間卡頓。
- 行號同步依賴 `markdown-it-inject-linenumbers` 產生的 `data-source-line`。若外掛更新或輸出結構改變，Edit / Preview 捲動同步可能失準。
- Preview 顯示的是切換到 preview 時抓取的 editor snapshot。這符合目前「編輯 / 預覽切換」模式，但不是即時 side-by-side live preview。

建議改善方向：

1. 保持 `html: false`，除非有明確需求。
2. 若必須支援 raw HTML，先加入 sanitizer，再允許 `dangerouslySetInnerHTML`。
3. 對 `<img>` 加入載入策略或 remote image policy，避免不必要的外部請求。
4. 對大型 Markdown 增加 size threshold、loading state，或改用 worker / incremental render。
5. 將 Markdown preview 的安全假設寫入測試，避免未來設定被改動後未察覺。

## 效能特性

目前程式碼中已有幾個降低閒置與渲染成本的設計：

- Terminal output 使用 `requestAnimationFrame` batching。
- 視窗 blur 時不主動排 terminal write frame，降低背景渲染成本。
- WebGL terminal renderer 有 LRU 上限。
- FilesTab、CodeMirror language support、Markdown runtime 採 lazy loading。
- Git 狀態不是高頻 polling，主要在 workspace 切換或視窗 focus 時更新。
- WS 預設關閉；啟用時才有 heartbeat 與 client rate counter。

可能持續佔用資源的來源：

- 開啟的 terminal 越多，PTY buffer、xterm scrollback、renderer instance 會線性增加。
- 所有 terminal panel 會保持 mounted，以換取 session 視覺狀態不重建。
- Claude session watcher 在目標目錄尚不存在時會用短週期輪詢等待目錄出現。
- WS 啟用後，即使無輸出，也會有 heartbeat timer。

## 開發指令

```bash
# 編譯 renderer + Electron main/preload
npm run compile

# 啟動 Electron app
npm start

# 建置發行檔
npm run build

# build release version
npm run build:release
```

目前 `package.json` 沒有測試腳本。若要提高回歸保護，建議補上：

- IPC contract tests
- file-system path safety tests
- notify hook merge tests
- WS auth / rate limit tests
- Markdown preview sanitizer / protocol policy tests

## 已知維護重點

- `electron/main.ts` 責任較集中，後續可拆分為 notify、hook、terminal discovery、git、settings 等模組。
- 部分 main process shell 操作仍使用 `exec` 字串組合，後續應優先改成 `execFile` / `spawn` 參數陣列與 allowlist。
- README 應隨功能演進同步更新，避免再次落後於實際程式碼。
