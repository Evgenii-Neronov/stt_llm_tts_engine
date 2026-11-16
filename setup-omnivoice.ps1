param([string]$Models = (Join-Path $PSScriptRoot '..\models'))
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Path $Models -Force | Out-Null
$root = (Resolve-Path $Models).Path
$venv = Join-Path $root 'omni-venv'
python -m venv $venv
if ($LASTEXITCODE) { exit $LASTEXITCODE }
$python = Join-Path $venv 'Scripts\python.exe'
& $python -m pip install --index-url https://download.pytorch.org/whl/cu128 'torch==2.9.1' 'torchaudio==2.9.1'
if ($LASTEXITCODE) { exit $LASTEXITCODE }
& $python -m pip install 'omnivoice==0.2.1' 'transformers==5.3.0' 'tokenizers==0.22.2' audioop-lts
if ($LASTEXITCODE) { exit $LASTEXITCODE }
& $python -c 'from huggingface_hub import snapshot_download; import sys; snapshot_download("k2-fsa/OmniVoice", local_dir=sys.argv[1], allow_patterns=["*.json","*.jinja","*.safetensors"])' (Join-Path $root 'omnivoice')
exit $LASTEXITCODE
