# Process helpers only: loading this file never launches a process or a window.
function Stop-StartupProcessTree($Process) {
  if ($Process.HasExited) { return }
  # Only the child returned by this launcher's Start-Process is eligible.
  $killer = Start-Process -FilePath "$env:SystemRoot\System32\taskkill.exe" -ArgumentList @('/PID', $Process.Id, '/T', '/F') -WindowStyle Hidden -PassThru
  try {
    if (-not $killer.WaitForExit(5000)) { $killer.Kill() }
    if (-not $Process.HasExited) { $Process.Kill() }
    if (-not $Process.WaitForExit(5000)) { throw 'Startup child did not stop; preparation is still in use.' }
  } finally { $killer.Dispose() }
}

function Invoke-StartupProcess {
  param(
    [string]$File,
    [string[]]$Arguments,
    [string]$Directory,
    [string]$Output,
    [string]$Errors,
    [int]$TimeoutSeconds,
    [string]$TimeoutMessage,
    [scriptblock]$Pulse = {}
  )
  & $Pulse
  $child = Start-Process -FilePath $File -ArgumentList $Arguments -WorkingDirectory $Directory -WindowStyle Hidden -PassThru -RedirectStandardOutput $Output -RedirectStandardError $Errors
  $childHandle = $child.Handle # Retain the handle for ExitCode on Windows PowerShell 5.
  $elapsed = [System.Diagnostics.Stopwatch]::StartNew()
  try {
    while (-not $child.WaitForExit(200)) {
      & $Pulse
      if ($elapsed.Elapsed.TotalSeconds -ge $TimeoutSeconds) { throw $TimeoutMessage }
    }
    & $Pulse
    return $child.ExitCode
  } catch {
    Stop-StartupProcessTree $child
    throw
  } finally {
    $elapsed.Stop()
    $child.Dispose()
  }
}
