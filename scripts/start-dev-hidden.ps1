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

try {
  New-Item -ItemType Directory -Force -Path $logRoot | Out-Null
  Set-Content -LiteralPath $launchLog -Encoding UTF8 -Value "Edition: $Edition`r`nRepository: $repoRoot"
  $node = Get-Command 'node.exe' -ErrorAction SilentlyContinue
  $npmCommand = Get-Command 'npm.cmd' -ErrorAction SilentlyContinue
  if (-not $node -or -not $npmCommand) {
    throw '请先安装 64 位 Node.js 22 或更高版本，重新打开本启动入口。Node.js 安装时需包含 npm 并加入 PATH。'
  }
  $npm = $npmCommand.Source
  $nodeInfo = & $node.Source -p 'JSON.stringify({major:parseInt(process.versions.node),arch:process.arch})'
  if ($LASTEXITCODE -ne 0) { throw 'Node.js 无法运行，请修复本机 Node.js 安装后重试。' }
  $runtime = $nodeInfo | ConvertFrom-Json
  if ($runtime.major -lt 22 -or $runtime.arch -ne 'x64') {
    throw '请使用 64 位（x64）Node.js 22 或更高版本，然后重新打开本启动入口。'
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
  $dependenciesReady = (Test-Path -LiteralPath $electron) -and
    (Test-Path -LiteralPath (Join-Path $repoRoot 'node_modules\esbuild\package.json')) -and
    (Test-Path -LiteralPath (Join-Path $repoRoot 'node_modules\ssh2\package.json'))
  if ($installedStamp -ne $expectedStamp -or -not $dependenciesReady) {
    Invoke-NpmStep 'install' @('ci', '--include=dev', '--include=optional', '--no-audit', '--no-fund')
    if (-not (Test-Path -LiteralPath $electron)) {
      throw 'Electron 运行文件未安装成功。请检查是否禁用了 npm 安装脚本或 Electron 下载，并重新启动。'
    }
    Set-Content -LiteralPath $dependencyStamp -Encoding ASCII -Value $expectedStamp
  }

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
