$ErrorActionPreference = "Stop"
$env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"

Set-Location $PSScriptRoot\core
Write-Host "Building figcore.wasm (release, wasm32-unknown-unknown)..."
cargo build --target wasm32-unknown-unknown --release
Copy-Item -Force .\target\wasm32-unknown-unknown\release\figcore.wasm ..\web\figcore.wasm
$size = (Get-Item ..\web\figcore.wasm).Length
Write-Host ("Wrote web/figcore.wasm ({0:N1} KB)" -f ($size / 1KB))
