@echo off
cd /d G:\WECRYP
echo Testing electron...
call npx electron --version
if errorlevel 1 (
  echo npx failed, trying direct...
  node node_modules\electron\cli.js --version
)
echo.
echo Testing module resolve...
node -e "console.log(require('electron'))"
echo.
echo Launch smoke: start main briefly is GUI - just verify CLI works
echo OK if version printed above
