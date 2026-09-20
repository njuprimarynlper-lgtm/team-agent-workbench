param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('user', 'admin')]
  [string]$Edition
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$logRoot = Join-Path $repoRoot '.test-data\launcher'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
$stdoutLog = Join-Path $logRoot "$Edition-$stamp.log"
$stderrLog = Join-Path $logRoot "$Edition-$stamp-error.log"

try {
  New-Item -ItemType Directory -Force -Path $logRoot | Out-Null
  $npm = (Get-Command 'npm.cmd' -ErrorAction Stop).Source
  $build = Start-Process -FilePath $npm `
    -ArgumentList @('run', 'build') `
    -WorkingDirectory $repoRoot `
    -WindowStyle Hidden `
    -Wait `
    -PassThru `
    -RedirectStandardOutput $stdoutLog `
    -RedirectStandardError $stderrLog

  if ($build.ExitCode -ne 0) {
    throw "Source build failed with exit code $($build.ExitCode)."
  }

  $electron = Join-Path $repoRoot 'node_modules\electron\dist\electron.exe'
  $entry = Join-Path $repoRoot "dist\$Edition"
  if (-not (Test-Path -LiteralPath $electron) -or -not (Test-Path -LiteralPath $entry)) {
    throw 'Runtime files are missing. Run npm install in the project directory first.'
  }

  Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
  Start-Process -FilePath $electron -ArgumentList @($entry) -WorkingDirectory $repoRoot
} catch {
  Add-Type -AssemblyName System.Windows.Forms
  $message = "Team Agent Workbench failed to start.`r`n$($_.Exception.Message)`r`n`r`nError log: $stderrLog"
  [System.Windows.Forms.MessageBox]::Show(
    $message,
    'Team Agent Workbench',
    [System.Windows.Forms.MessageBoxButtons]::OK,
    [System.Windows.Forms.MessageBoxIcon]::Error
  ) | Out-Null
  exit 1
}
