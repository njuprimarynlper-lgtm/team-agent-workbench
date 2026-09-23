# Pure process doubles: no console, desktop, child process, network or real runtime.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\scripts\startup-process.ps1')

function Assert-Startup($Condition, [string]$Message) {
  if (-not $Condition) { throw $Message }
}

function New-FakeProcess([int]$Code = 0) {
  $process = [pscustomobject]@{ Id = 123456; Handle = 1; ExitCode = $Code; HasExited = $false; Disposed = $false; IsKiller = $false }
  $process | Add-Member ScriptMethod WaitForExit {
    param([int]$Milliseconds)
    if ($this.IsKiller -or $script:mode -eq 'success' -or $script:mode -eq 'error' -or $this.HasExited) { $this.HasExited = $true; return $true }
    Assert-Startup ($Milliseconds -eq 200) 'Polls must remain short and bounded.'
    return $false
  }
  $process | Add-Member ScriptMethod Kill { $this.HasExited = $true }
  $process | Add-Member ScriptMethod Dispose { $this.Disposed = $true }
  return $process
}

function Start-Process {
  param($FilePath, $ArgumentList, $WorkingDirectory, $WindowStyle, [switch]$PassThru, $RedirectStandardOutput, $RedirectStandardError)
  Assert-Startup ($WindowStyle -eq 'Hidden') 'Startup helpers must stay hidden.'
  if ($FilePath -like '*taskkill.exe') {
    Assert-Startup ($ArgumentList[0] -eq '/PID' -and $ArgumentList[1] -eq $script:child.Id -and $ArgumentList[2] -eq '/T' -and $ArgumentList[3] -eq '/F') 'Cleanup may only target the child created by this invocation.'
    $script:stopped++
    $script:child.HasExited = $true
    $killer = New-FakeProcess; $killer.IsKiller = $true
    return $killer
  }
  $script:started++
  Assert-Startup ($FilePath -eq 'fake.exe') 'Tests must never invoke a real runtime.'
  return $script:child
}

function Reset-Case([string]$Mode, [int]$Code = 0) {
  $script:mode = $Mode; $script:started = 0; $script:stopped = 0; $script:pulses = 0
  $script:child = New-FakeProcess $Code
}

$arguments = @{ File='fake.exe'; Arguments=@('fake'); Directory=$PSScriptRoot; Output='fake.out'; Errors='fake.err'; TimeoutSeconds=1; TimeoutMessage='deadline reached' }
Reset-Case 'success'
$code = Invoke-StartupProcess @arguments -Pulse { $script:pulses++ }
Assert-Startup ($code -eq 0 -and $started -eq 1 -and $stopped -eq 0 -and $child.Disposed -and $pulses -eq 2) 'Success must preserve exit code, pump events, and release the process handle.'

Reset-Case 'error' 17
$code = Invoke-StartupProcess @arguments
Assert-Startup ($code -eq 17 -and $stopped -eq 0 -and $child.Disposed) 'A failed command must retain its exit code for the caller.'

Reset-Case 'hung'
$arguments.TimeoutSeconds = 0
try { Invoke-StartupProcess @arguments; throw 'missing timeout' } catch { Assert-Startup ($_.Exception.Message -eq 'deadline reached') 'Timeout must report its phase-specific reason.' }
Assert-Startup ($stopped -eq 1 -and $child.HasExited -and $child.Disposed) 'Timeout must stop only its child and release the handle.'

Reset-Case 'hung'
$arguments.TimeoutSeconds = 1
try {
  Invoke-StartupProcess @arguments -Pulse { $script:pulses++; if ($script:pulses -eq 2) { throw [System.OperationCanceledException]::new('cancelled') } }
  throw 'missing cancellation'
} catch { Assert-Startup ($_.Exception -is [System.OperationCanceledException]) 'Cancellation must keep its exception type.' }
Assert-Startup ($stopped -eq 1 -and $child.Disposed) 'Cancelling a running step must stop its process.'

Reset-Case 'success'
try { Invoke-StartupProcess @arguments -Pulse { throw [System.OperationCanceledException]::new('cancelled') }; throw 'missing cancellation' } catch { Assert-Startup ($_.Exception -is [System.OperationCanceledException]) 'Cancellation before launch must propagate.' }
Assert-Startup ($started -eq 0 -and $stopped -eq 0) 'Pre-cancelled steps must not start or kill anything.'

Write-Output '5 startup process checks passed; no real process or window was started.'
