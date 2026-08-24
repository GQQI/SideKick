#Requires -Version 5.1
<#
.SYNOPSIS
  Build a fully offline Windows installer (NSIS .exe) and portable zip.

.DESCRIPTION
  Run on an online build PC. The output Setup.exe can be copied to an air-gapped
  machine and installed without Python, Node, or internet.

  Bundles: Electron shell + embeddable CPython + pip packages + Playwright Chromium
  + built UI + application source.

.PARAMETER SkipRuntime
  Reuse packaging/windows/payload/python if it already imports fastapi.

.PARAMETER SkipUi
  Reuse existing ui/dist instead of running npm run build.

.PARAMETER SkipPlaywright
  Do not download Chromium (agent browser_* tools will not work offline).

.PARAMETER Force
  Rebuild the bundled Python runtime even if it already exists.
#>
param(
  [switch]$SkipRuntime,
  [switch]$SkipUi,
  [switch]$SkipPlaywright,
  [switch]$Force
)

$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
# Native tools (python/pip/npm) write warnings to stderr. Windows PowerShell 5.1
# treats that as a terminating error when ErrorActionPreference=Stop.
$ErrorActionPreference = "Continue"
$PackDir = Join-Path $RepoRoot "packaging\windows"
$CacheDir = Join-Path $PackDir "cache"
$Payload = Join-Path $PackDir "payload"
$PythonDir = Join-Path $Payload "python"
$PwDir = Join-Path $Payload "ms-playwright"

$PythonVersion = "3.12.10"
$EmbedZipName = "python-$PythonVersion-embed-amd64.zip"

$PythonUrls = @(
  "https://mirrors.huaweicloud.com/python/$PythonVersion/$EmbedZipName",
  "https://www.python.org/ftp/python/$PythonVersion/$EmbedZipName"
)
$GetPipUrls = @(
  "https://bootstrap.pypa.io/get-pip.py",
  "https://mirrors.aliyun.com/pypi/get-pip.py"
)

function Write-Step([string]$msg) {
  Write-Host ""
  Write-Host "=== $msg ===" -ForegroundColor Cyan
}

function Ensure-Dir([string]$path) {
  if (-not (Test-Path -LiteralPath $path)) {
    New-Item -ItemType Directory -Path $path | Out-Null
  }
}

function Get-PipIndex {
  if ($env:PIP_INDEX_URL) { return $env:PIP_INDEX_URL }
  return "https://pypi.tuna.tsinghua.edu.cn/simple"
}

function Get-HostPipPython {
  $candidates = @()
  if ($env:SIDEKICK_PYTHON) { $candidates += $env:SIDEKICK_PYTHON }
  $candidates += (Join-Path $RepoRoot ".venv\Scripts\python.exe")
  $cmd = Get-Command py -ErrorAction SilentlyContinue
  if ($cmd) { $candidates += $cmd.Source }
  $cmd = Get-Command python -ErrorAction SilentlyContinue
  if ($cmd) { $candidates += $cmd.Source }
  foreach ($p in $candidates) {
    if (-not $p) { continue }
    if ($p -eq "py" -or $p -eq "python") { }
    elseif (-not (Test-Path -LiteralPath $p)) { continue }
    $code = Invoke-QuietExitCode { & $p -m pip --version }
    if ($code -eq 0) { return $p }
  }
  return $null
}

function Invoke-PipInstall {
  param(
    [string]$EmbedPy,
    [string]$Requirements
  )
  $index = Get-PipIndex
  $extraIndex = @("-i", $index)

  if (Get-Command uv -ErrorAction SilentlyContinue) {
    Write-Host "  uv pip install --python (bundled) -r requirements.txt"
    & uv pip install --python $EmbedPy -r $Requirements --index-url $index
    if ($LASTEXITCODE -eq 0) { return $true }
    Write-Host "  uv failed, trying host pip..." -ForegroundColor Yellow
  }

  $hostPy = Get-HostPipPython
  if ($hostPy) {
    Write-Host "  host pip --python (bundled) via $hostPy"
    & $hostPy -m pip install --python $EmbedPy --no-warn-script-location -r $Requirements @extraIndex
    if ($LASTEXITCODE -eq 0) { return $true }
    Write-Host "  mirror failed, retrying PyPI with host pip..." -ForegroundColor Yellow
    & $hostPy -m pip install --python $EmbedPy --no-warn-script-location -r $Requirements
    if ($LASTEXITCODE -eq 0) { return $true }
  }

  Write-Host "  bootstrapping pip into embeddable Python (official get-pip)..."
  $getPip = Join-Path $CacheDir "get-pip-pypa.py"
  Download-FirstOk -Urls $GetPipUrls -OutFile $getPip
  & $EmbedPy $getPip --no-warn-script-location
  if ($LASTEXITCODE -ne 0) { return $false }
  Write-Host "  bundled python -m pip install -r requirements.txt"
  & $EmbedPy -m pip install --no-warn-script-location -r $Requirements @extraIndex
  if ($LASTEXITCODE -eq 0) { return $true }
  & $EmbedPy -m pip install --no-warn-script-location -r $Requirements
  return ($LASTEXITCODE -eq 0)
}

function Download-FirstOk {
  param(
    [string[]]$Urls,
    [string]$OutFile
  )
  Ensure-Dir (Split-Path -Parent $OutFile)
  foreach ($url in $Urls) {
    Write-Host "  GET $url"
    try {
      Invoke-WebRequest -Uri $url -OutFile $OutFile -UseBasicParsing
      if ((Get-Item $OutFile).Length -gt 1024) { return }
    } catch {
      Write-Host "  failed: $($_.Exception.Message)" -ForegroundColor Yellow
    }
  }
  throw "Download failed. Tried: $($Urls -join ', ')"
}

function Invoke-RobocopySafe {
  param(
    [string]$From,
    [string]$To,
    [string[]]$ExtraArgs = @()
  )
  Ensure-Dir $To
  $args = @($From, $To, "/E", "/NFL", "/NDL", "/NJH", "/NJS", "/nc", "/ns", "/np", "/XD", "__pycache__", ".git", "node_modules") + $ExtraArgs
  & robocopy @args | Out-Null
  if ($LASTEXITCODE -ge 8) {
    throw "robocopy failed ($LASTEXITCODE): $From -> $To"
  }
}

function Invoke-QuietExitCode {
  param([scriptblock]$Block)
  $prev = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    & $Block 2>$null | Out-Null
    if ($null -eq $LASTEXITCODE) { return 0 }
    return $LASTEXITCODE
  } catch {
    return 1
  } finally {
    $ErrorActionPreference = $prev
  }
}

function Test-BundledPythonOk {
  $py = Join-Path $PythonDir "python.exe"
  if (-not (Test-Path -LiteralPath $py)) { return $false }
  $code = Invoke-QuietExitCode { & $py -c "import fastapi, uvicorn, playwright" }
  return ($code -eq 0)
}

function Enable-EmbeddableSite {
  $pth = Get-ChildItem -LiteralPath $PythonDir -Filter "python*._pth" | Select-Object -First 1
  if (-not $pth) { throw "python*._pth not found in $PythonDir" }
  $text = Get-Content -LiteralPath $pth.FullName -Raw -Encoding ASCII
  $text = $text -replace '(?m)^#\s*import site\s*$', 'import site'
  if ($text -notmatch '(?m)^import site\s*$') {
    $text = $text.TrimEnd() + "`r`nimport site`r`n"
  }
  if ($text -notmatch 'Lib\\site-packages') {
    $text = $text -replace '(?m)^import site\s*$', "Lib\site-packages`r`nimport site"
  }
  [System.IO.File]::WriteAllText($pth.FullName, $text.TrimEnd() + "`r`n")
}

function Install-EmbeddablePython {
  Write-Step "Preparing embeddable Python $PythonVersion"
  $zip = Join-Path $CacheDir $EmbedZipName
  if (-not (Test-Path -LiteralPath $zip) -or (Get-Item $zip).Length -lt 1024) {
    Download-FirstOk -Urls $PythonUrls -OutFile $zip
  } else {
    Write-Host "  cache hit: $zip"
  }

  if (Test-Path -LiteralPath $PythonDir) {
    Remove-Item -LiteralPath $PythonDir -Recurse -Force
  }
  Ensure-Dir $PythonDir
  Expand-Archive -LiteralPath $zip -DestinationPath $PythonDir -Force
  Enable-EmbeddableSite
  Ensure-Dir (Join-Path $PythonDir "Lib\site-packages")

  $py = Join-Path $PythonDir "python.exe"
  $req = Join-Path $RepoRoot "requirements.txt"
  $ok = Invoke-PipInstall -EmbedPy $py -Requirements $req
  if (-not $ok) { throw "failed to install Python packages into bundled runtime" }

  & $py -c "import fastapi, uvicorn, playwright; print('python runtime ok')"
  if ($LASTEXITCODE -ne 0) { throw "bundled Python import check failed" }
}

function Copy-AppPayload {
  Write-Step "Copying application payload"
  $srcDest = Join-Path $Payload "src"
  if (Test-Path -LiteralPath $srcDest) {
    Remove-Item -LiteralPath $srcDest -Recurse -Force
  }
  Invoke-RobocopySafe -From (Join-Path $RepoRoot "src\metateam") -To (Join-Path $srcDest "metateam")

  Ensure-Dir (Join-Path $srcDest "data")
  Ensure-Dir (Join-Path $srcDest "memory")
  Ensure-Dir (Join-Path $srcDest "sessions")
  Ensure-Dir (Join-Path $srcDest "skills")
  Ensure-Dir (Join-Path $srcDest "workspace")

  $example = Join-Path $RepoRoot "src\data\model.json.example"
  if (Test-Path -LiteralPath $example) {
    Copy-Item -LiteralPath $example -Destination (Join-Path $srcDest "data\model.json.example") -Force
  }
  $mem = Join-Path $RepoRoot "src\memory\MEMORY.md"
  if (Test-Path -LiteralPath $mem) {
    Copy-Item -LiteralPath $mem -Destination (Join-Path $srcDest "memory\MEMORY.md") -Force
  }
  $skillsSrc = Join-Path $RepoRoot "src\skills"
  if (Test-Path -LiteralPath $skillsSrc) {
    Invoke-RobocopySafe -From $skillsSrc -To (Join-Path $srcDest "skills")
  }

  Copy-Item -LiteralPath (Join-Path $RepoRoot "main.py") -Destination (Join-Path $Payload "main.py") -Force
  Copy-Item -LiteralPath (Join-Path $RepoRoot "requirements.txt") -Destination (Join-Path $Payload "requirements.txt") -Force

  $uiDist = Join-Path $RepoRoot "ui\dist"
  if (-not (Test-Path -LiteralPath $uiDist)) {
    throw "ui/dist missing. UI build did not run (or failed)."
  }
  $uiDest = Join-Path $Payload "ui\dist"
  if (Test-Path -LiteralPath $uiDest) {
    Remove-Item -LiteralPath $uiDest -Recurse -Force
  }
  Invoke-RobocopySafe -From $uiDist -To $uiDest
}

function Install-PlaywrightChromium {
  Write-Step "Bundling Playwright Chromium"
  $py = Join-Path $PythonDir "python.exe"
  Ensure-Dir $PwDir
  $env:PLAYWRIGHT_BROWSERS_PATH = $PwDir
  if (-not $env:PLAYWRIGHT_DOWNLOAD_HOST) {
    $env:PLAYWRIGHT_DOWNLOAD_HOST = "https://npmmirror.com/mirrors/playwright"
  }
  & $py -m playwright install chromium
  if ($LASTEXITCODE -ne 0) {
    Write-Host "  npmmirror failed, retrying default Playwright CDN..." -ForegroundColor Yellow
    Remove-Item Env:PLAYWRIGHT_DOWNLOAD_HOST -ErrorAction SilentlyContinue
    & $py -m playwright install chromium
    if ($LASTEXITCODE -ne 0) { throw "playwright install chromium failed" }
  }
  $chrome = Get-ChildItem -LiteralPath $PwDir -Recurse -Filter "chrome.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $chrome) { throw "chrome.exe not found under $PwDir" }
  Write-Host "  $($chrome.FullName)"
}

function Build-Ui {
  Write-Step "Building UI"
  $ui = Join-Path $RepoRoot "ui"
  Push-Location $ui
  try {
    if (-not (Test-Path -LiteralPath (Join-Path $ui "node_modules"))) {
      Write-Host "  npm install (ui)"
      npm install
      if ($LASTEXITCODE -ne 0) { throw "npm install failed in ui/" }
    }
    npm run build
    if ($LASTEXITCODE -ne 0) { throw "npm run build failed in ui/" }
  } finally {
    Pop-Location
  }
}

function Build-Installer {
  Write-Step "electron-builder (NSIS + zip)"
  $desktop = Join-Path $RepoRoot "desktop"
  if (-not (Test-Path -LiteralPath (Join-Path $Payload "python\python.exe"))) {
    throw "payload/python missing — runtime was not prepared"
  }
  if (-not (Test-Path -LiteralPath (Join-Path $Payload "ui\dist\index.html"))) {
    throw "payload/ui/dist missing — UI was not copied"
  }
  Push-Location $desktop
  try {
    if (-not $env:ELECTRON_MIRROR) {
      $env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
    }
    if (-not $env:ELECTRON_BUILDER_BINARIES_MIRROR) {
      $env:ELECTRON_BUILDER_BINARIES_MIRROR = "https://npmmirror.com/mirrors/electron-builder-binaries/"
    }
    if (-not (Test-Path -LiteralPath (Join-Path $desktop "node_modules\electron-builder"))) {
      Write-Host "  npm install (desktop, including electron-builder)"
      npm install
      if ($LASTEXITCODE -ne 0) { throw "npm install failed in desktop/" }
    }
    npx electron-builder --win
    if ($LASTEXITCODE -ne 0) { throw "electron-builder failed ($LASTEXITCODE)" }
  } finally {
    Pop-Location
  }
}

# ---- main ----
Write-Host ""
Write-Host " Sidekick Windows offline installer"
Write-Host " ----------------------------------"
Write-Host " Repo: $RepoRoot"
Ensure-Dir $CacheDir
Ensure-Dir $Payload

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "Node.js is required on the build machine (not on the target PC)."
}
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
  throw "npm is required on the build machine."
}

if (-not $SkipUi) {
  Build-Ui
} elseif (-not (Test-Path -LiteralPath (Join-Path $RepoRoot "ui\dist\index.html"))) {
  throw "ui/dist missing; omit -SkipUi"
}

$needRuntime = $Force -or -not (Test-BundledPythonOk)
if ($SkipRuntime -and -not (Test-BundledPythonOk)) {
  throw "payload/python is not ready; omit -SkipRuntime or pass -Force"
}
if (-not $SkipRuntime -and $needRuntime) {
  Install-EmbeddablePython
} else {
  Write-Step "Reusing bundled Python"
  Write-Host "  $PythonDir"
}

Copy-AppPayload

if (-not $SkipPlaywright) {
  $chrome = Get-ChildItem -LiteralPath $PwDir -Recurse -Filter "chrome.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($Force -or -not $chrome) {
    Install-PlaywrightChromium
  } else {
    Write-Step "Reusing Playwright Chromium"
    Write-Host "  $($chrome.FullName)"
  }
}

Build-Installer

$dist = Join-Path $RepoRoot "desktop\dist"
Write-Host ""
Write-Host " Build finished." -ForegroundColor Green
Write-Host " Copy one of these to the offline PC:"
Get-ChildItem -LiteralPath $dist -File | Where-Object {
  $_.Extension -in ".exe", ".zip"
} | ForEach-Object {
  Write-Host ("  {0,-12} {1:N1} MB  {2}" -f $_.Extension, ($_.Length / 1MB), $_.FullName)
}
Write-Host ""
Write-Host " Install: double-click the Setup .exe (no Python/Node/network required)."
Write-Host " Chat still needs a model API (cloud or LAN Ollama) unless you use a local endpoint."
