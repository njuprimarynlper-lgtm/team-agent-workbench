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
$progressWindow = $null
$cancelStartup = $false
$closingProgress = $false
$stage = '准备启动'
$stageHint = ''
$stageStarted = Get-Date
$lastHeartbeat = Get-Date

function Show-StartupProgress {
  if ($NoDialogs) { return }
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
  [System.Windows.Forms.Application]::EnableVisualStyles()
  $script:progressWindow = New-Object System.Windows.Forms.Form
  $progressWindow.Text = $(if ($Edition -eq 'user') { '启动团队工作台 · 用户端' } else { '启动团队工作台 · 管理端' })
  $progressWindow.ClientSize = New-Object System.Drawing.Size(470, 215)
  $progressWindow.FormBorderStyle = 'FixedDialog'
  $progressWindow.StartPosition = 'CenterScreen'
  $progressWindow.MaximizeBox = $false
  $progressWindow.MinimizeBox = $false
  $progressWindow.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9)
  $script:stageLabel = New-Object System.Windows.Forms.Label
  $stageLabel.SetBounds(24, 20, 422, 28)
  $stageLabel.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 11, [System.Drawing.FontStyle]::Bold)
  $script:hintLabel = New-Object System.Windows.Forms.Label
  $hintLabel.SetBounds(24, 57, 422, 42)
  $bar = New-Object System.Windows.Forms.ProgressBar
  $bar.SetBounds(24, 112, 422, 8)
  $bar.Style = 'Marquee'
  $bar.MarqueeAnimationSpeed = 30
  $script:elapsedLabel = New-Object System.Windows.Forms.Label
  $elapsedLabel.SetBounds(24, 136, 422, 22)
  $elapsedLabel.ForeColor = [System.Drawing.Color]::DimGray
  $logsButton = New-Object System.Windows.Forms.Button
  $logsButton.Text = '查看日志'
  $logsButton.SetBounds(250, 172, 94, 28)
  $logsButton.Add_Click({ Start-Process -FilePath "$env:SystemRoot\explorer.exe" -ArgumentList @('"' + $logRoot + '"') })
  $cancelButton = New-Object System.Windows.Forms.Button
  $cancelButton.Text = '取消启动'
  $cancelButton.SetBounds(352, 172, 94, 28)
  $cancelButton.Add_Click({ $script:cancelStartup = $true })
  $progressWindow.Add_FormClosing({ param($sender, $eventArgs) if (-not $script:closingProgress) { $script:cancelStartup = $true; $eventArgs.Cancel = $true } })
  $progressWindow.Controls.AddRange(@($stageLabel, $hintLabel, $bar, $elapsedLabel, $logsButton, $cancelButton))
  $progressWindow.Show()
}

function Close-StartupProgress {
  if ($progressWindow) { $script:closingProgress = $true; $progressWindow.Close(); $progressWindow.Dispose(); $script:progressWindow = $null }
}

function Update-StartupProgress {
  if ($progressWindow) {
    $stageLabel.Text = $stage
    $hintLabel.Text = $stageHint
    $elapsedLabel.Text = '本步骤已用时 ' + [int]((Get-Date) - $stageStarted).TotalSeconds + ' 秒'
    [System.Windows.Forms.Application]::DoEvents()
  }
  if ($cancelStartup) { throw [System.OperationCanceledException]::new('已取消启动') }
  if (((Get-Date) - $lastHeartbeat).TotalSeconds -ge 15) {
    Add-Content -LiteralPath $launchLog -Encoding UTF8 -Value "Waiting: $stage / $([int]((Get-Date) - $stageStarted).TotalSeconds)s"
    $script:lastHeartbeat = Get-Date
  }
}

function Set-StartupStage([string]$Name, [string]$Hint) {
  $script:stage = $Name; $script:stageHint = $Hint; $script:stageStarted = Get-Date; $script:lastHeartbeat = Get-Date
  Add-Content -LiteralPath $launchLog -Encoding UTF8 -Value "Step: $Name / $Hint"
  if ($NoDialogs) { [Console]::Out.WriteLine($Name + '：' + $Hint) }
  Update-StartupProgress
}


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
  if ($Step -eq 'install') {
    Set-StartupStage '正在安装依赖' '首次启动需要联网下载；最多等待 10 分钟，可随时取消。'
  } else {
    Set-StartupStage '正在构建工作台' '准备当前版本，通常几十秒内完成；最多等待 3 分钟。'
  }
  $limit = if ($Step -eq 'install') { 600 } else { 180 }
  $code = Invoke-StartupProcess -File $npm -Arguments $Arguments -Directory $repoRoot -Output $stdoutLog -Errors $script:stderrLog -TimeoutSeconds $limit -TimeoutMessage ($stage + '超时，请检查详细日志后重试。') -Pulse { Update-StartupProgress }
  if ($code -ne 0) {
    if ($Step -eq 'install') {
      throw '依赖安装失败。请检查本机网络或 npm 代理配置，然后重新双击启动入口。'
    }
    throw '当前代码构建失败，未启动旧版本。请将启动日志交给项目维护者处理。'
  }
}

function Invoke-RuntimeProbe([string]$File, [string[]]$Arguments, [string]$Id) {
  $output = Join-Path $logRoot "$Edition-$stamp-probe-$Id.out"
  $errors = Join-Path $logRoot "$Edition-$stamp-probe-$Id.err"
  $code = Invoke-StartupProcess -File $File -Arguments $Arguments -Directory $repoRoot -Output $output -Errors $errors -TimeoutSeconds 10 -TimeoutMessage '运行时自检超时' -Pulse { Update-StartupProgress }
  if ($code -ne 0) { throw '运行时自检失败' }
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
  Set-StartupStage '正在下载桌面运行环境' '需要访问 Electron 下载源；最多等待 10 分钟，可随时取消。'
  $code = Invoke-StartupProcess -File $nodePath -Arguments $installArguments -Directory $repoRoot -Output $stdoutLog -Errors $script:stderrLog -TimeoutSeconds 600 -TimeoutMessage 'Electron 下载超时，请检查本机下载网络或代理配置。' -Pulse { Update-StartupProgress }
  if ($code -ne 0 -or -not (Test-ElectronRuntime)) {
    throw 'Electron 运行文件准备失败。请查看详细日志，检查下载网络或文件权限后重新启动；已安装的 npm 依赖会保留。'
  }
}

try {
  New-Item -ItemType Directory -Force -Path $logRoot | Out-Null
  Set-Content -LiteralPath $launchLog -Encoding UTF8 -Value "Edition: $Edition`r`nRepository: $repoRoot"
  . (Join-Path $PSScriptRoot 'startup-process.ps1')
  Show-StartupProgress
  Set-StartupStage '正在检查 Node.js 和 npm' '复用已安装的运行环境；每个候选最多检测 10 秒。'
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
        $info = Invoke-RuntimeProbe $candidate.Node @('-p', 'JSON.stringify({major:parseInt(process.versions.node),version:process.versions.node,arch:process.arch,systemCa:process.allowedNodeEnvironmentFlags.has(\"--use-system-ca\")})') "$probeNumber-node"
        $runtime = $info | ConvertFrom-Json
        if ([version]$runtime.version -lt [version]'22.12.0' -or $runtime.arch -ne 'x64') { throw '需要 x64 Node.js 22.12.0 或更高版本' }
        $npmVersion = Invoke-RuntimeProbe $candidate.Npm @('--version') "$probeNumber-npm"
        if ($npmVersion.Trim() -notmatch '^\d+\.\d+\.\d+') { throw 'npm 无法正常运行' }
        $nodePath = $candidate.Node; $npm = $candidate.Npm; $selected = $true
        Add-Content -LiteralPath $launchLog -Encoding UTF8 -Value "Node: $nodePath`r`nNode version: $($runtime.version) / $($runtime.arch)`r`nNpm: $npm"
        break
      } catch [System.OperationCanceledException] { throw } catch {
        Add-Content -LiteralPath $launchLog -Encoding UTF8 -Value "Skipped: $($candidate.Node) / $($_.Exception.Message)"
        $env:PATH = $originalPath
      }
    }
    if ($selected) { break }
    if ($NoDialogs) { throw '请先安装 64 位 Node.js 22.12.0 或更高版本，或配置包含 node.exe 和 npm.cmd 的便携目录。所有候选均不可用，详见启动日志。' }
    Add-Type -AssemblyName System.Windows.Forms
    $choice = [System.Windows.Forms.MessageBox]::Show('未找到可运行的 Node.js 和 npm。是否选择已安装或已解压的离线 Node 目录？需要 x64 Node.js 22.12.0 或更高版本。', '准备启动环境', 'YesNo', 'Question')
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
  Set-StartupStage '正在等待启动准备' '其他入口正在安装或构建时会排队；可取消后稍后重试。'
  $deadline = [DateTime]::UtcNow.AddMinutes(15)
  while (-not $preparationLock) {
    Update-StartupProgress
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

  Set-StartupStage '正在检查桌面运行环境' '已有完整运行文件时会直接复用。'
  Install-ElectronRuntime
  Invoke-NpmStep 'build' @('run', 'build')

  $entry = Join-Path $repoRoot "dist\$Edition"
  if (-not (Test-Path -LiteralPath (Join-Path $entry 'main.cjs'))) {
    throw '构建未生成所选版本的运行文件，请检查启动日志。'
  }

  Set-StartupStage '正在打开工作台' '准备完成，正在打开应用窗口。'
  Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
  Add-Content -LiteralPath $launchLog -Encoding UTF8 -Value "Entry: $entry"
  # Start-Process joins ArgumentList into one command line, so the path needs explicit quotes.
  Start-Process -FilePath $electron -ArgumentList @('"' + $entry + '"') -WorkingDirectory $repoRoot
} catch {
  Close-StartupProgress
  if ($_.Exception -is [System.OperationCanceledException]) {
    Add-Content -LiteralPath $launchLog -Encoding UTF8 -Value 'Cancelled by user.'
    exit 2
  }
  Add-Content -LiteralPath $launchLog -Encoding UTF8 -Value ("Failed: $stage / " + $_.Exception.Message) -ErrorAction SilentlyContinue
  # An error dialog may stay open indefinitely; it must not hold the other edition's lock.
  if ($preparationLock) { $preparationLock.Dispose(); $preparationLock = $null }
  $message = "工作台未能启动。`r`n阶段：$stage`r`n$($_.Exception.Message)`r`n`r`n启动日志：$launchLog`r`n详细日志：$stderrLog"
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
  Close-StartupProgress
  if ($preparationLock) { $preparationLock.Dispose() }
}
