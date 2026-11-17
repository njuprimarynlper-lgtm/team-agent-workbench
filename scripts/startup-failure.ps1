# Public launcher guidance. Detailed exceptions stay in startup diagnostic logs.
function Get-StartupFailureMessage([string]$Stage, [string]$Reason) {
  $summary = if ($Reason -match '^另一个启动入口仍在准备环境') {
    '另一个工作台窗口还在准备启动。请等它启动后，再打开这个窗口。'
  } elseif ($Reason -match '^(请先安装 64 位 Node|需要 x64 Node|未找到可运行的 Node|尚未配置可用的 Node|node\.exe 或 npm\.cmd 不完整|npm 无法正常运行)') {
    '启动所需的 Node.js 和 npm 无法运行。请导出故障报告，交给维护人员处理。'
  } elseif ($Stage -match '构建' -or $Reason -match '构建') {
    '工作台的启动文件生成失败，暂时打不开。请导出故障报告，交给维护人员修复。'
  } elseif ($Stage -match '依赖|安装|下载|运行环境|运行时|缓存') {
    '启动文件准备失败，工作台还没打开。请导出故障报告，将生成的文件交给维护人员。'
  } else {
    '工作台没能打开。请导出故障报告，将生成的文件交给维护人员排查。'
  }
  return $summary
}

function Select-StartupDiagnosticsDestination {
  Add-Type -AssemblyName System.Windows.Forms
  $save = New-Object System.Windows.Forms.SaveFileDialog
  try {
    $save.Title = '保存工作台故障报告'
    $save.Filter = '故障报告 (*.zip)|*.zip'
    $save.FileName = 'TeamAgent-startup-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.zip'
    if ($save.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { return $save.FileName }
    return $null
  } finally { $save.Dispose() }
}

function Show-StartupDiagnosticsExportFailure {
  Add-Type -AssemblyName System.Windows.Forms
  if (-not ('WorkbenchStartupFailureDialog' -as [type])) {
    Add-Type -Path (Join-Path $PSScriptRoot 'startup-error-dialog.cs') -ReferencedAssemblies System.Windows.Forms,System.Drawing
  }
  return [WorkbenchStartupFailureDialog]::ShowExportFailure()
}

# Both existing UI entries use the same recovery loop. The CLI export still
# calls Export-StartupDiagnostics directly and keeps its original exit behavior.
function Invoke-StartupDiagnosticsExport([string]$Edition, [string]$LegacyDirectory, [string]$FailureLog) {
  while ($true) {
    try {
      $destination = Select-StartupDiagnosticsDestination
      if (-not $destination) { return $false }
      Export-StartupDiagnostics $Edition $destination $LegacyDirectory
      return $true
    } catch {
      $detail = $_.Exception.ToString()
      try {
        Add-Content -LiteralPath $FailureLog -Encoding UTF8 -Value ('Startup diagnostics export failed: ' + $detail) -ErrorAction Stop
      } catch { }
      if (-not (Show-StartupDiagnosticsExportFailure)) { return $false }
    }
  }
}
