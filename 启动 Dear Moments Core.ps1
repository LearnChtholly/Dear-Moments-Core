$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
if (-not (Test-Path (Join-Path $PSScriptRoot "server.mjs"))) {
  Write-Host "[ERROR] Please extract the whole ZIP first. Do not run this file inside the ZIP preview." -ForegroundColor Red
  Read-Host "Press Enter to exit"
  exit 1
}
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Host "[ERROR] Node.js was not found. Please install Node.js 22 or newer." -ForegroundColor Red
  Read-Host "Press Enter to exit"
  exit 1
}
& $node.Source (Join-Path $PSScriptRoot "server.mjs")
