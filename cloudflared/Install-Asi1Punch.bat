@echo off
cd /d C:\Users\gitgo
REM ASI1 Ethernet punch ONLY on the LAN NIC. Never on Tailscale (100.x) — that is Sweden RouteAll.
for /f "tokens=1" %%I in ('powershell -NoProfile -Command "(Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -eq '192.168.18.38' }).InterfaceIndex"') do set IF=%%I
if not defined IF set IF=17
route delete 34.149.190.89 >nul 2>&1
route -p add 34.149.190.89 mask 255.255.255.255 192.168.18.1 metric 5 if %IF%
