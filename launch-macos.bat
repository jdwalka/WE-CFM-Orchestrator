@echo off
echo ===================================================
echo   Starting macOS Sonoma VM (OSX-KVM on WSL2)
echo ===================================================
echo.
wsl.exe bash -c "sudo chmod 666 /dev/kvm 2>/dev/null; /home/mar/OSX-KVM/launch-macos.sh"
pause
