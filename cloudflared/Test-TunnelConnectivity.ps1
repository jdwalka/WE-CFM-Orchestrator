# Test-TunnelConnectivity.ps1 — exit 0 when the standalone Mullvad SOCKS5 bridge
# can reach Binance through the API-provisioned wecrypto-mullvad WireGuard tunnel.
param(
    [string]$SocksUrl = $(if ($env:WECRYPTO_SWEDEN_SOCKS) { $env:WECRYPTO_SWEDEN_SOCKS } else { 'socks5://10.13.13.2:18090' }),
    [string]$DebugLog = ''
)

$repoRoot = Split-Path $PSScriptRoot -Parent
$probe = @"
const fs=require('fs');
const nf=require('node-fetch');
const {SocksProxyAgent}=require('socks-proxy-agent');
const net=require('net');
const logPath=process.env.DEBUG_LOG||'';
const log=(o)=>{if(!logPath)return;try{fs.appendFileSync(logPath,JSON.stringify({sessionId:'8ad9ce',runId:'tunnel-test',timestamp:Date.now(),...o})+'\n');}catch(_){}};
const TUN=process.env.MULLVAD_TUNNEL_LOCAL_ADDR||'10.65.50.149';
function tcpViaTunnel(){
  return new Promise((resolve)=>{
    const s=net.connect({host:'1.1.1.1',port:443,localAddress:TUN,timeout:8000},()=>{s.destroy();resolve({ok:true});});
    s.on('timeout',()=>{s.destroy();resolve({ok:false,error:'timeout'});});
    s.on('error',(e)=>resolve({ok:false,error:e.message,code:e.code}));
  });
}
(async()=>{
  const tcp=await tcpViaTunnel();
  log({hypothesisId:'I',location:'Test-TunnelConnectivity:tcp',message:'tunnel tcp probe',data:tcp});
  try{
    const agent=new SocksProxyAgent('$SocksUrl');
    const r=await nf('https://fapi.binance.com/fapi/v1/premiumIndex?symbol=BTCUSDT',{agent,timeout:15000});
    log({hypothesisId:'M',location:'Test-TunnelConnectivity:socks',message:'SOCKS egress OK',data:{status:r.status,socks:'$SocksUrl',tcp}});
    console.log('OK status='+r.status);
    process.exit(r.status===200?0:1);
  }catch(e){
    log({hypothesisId:'M',location:'Test-TunnelConnectivity:socks',message:'SOCKS egress fail',data:{error:e.message,socks:'$SocksUrl',tcp}});
    console.error('FAIL '+e.message);
    if(!tcp.ok){ console.error('WireGuard tunnel '+TUN+' cannot route (check wecrypto-mullvad handshake / AllowedIPs)'); }
    process.exit(1);
  }
})();
"@

Push-Location $repoRoot
try {
    $env:DEBUG_LOG = $DebugLog
    node -e $probe
    exit $LASTEXITCODE
} finally {
    Pop-Location
}
