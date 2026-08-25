@echo off
cd /d G:\WECRYP
set WECRYPTO_DIRECT_PROXY=http://127.0.0.1:18080
set WECRYPTO_ASI1_PROXY=http://127.0.0.1:18080
start "WECRYPTO" cmd /k npx electron .
