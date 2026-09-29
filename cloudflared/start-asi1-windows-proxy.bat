@echo off
cd /d G:\wecryp\cloudflared
start "ASI1 proxy" /MIN "C:\Program Files\nodejs\node.exe" "G:\wecryp\cloudflared\asi1-windows-proxy.js"
