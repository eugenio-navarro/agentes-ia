# Cierra la app de escritorio de Claude y la vuelve a abrir, para que la barra lateral cargue los
# chats importados por el script de chats (la app solo lee su indice al arrancar).
#
# - Solo cierra la app y las sesiones que ella lanzo. No toca las sesiones de Claude Code de
#   VS Code ni de la terminal, aunque su proceso tambien se llame claude.exe.
# - Con la app cerrada, sincroniza los chats pendientes y recien despues la abre.
# - OJO: corta las sesiones que esten trabajando dentro de la app.
#
# Uso: powershell -ExecutionPolicy Bypass -File extra\reiniciar_claude.ps1 [-Simular]
#   -Simular  muestra que procesos cerraria y que abriria, sin hacer nada.
# (Archivo en ASCII a proposito: Windows PowerShell 5.1 lee mal los acentos sin BOM.)
param([switch]$Simular)

function Get-ProcesosDeLaApp {
    Get-CimInstance Win32_Process -Filter "Name='claude.exe'" | Where-Object {
        $_.ExecutablePath -like '*\WindowsApps\Claude_*' -or          # app instalada desde la Store
        $_.ExecutablePath -like '*\AppData\Local\AnthropicClaude\*' -or # app instalada con el instalador
        $_.ExecutablePath -like '*\AppData\Roaming\Claude\claude-code\*' # sesiones que lanzo la app
    }
}

$appId = (Get-StartApps | Where-Object { $_.Name -eq 'Claude' } |
    Sort-Object { $_.AppID -notlike 'Claude_*' } | Select-Object -First 1).AppID
if (-not $appId) { Write-Host 'No encontre la app de Claude instalada.'; exit 1 }

$procesos = @(Get-ProcesosDeLaApp)
$otros = @(Get-CimInstance Win32_Process -Filter "Name='claude.exe'").Count - $procesos.Count
Write-Host "Procesos de la app a cerrar: $($procesos.Count). Sesiones de VS Code/terminal que no se tocan: $otros."
Write-Host "App a abrir: $appId"
if ($Simular) { Write-Host 'Simulacion: no se cerro ni se abrio nada.'; exit 0 }

foreach ($p in $procesos) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
for ($i = 0; $i -lt 20 -and @(Get-ProcesosDeLaApp).Count -gt 0; $i++) { Start-Sleep -Milliseconds 500 }

$sync = Get-ChildItem "$env:USERPROFILE\.claude\chats-claude\configuraci*_chats_claude_code_app.py" -ErrorAction SilentlyContinue |
    Select-Object -First 1
if ($sync) {
    Write-Host 'Sincronizando chats...'
    & python $sync.FullName sincronizar
}

Start-Process "shell:AppsFolder\$appId"
Write-Host 'Claude reabierto.'
Start-Sleep -Seconds 2
