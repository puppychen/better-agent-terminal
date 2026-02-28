"use strict";var S=Object.create;var B=Object.defineProperty;var D=Object.getOwnPropertyDescriptor;var N=Object.getOwnPropertyNames;var j=Object.getPrototypeOf,L=Object.prototype.hasOwnProperty;var z=(i,t,e,n)=>{if(t&&typeof t=="object"||typeof t=="function")for(let a of N(t))!L.call(i,a)&&a!==e&&B(i,a,{get:()=>t[a],enumerable:!(n=D(t,a))||n.enumerable});return i};var f=(i,t,e)=>(e=i!=null?S(j(i)):{},z(t||!i||!i.__esModule?B(e,"default",{value:i,enumerable:!0}):e,i));const o=require("electron"),x=require("path"),R=require("child_process");class A{constructor(t){this.enabled=!1,this.syncTimer=null,this.moveHandler=null,this.resizeHandler=null,this.debouncedSync=()=>{this.syncTimer&&clearTimeout(this.syncTimer),this.syncTimer=setTimeout(()=>{this.syncTerminalPosition()},150)},this.win=t}isEnabled(){return this.enabled}enable(){this.enabled||(this.enabled=!0,this.positionSidebar(),this.syncTerminalPosition(),this.startListening())}disable(){this.enabled&&(this.enabled=!1,this.stopListening(),this.syncTimer&&(clearTimeout(this.syncTimer),this.syncTimer=null))}positionSidebar(){const t=this.win.getBounds(),n=o.screen.getDisplayMatching(t).workArea,a=Math.min(t.width,Math.floor(n.width*.35));this.win.setBounds({x:n.x,y:n.y,width:a,height:n.height})}getTerminalBounds(){const t=this.win.getBounds(),n=o.screen.getDisplayMatching(t).workArea,a=t.x+t.width,r=n.x+n.width-a;return{x:a,y:n.y,width:Math.max(r,400),height:n.height}}syncTerminalPosition(){if(!this.enabled||process.platform!=="darwin")return;const t=this.getTerminalBounds(),e=`
      tell application "Terminal"
        if not running then return
        if (count of windows) = 0 then return
        set bounds of front window to {${t.x}, ${t.y}, ${t.x+t.width}, ${t.y+t.height}}
      end tell
    `;R.exec(`osascript -e '${e.replace(/'/g,"'\\''")}'`,n=>{n&&console.error("Failed to sync Terminal position:",n.message)})}startListening(){this.moveHandler=this.debouncedSync,this.resizeHandler=this.debouncedSync,this.win.on("move",this.moveHandler),this.win.on("resize",this.resizeHandler)}stopListening(){this.moveHandler&&(this.win.removeListener("move",this.moveHandler),this.moveHandler=null),this.resizeHandler&&(this.win.removeListener("resize",this.resizeHandler),this.resizeHandler=null)}destroy(){this.disable()}}let h=null,s=null;const C=process.env.VITE_DEV_SERVER_URL,I="window-state.json";async function V(){const i=await import("fs/promises"),t=x.join(o.app.getPath("userData"),I);try{const e=await i.readFile(t,"utf-8");return JSON.parse(e)}catch{return null}}async function q(i){const t=await import("fs/promises"),e=x.join(o.app.getPath("userData"),I);await t.writeFile(e,JSON.stringify(i),"utf-8")}async function W(){const i=await V(),t=420,e=800;h=new o.BrowserWindow({width:(i==null?void 0:i.width)||t,height:(i==null?void 0:i.height)||e,x:i==null?void 0:i.x,y:i==null?void 0:i.y,minWidth:300,minHeight:400,maxWidth:600,webPreferences:{preload:x.join(__dirname,"preload.js"),nodeIntegration:!1,contextIsolation:!0},frame:!0,titleBarStyle:"default",title:"Better Agent"}),C?(h.loadURL(C),h.webContents.openDevTools()):h.loadFile(x.join(__dirname,"../dist/index.html")),h.on("close",()=>{if(h){const n=h.getBounds();q({x:n.x,y:n.y,width:n.width,height:n.height})}}),h.on("closed",()=>{s&&(s.destroy(),s=null),h=null}),s=new A(h)}o.app.whenReady().then(W);o.app.on("window-all-closed",()=>{process.platform!=="darwin"&&o.app.quit()});o.app.on("activate",()=>{o.BrowserWindow.getAllWindows().length===0&&W()});o.ipcMain.handle("dialog:select-folder",async()=>{const i=await o.dialog.showOpenDialog(h,{properties:["openDirectory"]});return i.canceled?null:i.filePaths[0]});o.ipcMain.handle("workspace:save",async(i,t)=>{const e=await import("fs/promises"),n=x.join(o.app.getPath("userData"),"workspaces.json");return await e.writeFile(n,t,"utf-8"),!0});o.ipcMain.handle("workspace:load",async()=>{const i=await import("fs/promises"),t=x.join(o.app.getPath("userData"),"workspaces.json");try{return await i.readFile(t,"utf-8")}catch{return null}});o.ipcMain.handle("shell:open-external",async(i,t)=>{await o.shell.openExternal(t)});o.ipcMain.handle("shell:open-path",async(i,t)=>{await o.shell.openPath(t)});o.ipcMain.handle("shell:open-with-app",async(i,t,e)=>{const{exec:n}=await import("child_process"),a=r=>{r&&console.error(`Failed to open ${t}:`,r.message)};process.platform==="darwin"?n(`open -a "${t}" "${e}"`,a):process.platform==="win32"?n(t==="Visual Studio Code"?`code "${e}"`:`"${t}" "${e}"`,a):n(`${t.toLowerCase().replace(/ /g,"")} "${e}"`,a)});async function m(i,t,e){const{exec:n}=await import("child_process");return new Promise(a=>{n(`osascript -e '${`
      tell application "Terminal"
        if not running then return ""
        set output to ""
        repeat with w in windows
          set winId to id of w
          set tabCount to count of tabs of w
          repeat with i from 1 to tabCount
            set t to tab i of w
            set tabTty to tty of t
            set output to output & (winId as string) & "," & (i as string) & "," & tabTty & linefeed
          end repeat
        end repeat
        return output
      end tell
    `.replace(/'/g,"'\\''")}'`,(c,d)=>{if(c||!d.trim()){a(!1);return}const l=d.trim().split(`
`).filter(Boolean),p=y=>{if(y>=l.length){a(!1);return}const[b,u,w]=l[y].split(","),T=`ps -t ${w.replace("/dev/","")} -o pid,comm 2>/dev/null | grep "${i}" | head -1 | awk '{print $1}' | xargs -I{} lsof -a -d cwd -p {} 2>/dev/null | awk 'NR==2 {print $NF}'`;n(T,($,g)=>{if((g==null?void 0:g.trim())===t)if((e==null?void 0:e.focus)!==!1){const F=e!=null&&e.updateTitle?e.updateTitle.replace(/"/g,'\\"'):"",E=e!=null&&e.updateTitle?`
                tell application "Terminal"
                  set w to window id ${b}
                  set frontmost of w to true
                  set selected of tab ${u} of w to true
                  set custom title of tab ${u} of w to "${F}"
                  set title displays custom title of tab ${u} of w to true
                  set title displays shell path of tab ${u} of w to false
                  set title displays window size of tab ${u} of w to false
                  set title displays device name of tab ${u} of w to false
                  set title displays file name of tab ${u} of w to false
                  activate
                end tell
              `:`
                tell application "Terminal"
                  set w to window id ${b}
                  set frontmost of w to true
                  set selected of tab ${u} of w to true
                  activate
                end tell
              `;n(`osascript -e '${E.replace(/'/g,"'\\''")}'`,()=>{a(!0)})}else a(!0);else p(y+1)})};p(0)})})}async function _(i,t){const{exec:e}=await import("child_process");return new Promise(n=>{e(`osascript -e '${`
      tell application "Terminal"
        if not running then return ""
        set output to ""
        repeat with w in windows
          set winId to id of w
          set tabCount to count of tabs of w
          repeat with i from 1 to tabCount
            set t to tab i of w
            set tabTty to tty of t
            set output to output & (winId as string) & "," & (i as string) & "," & tabTty & linefeed
          end repeat
        end repeat
        return output
      end tell
    `.replace(/'/g,"'\\''")}'`,(r,c)=>{if(r||!c.trim()){n(!1);return}const d=c.trim().split(`
`).filter(Boolean),l=p=>{if(p>=d.length){n(!1);return}const[y,b,u]=d[p].split(","),w=u.replace("/dev/",""),v=`ps -t ${w} -o pid,comm 2>/dev/null | grep -E "(bash|zsh)" | head -1 | awk '{print $1}' | xargs -I{} lsof -a -d cwd -p {} 2>/dev/null | awk 'NR==2 {print $NF}'`;e(v,(T,$)=>{if(($==null?void 0:$.trim())===i){const k=`ps -t ${w} -o comm 2>/dev/null | grep -E "(claude|happy)" | head -1`;e(k,(F,E)=>{if(E!=null&&E.trim())l(p+1);else{if((t==null?void 0:t.focus)===!1){n(!0);return}const P=`
                  tell application "Terminal"
                    set w to window id ${y}
                    set frontmost of w to true
                    set selected of tab ${b} of w to true
                    activate
                  end tell
                `;e(`osascript -e '${P.replace(/'/g,"'\\''")}'`,()=>{n(!0)})}})}else l(p+1)})};l(0)})})}async function H(i,t,e){const{exec:n}=await import("child_process"),a=i.replace(/"/g,'\\"'),r=t.replace(/"/g,'\\"');let c;if(e){const l=e.replace(/'/g,"'\\''");c=`printf '\\\\e]0;${r}\\\\a'; ${l}`}else c=`printf '\\\\e]0;${r}\\\\a'; clear`;const d=`tell application "Terminal"
    activate
    if (count of windows) > 0 then
      tell application "System Events" to keystroke "t" using command down
      delay 0.3
      do script "cd \\"${a}\\"" in front window
      delay 0.2
      do script "${c}" in front window
    else
      do script "cd \\"${a}\\""
      delay 0.2
      do script "${c}" in front window
    end if
  end tell`;n(`osascript -e '${d.replace(/'/g,"'\\''")}'`,l=>{l&&console.error("Failed to open Terminal:",l.message)})}o.ipcMain.handle("shell:open-terminal-at-path",async(i,t)=>{if(process.platform==="darwin"){const n=`[T] ${t.split("/").pop()||t}`;return await _(t)?(s!=null&&s.isEnabled()&&s.syncTerminalPosition(),{action:"focused"}):(await H(t,n),s!=null&&s.isEnabled()&&setTimeout(()=>s==null?void 0:s.syncTerminalPosition(),500),{action:"created"})}return{action:"unsupported"}});o.ipcMain.handle("shell:open-terminal-with-command",async(i,t,e)=>{if(process.platform==="darwin"){const n=t.split("/").pop()||t;let a=!1,r;return e.startsWith("claude")?(a=await m("claude",t),r=`[C] ${n}`):e.startsWith("happy")?(a=await m("happy",t),r=`[H] ${n}`):(a=await _(t),r=`[T] ${n}`),a?(s!=null&&s.isEnabled()&&s.syncTerminalPosition(),{action:"focused"}):(await H(t,r,e),s!=null&&s.isEnabled()&&setTimeout(()=>s==null?void 0:s.syncTerminalPosition(),500),{action:"created"})}return{action:"unsupported"}});o.ipcMain.handle("shell:check-agent-running",async(i,t)=>process.platform==="darwin"?await m("claude",t,{focus:!1})?{running:!0,type:"claude"}:await m("happy",t,{focus:!1})?{running:!0,type:"happy"}:{running:!1}:{running:!1});o.ipcMain.handle("shell:check-terminals",async(i,t)=>{if(process.platform==="darwin"){const[e,n,a]=await Promise.all([m("claude",t,{focus:!1}),m("happy",t,{focus:!1}),_(t,{focus:!1}).catch(()=>!1)]);return{claude:e,happy:n,terminal:a}}return{claude:!1,happy:!1,terminal:!1}});o.ipcMain.handle("shell:focus-agent",async(i,t,e)=>{if(process.platform==="darwin"){const n=t.split("/").pop()||t;let a;if(e==="claude"){const r=`[C] ${n}`;a=await m("claude",t,{focus:!0,updateTitle:r})}else{const r=`[H] ${n}`;a=await m("happy",t,{focus:!0,updateTitle:r})}return a&&(s!=null&&s.isEnabled())&&s.syncTerminalPosition(),a}return!1});o.ipcMain.handle("shell:focus-terminal-at-path",async(i,t)=>{if(process.platform==="darwin"){const e=await _(t);return e&&(s!=null&&s.isEnabled())&&s.syncTerminalPosition(),e}return!1});o.ipcMain.handle("shell:get-all-terminal-states",async()=>{if(process.platform!=="darwin")return[];const{exec:i}=await import("child_process"),t=(await import("os")).homedir();return new Promise(e=>{i(`osascript -e '${`
      tell application "Terminal"
        if not running then return ""
        set output to ""
        repeat with w in windows
          set winName to name of w
          set tabCount to count of tabs of w
          repeat with i from 1 to tabCount
            set t to tab i of w
            set tabTty to tty of t
            set tabBusy to busy of t
            set tabProcs to processes of t
            set procStr to ""
            repeat with p in tabProcs
              set procStr to procStr & (p as string) & "|"
            end repeat
            set output to output & tabTty & "\\t" & (tabBusy as string) & "\\t" & procStr & "\\t" & winName & linefeed
          end repeat
        end repeat
        return output
      end tell
    `.replace(/'/g,"'\\''")}'`,{timeout:5e3},(a,r)=>{if(a||!r.trim()){e([]);return}const c=r.trim().split(`
`).filter(Boolean),d=[];for(const l of c){const p=l.split("	");if(p.length<4)continue;const y=p[0].trim(),b=p[1].trim()==="true",u=p[2].split("|").map(g=>g.trim()).filter(Boolean),w=p.slice(3).join("	").trim(),v=w.indexOf(" — "),T=v>0?w.substring(0,v).trim():w.trim(),$=T.startsWith("~")?T.replace("~",t):T;d.push({tty:y,busy:b,processes:u,cwd:$})}e(d)})})});async function U(i){const{exec:t}=await import("child_process");return new Promise(e=>{const n=`cd "${i}" && echo "$(git rev-parse --abbrev-ref HEAD 2>/dev/null)" && echo "---" && git status --porcelain 2>/dev/null`;t(n,{timeout:5e3},(a,r)=>{if(a){e(null);return}const c=r.split(`---
`),d=(c[0]||"").trim();if(!d){e(null);return}const l=(c[1]||"").trim().length>0;e({branch:d,dirty:l})})})}o.ipcMain.handle("shell:get-git-info-batch",async(i,t)=>{if(!t||t.length===0)return{};const e={};for(const n of t)e[n]=await U(n);return e});o.ipcMain.handle("tiling:enable",()=>(s==null||s.enable(),!0));o.ipcMain.handle("tiling:disable",()=>(s==null||s.disable(),!0));o.ipcMain.handle("tiling:sync",()=>(s==null||s.syncTerminalPosition(),!0));o.ipcMain.handle("tiling:get-status",()=>({enabled:(s==null?void 0:s.isEnabled())??!1}));
