param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('user', 'admin')]
  [string]$Edition,
  [switch]$NoDialogs
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$repoRoot = Split-Path -Parent $PSScriptRoot
$logRoot = Join-Path $repoRoot '.test-data\launcher'
$stamp = "$(Get-Date -Format 'yyyyMMdd-HHmmss-fff')-$PID"
$launchLog = Join-Path $logRoot "$Edition-$stamp.log"
$stderrLog = $launchLog
$preparationLock = $null

function Get-DependencyHash([string]$Path) {
  $stream = [System.IO.File]::OpenRead($Path)
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try { return [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '') }
  finally { $stream.Dispose(); $sha.Dispose() }
}

function Invoke-NpmStep([string]$Step, [string[]]$Arguments) {
  $stdoutLog = Join-Path $logRoot "$Edition-$stamp-$Step.log"
  $script:stderrLog = Join-Path $logRoot "$Edition-$stamp-$Step-error.log"
  Add-Content -LiteralPath $launchLog -Encoding UTF8 -Value "npm $($Arguments -join ' ')"
  $process = Start-Process -FilePath $npm `
    -ArgumentList $Arguments `
    -WorkingDirectory $repoRoot `
    -WindowStyle Hidden `
    -Wait `
    -PassThru `
    -RedirectStandardOutput $stdoutLog `
    -RedirectStandardError $script:stderrLog
  if ($process.ExitCode -ne 0) {
    if ($Step -eq 'install') {
      throw '依赖安装失败。请检查本机网络或 npm 代理配置，然后重新双击启动入口。'
    }
    throw '当前代码构建失败，未启动旧版本。请将启动日志交给项目维护者处理。'
  }
}

function Invoke-RuntimeProbe([string]$File, [string[]]$Arguments, [string]$Id) {
  $output = Join-Path $logRoot "$Edition-$stamp-probe-$Id.out"
  $errors = Join-Path $logRoot "$Edition-$stamp-probe-$Id.err"
  $process = Start-Process -FilePath $File -ArgumentList $Arguments -WorkingDirectory $repoRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput $output -RedirectStandardError $errors
  $probeHandle = $process.Handle # Retain the handle so Windows PowerShell 5 can read ExitCode after waiting.
  if (-not $process.WaitForExit(10000)) {
    & "$env:SystemRoot\System32\taskkill.exe" /PID $process.Id /T /F 2>&1 | Out-Null
    throw '运行时自检超时'
  }
  $process.WaitForExit()
  if ($process.ExitCode -ne 0) { throw '运行时自检失败' }
  return (Get-Content -LiteralPath $output -Raw)
}

function Test-ElectronRuntime {
  $packageRoot = Join-Path $repoRoot 'node_modules\electron'
  try {
    $package = Get-Content -LiteralPath (Join-Path $packageRoot 'package.json') -Raw | ConvertFrom-Json
    return (Test-Path -LiteralPath (Join-Path $packageRoot 'dist\electron.exe') -PathType Leaf) -and
      ((Get-Content -LiteralPath (Join-Path $packageRoot 'path.txt') -Raw).Trim() -eq 'electron.exe') -and
      ((Get-Content -LiteralPath (Join-Path $packageRoot 'dist\version') -Raw).Trim().TrimStart('v') -eq $package.version)
  } catch { return $false }
}

function Install-ElectronRuntime {
  if (Test-ElectronRuntime) { return }
  $stdoutLog = Join-Path $logRoot "$Edition-$stamp-electron.log"
  $script:stderrLog = Join-Path $logRoot "$Edition-$stamp-electron-error.log"
  Add-Content -LiteralPath $launchLog -Encoding UTF8 -Value 'Preparing Electron binary: node node_modules/electron/install.js'
  # Electron 44 downloads on first use, not during npm ci. Use the installed package's
  # own installer so its pinned version, checksum verification and cache are retained.
  $installArguments = @()
  if ($runtime.systemCa) { $installArguments += '--use-system-ca' }
  $installArguments += '"node_modules\electron\install.js"'
  $process = Start-Process -FilePath $nodePath `
    -ArgumentList $installArguments `
    -WorkingDirectory $repoRoot `
    -WindowStyle Hidden `
    -Wait `
    -PassThru `
    -RedirectStandardOutput $stdoutLog `
    -RedirectStandardError $script:stderrLog
  if ($process.ExitCode -ne 0 -or -not (Test-ElectronRuntime)) {
    throw 'Electron 运行文件准备失败。请查看详细日志，检查下载网络或文件权限后重新启动；已安装的 npm 依赖会保留。'
  }
}

try {
  New-Item -ItemType Directory -Force -Path $logRoot | Out-Null
  Set-Content -LiteralPath $launchLog -Encoding UTF8 -Value "Edition: $Edition`r`nRepository: $repoRoot"
  $originalPath = $env:PATH
  $candidates = @()
  $portableRoot = Join-Path $repoRoot '.tools'
  if (Test-Path -LiteralPath $portableRoot) {
    $candidates += @(Get-ChildItem -LiteralPath $portableRoot -Directory -Filter 'node-v*-win-x64' |
      Where-Object { $_.Name -match '^node-v(\d+\.\d+\.\d+)-win-x64$' } |
      Sort-Object { [version]($_.Name -replace '^node-v|\-win-x64$', '') } -Descending |
      ForEach-Object { @{ Node = (Join-Path $_.FullName 'node.exe'); Npm = (Join-Path $_.FullName 'npm.cmd') } })
  }
  $systemNpm = Get-Command 'npm.cmd' -ErrorAction SilentlyContinue
  foreach ($nodeCommand in @(Get-Command 'node.exe' -All -ErrorAction SilentlyContinue)) {
    $adjacentNpm = Join-Path (Split-Path -Parent $nodeCommand.Source) 'npm.cmd'
    $candidates += @{ Node = $nodeCommand.Source; Npm = $(if ($systemNpm) { $systemNpm.Source } elseif (Test-Path -LiteralPath $adjacentNpm) { $adjacentNpm } else { '' }) }
  }
  $pathConfig = Join-Path $repoRoot '.tools/node-path.txt'
  $customDirectory = $env:WORKBENCH_NODE_DIR
  if (-not $customDirectory -and (Test-Path -LiteralPath $pathConfig)) { $customDirectory = (Get-Content -LiteralPath $pathConfig -Raw).Trim() }
  if ($customDirectory) { $candidates += @{ Node = (Join-Path $customDirectory 'node.exe'); Npm = (Join-Path $customDirectory 'npm.cmd') } }
  $selected = $false
  $probeNumber = 0
  while (-not $selected) {
    foreach ($candidate in $candidates) {
      $probeNumber++
      try {
        if (-not $candidate.Npm -or -not (Test-Path -LiteralPath $candidate.Node -PathType Leaf) -or -not (Test-Path -LiteralPath $candidate.Npm -PathType Leaf)) { throw 'node.exe 或 npm.cmd 不完整' }
        $env:PATH = (Split-Path -Parent $candidate.Node) + ';' + $originalPath
        $info = Invoke-RuntimeProbe $candidate.Node @('-p', 'JSON.stringify({major:parseInt(process.versions.node),arch:process.arch,systemCa:process.allowedNodeEnvironmentFlags.has(\"--use-system-ca\")})') "$probeNumber-node"
        $runtime = $info | ConvertFrom-Json
        if ($runtime.major -lt 22 -or $runtime.arch -ne 'x64') { throw '需要 x64 Node.js 22 或更高版本' }
        $npmVersion = Invoke-RuntimeProbe $candidate.Npm @('--version') "$probeNumber-npm"
        if ($npmVersion.Trim() -notmatch '^\d+\.\d+\.\d+') { throw 'npm 无法正常运行' }
        $nodePath = $candidate.Node; $npm = $candidate.Npm; $selected = $true
        Add-Content -LiteralPath $launchLog -Encoding UTF8 -Value "Node: $nodePath`r`nNpm: $npm"
        break
      } catch {
        Add-Content -LiteralPath $launchLog -Encoding UTF8 -Value "Skipped: $($candidate.Node) / $($_.Exception.Message)"
        $env:PATH = $originalPath
      }
    }
    if ($selected) { break }
    if ($NoDialogs) { throw '请先安装 64 位 Node.js 22 或更高版本，或配置包含 node.exe 和 npm.cmd 的便携目录。所有候选均不可用，详见启动日志。' }
    Add-Type -AssemblyName System.Windows.Forms
    $choice = [System.Windows.Forms.MessageBox]::Show('未找到可运行的 Node.js 和 npm。是否选择已安装或已解压的离线 Node 目录？需要 x64 Node.js 22 或更高版本。', '准备启动环境', 'YesNo', 'Question')
    if ($choice -ne [System.Windows.Forms.DialogResult]::Yes) { throw '尚未配置可用的 Node.js 和 npm。' }
    $picker = New-Object System.Windows.Forms.FolderBrowserDialog
    $picker.Description = '选择同时包含 node.exe 和 npm.cmd 的目录'
    try {
      if ($picker.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) { throw '已取消选择运行环境。' }
      $customDirectory = $picker.SelectedPath
    } finally { $picker.Dispose() }
    New-Item -ItemType Directory -Force -Path $portableRoot | Out-Null
    Set-Content -LiteralPath $pathConfig -Encoding UTF8 -Value $customDirectory
    $candidates = @(@{ Node = (Join-Path $customDirectory 'node.exe'); Npm = (Join-Path $customDirectory 'npm.cmd') })
  }

  # Both editions share node_modules and dist; serialize preparation, not application lifetimes.
  $deadline = [DateTime]::UtcNow.AddMinutes(15)
  while (-not $preparationLock) {
    try {
      $preparationLock = [System.IO.File]::Open((Join-Path $logRoot 'prepare.lock'), 'OpenOrCreate', 'ReadWrite', 'None')
    } catch [System.IO.IOException] {
      if ([DateTime]::UtcNow -ge $deadline) { throw '另一个启动入口仍在准备环境，请稍后重试。' }
      Start-Sleep -Milliseconds 200
    }
  }

  $dependencyStamp = Join-Path $logRoot 'dependencies.txt'
  $expectedStamp = @(
    (Get-DependencyHash (Join-Path $repoRoot 'package-lock.json')),
    (Get-DependencyHash (Join-Path $repoRoot 'package.json')),
    $runtime.major
  ) -join ':'
  $installedStamp = if (Test-Path -LiteralPath $dependencyStamp) { (Get-Content -LiteralPath $dependencyStamp -Raw).Trim() } else { '' }
  $electron = Join-Path $repoRoot 'node_modules\electron\dist\electron.exe'
  $dependenciesReady = (Test-Path -LiteralPath (Join-Path $repoRoot 'node_modules\electron\package.json')) -and
    (Test-Path -LiteralPath (Join-Path $repoRoot 'node_modules\esbuild\package.json')) -and
    (Test-Path -LiteralPath (Join-Path $repoRoot 'node_modules\ssh2\package.json'))
  if ($installedStamp -ne $expectedStamp -or -not $dependenciesReady) {
    Invoke-NpmStep 'install' @('ci', '--include=dev', '--include=optional', '--no-audit', '--no-fund')
    Set-Content -LiteralPath $dependencyStamp -Encoding ASCII -Value $expectedStamp
  }

  Install-ElectronRuntime
  Invoke-NpmStep 'build' @('run', 'build')

  $entry = Join-Path $repoRoot "dist\$Edition"
  if (-not (Test-Path -LiteralPath (Join-Path $entry 'main.cjs'))) {
    throw '构建未生成所选版本的运行文件，请检查启动日志。'
  }

  Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
  Add-Content -LiteralPath $launchLog -Encoding UTF8 -Value "Entry: $entry"
  # Start-Process joins ArgumentList into one command line, so the path needs explicit quotes.
  Start-Process -FilePath $electron -ArgumentList @('"' + $entry + '"') -WorkingDirectory $repoRoot
} catch {
  # An error dialog may stay open indefinitely; it must not hold the other edition's lock.
  if ($preparationLock) { $preparationLock.Dispose(); $preparationLock = $null }
  $message = "工作台未能启动。`r`n$($_.Exception.Message)`r`n`r`n启动日志：$launchLog`r`n详细日志：$stderrLog"
  if ($NoDialogs) {
    [Console]::Error.WriteLine($message)
  } else {
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.MessageBox]::Show(
      $message,
      '团队工作台',
      [System.Windows.Forms.MessageBoxButtons]::OK,
      [System.Windows.Forms.MessageBoxIcon]::Error
    ) | Out-Null
  }
  exit 1
} finally {
  if ($preparationLock) { $preparationLock.Dispose() }
}
