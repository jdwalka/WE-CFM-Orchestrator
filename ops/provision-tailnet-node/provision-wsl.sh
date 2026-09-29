# Tailnet node provisioning (mirrors maurotufgamingpro WSL setup)
# Run inside WSL Ubuntu on the target node (e.g. giulianlaptop-wsl).
# Needs: NO sudo. Uses user-local installs only.
set -e
export PATH="$HOME/.local/bin:$PATH"

echo "== 1. dirs =="
mkdir -p ~/.local/bin ~/GDrive ~/poker /tmp/opencode 2>/dev/null || true

echo "== 2. rclone (user-local) =="
if ! command -v rclone >/dev/null; then
  cd /tmp/opencode 2>/dev/null || { mkdir -p /tmp/opencode && cd /tmp/opencode; }
  rm -rf rclone-setup && mkdir rclone-setup && cd rclone-setup
  curl -sL -o rclone.zip https://downloads.rclone.org/rclone-current-linux-amd64.zip
  python3 -c "import zipfile; zipfile.ZipFile('rclone.zip').extractall('.')"
  cp rclone-*-linux-amd64/rclone ~/.local/bin/ && chmod +x ~/.local/bin/rclone
fi
rclone version | head -n 1

echo "== 3. python stack (bridge broker + truffle deps) =="
export PIP_BREAK_SYSTEM_PACKAGES=1
python3 -m pip install --user aiohttp "fastapi" "uvicorn[standard]" redis kafka-python httpx 2>&1 | tail -n 1

echo "== 4. shell defaults =="
grep -q 'wcopy()' ~/.bashrc || cat >> ~/.bashrc <<'EOF'

export PATH="$HOME/.local/bin:$PATH"
wcopy() { clip.exe; }
wpaste() { powershell.exe -NoProfile -Command "Get-Clipboard"; }
EOF
git config --global --add safe.directory /mnt/g/WECRYP 2>/dev/null || true
git config --global --add safe.directory /mnt/g/LeakSnipe 2>/dev/null || true

echo "== 5. repo links (adjust drive letters per node) =="
for pair in "WECRYP:/mnt/g/WECRYP" "LeakSnipe:/mnt/g/LeakSnipe" "GCP:/mnt/g/GCP"; do
  n="${pair%%:*}"; t="${pair##*:}"
  [ -e "$t" ] && ln -sfn "$t" "$HOME/$n" && echo "OK $n" || echo "SKIP $n (no $t)"
done

echo "== 6. start bridge broker + truffle bridge =="
pkill -f "[b]ridge_broker\.py" 2>/dev/null || true
setsid nohup python3 -u ~/WECRYP/truffle-bridge/bridge_broker.py > /tmp/bridge-broker.log 2>&1 < /dev/null &
sleep 2; head -n 1 /tmp/bridge-broker.log

echo "== MANUAL STEPS (interactive, run once) =="
echo "  rclone config create gdrive drive config_is_local=false   # then OAuth"
echo "  rclone mount gdrive: ~/GDrive --daemon --vfs-cache-mode minimal"
echo "  gcloud auth login  &&  gcloud config set project wecrypto"
echo "  opencode mcp auth cloudflare (+ bindings/builds/observability)"
echo "  agy mcp add leaksnipe-suite https://leaksnipe-suite.gitgoin87.workers.dev/mcp"
echo "== powershell (Windows side, admin optional) =="
echo "  tailscale serve --bg --set-path=/bridge http://127.0.0.1:8040"
echo "  tailscale serve --bg --set-path=/truffle http://127.0.0.1:8002"
echo "  G:\\WECRYP\\scripts\\truffle-loopback-bridge.ps1   # Win->WSL :8002"
