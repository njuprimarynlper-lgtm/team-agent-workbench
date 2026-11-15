param(
  [ValidateSet('user','admin')][string]$Edition = '',
  [string]$DataRoot = '',
  [string]$Output = ''
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'startup-logs.ps1')
if (-not $Edition) {
  $marker = Join-Path $PSScriptRoot 'edition.txt'
  $Edition = if (Test-Path -LiteralPath $marker) { ([IO.File]::ReadAllText($marker)).Trim() } else { 'user' }
}
if ($Edition -notin @('user','admin')) { throw 'Invalid application edition.' }
if ($DataRoot) {
  if (-not [IO.Path]::IsPathRooted($DataRoot)) { throw 'DataRoot must be an absolute path.' }
  if ($Edition -eq 'user') { $env:WORKBENCH_DATA_DIR = $DataRoot } else { $env:WORKBENCH_ADMIN_DATA_DIR = $DataRoot }
}
if (-not $Output) {
  Add-Type -AssemblyName System.Windows.Forms
  $picker = New-Object System.Windows.Forms.SaveFileDialog
  try {
    $picker.Title = 'Export Team Agent diagnostics'
    $picker.Filter = 'ZIP archive (*.zip)|*.zip'
    $picker.FileName = 'TeamAgent-' + $Edition + '-diagnostics-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.zip'
    if ($picker.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) { exit 0 }
    $Output = $picker.FileName
  } finally { $picker.Dispose() }
}
Export-StartupDiagnostics $Edition $Output
[Console]::Out.WriteLine('Diagnostics exported: ' + $Output)
