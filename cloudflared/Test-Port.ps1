# Test-Port.ps1 — exit 0 if the given TCP port is accepting connections on
# 127.0.0.1, exit 1 otherwise. Used by launch.bat's Mullvad SOCKS5 bridge
# gate; kept in its own file (rather than inlined via `powershell -Command`)
# because inline commands with parens/braces are unreliable when called from
# inside a nested batch for/if block.
param(
    [Parameter(Mandatory = $true)]
    [int]$Port
)
if (Test-NetConnection -ComputerName 127.0.0.1 -Port $Port -InformationLevel Quiet -WarningAction SilentlyContinue) {
    exit 0
} else {
    exit 1
}
