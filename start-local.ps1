param([string]$Models = (Join-Path $PSScriptRoot '..\models'))
$ErrorActionPreference = 'Stop'
$modelsPath = (Resolve-Path $Models).Path
$recognizer = Join-Path $modelsPath 'sherpa-onnx-streaming-t-one-russian-2025-09-08'
$voice = Join-Path $modelsPath 'ru_RU-dmitri-medium.onnx'
$weights = Join-Path $modelsPath 'qwen3-1.7b-q4_k_m.gguf'
$llama = Join-Path $modelsPath 'llama\llama-server.exe'
foreach ($path in @($recognizer,$voice,$weights,$llama)) {
    if (!(Test-Path -LiteralPath $path)) { throw "Missing local dependency: $path" }
}
$env:VOICELAB_STT_MODEL = $recognizer
$deps = Join-Path $modelsPath 'deps'
if (Test-Path -LiteralPath $deps) { $env:PYTHONPATH = $deps }
function Test-Port([int]$Port) {
    $client = [Net.Sockets.TcpClient]::new()
    try { $client.Connect('127.0.0.1',$Port); return $true }
    catch { return $false }
    finally { $client.Dispose() }
}
function Wait-Endpoint([int]$Port, [Diagnostics.Process]$Process) {
    $deadline = (Get-Date).AddMinutes(2)
    while (!(Test-Port $Port)) {
        if ($Process.HasExited -or (Get-Date) -ge $deadline) {
            throw "Local engine did not start on $Port"
        }
        Start-Sleep -Milliseconds 250
    }
}
$children = @()
Push-Location $PSScriptRoot
try {
    if (!(Test-Port 8080)) {
        $process = Start-Process -FilePath $llama -ArgumentList @('-m',('"{0}"' -f $weights),
            '--alias','qwen3-1.7b','--host','127.0.0.1','--port','8080','-ngl','99','-c','4096','-np','1','--jinja') -PassThru -WindowStyle Hidden
        $children += $process
        Wait-Endpoint 8080 $process
        $warm = @{ model='qwen3-1.7b'; messages=@(@{role='user';content='Say hello.'});
            max_tokens=4; chat_template_kwargs=@{enable_thinking=$false} } | ConvertTo-Json -Depth 6
        Invoke-RestMethod -Uri 'http://127.0.0.1:8080/v1/chat/completions' -TimeoutSec 120 -Method Post -ContentType 'application/json' -Body $warm | Out-Null
    }
    if (!(Test-Port 5193)) {
        $process = Start-Process -FilePath (Get-Command python).Source -ArgumentList @('-u','piper_pcm.py',('"{0}"' -f $voice)) -PassThru -WindowStyle Hidden
        $children += $process
        Wait-Endpoint 5193 $process
    }
    $omniModel = Join-Path $modelsPath 'omnivoice'
    $omniPython = Join-Path $modelsPath 'omni-venv\Scripts\python.exe'
    $omniPackages = Join-Path $modelsPath 'omni-app'
    $omniTorch = Join-Path $modelsPath 'omni-deps'
    if (!(Test-Port 5194) -and (Test-Path (Join-Path $omniModel 'model.safetensors')) -and
        ((Test-Path $omniPython) -or ((Test-Path $omniPackages) -and (Test-Path $omniTorch)))) {
        $oldPythonPath = $env:PYTHONPATH
        if (!(Test-Path $omniPython)) {
            $omniPython = (Get-Command python).Source
            $compat = Join-Path $modelsPath 'omni-compat'
            $env:PYTHONPATH = "$compat;$omniPackages;$omniTorch"
        } else {
            $env:PYTHONPATH = ''
        }
        try {
            $profiles = Join-Path $modelsPath 'voice-profiles'
            $process = Start-Process -FilePath $omniPython -ArgumentList @('-u','omnivoice_pcm.py',
                '--model',('"{0}"' -f $omniModel),'--voices',('"{0}"' -f $profiles)) -PassThru -WindowStyle Hidden
            $children += $process
        }
        finally { $env:PYTHONPATH = $oldPythonPath }
        Wait-Endpoint 5194 $process
    }
    dotnet run
}
finally {
    foreach ($process in $children) {
        if (!$process.HasExited) { Stop-Process -Id $process.Id }
    }
    Pop-Location
}
