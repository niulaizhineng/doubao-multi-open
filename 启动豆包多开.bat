@echo off
chcp 65001 >nul
title 豆包多开管理器 v3
REM 关键:清掉可能让 Electron 变成纯 Node 模式的遗留变量(DSH 等环境会设置它)
set "ELECTRON_RUN_AS_NODE="
set "ELECTRON_NO_ATTACH_CONSOLE="
cd /d "%~dp0"
if not exist "node_modules\electron\dist\electron.exe" (
  echo [提示] 尚未安装依赖,正在执行 npm install ...
  call npm install
)
REM 注意: "%~dp0." 结尾的点可防止 \ 被解析成转义引号(经典 cmd 坑)
start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0."
exit
