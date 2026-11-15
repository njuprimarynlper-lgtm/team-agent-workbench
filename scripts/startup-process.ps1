# Process helpers only: loading this file never launches a process or a window.
if (-not ('TeamAgentBoundedCapture' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.Collections.Generic;
using System.Threading.Tasks;
public static class TeamAgentBoundedCapture {
  public static Task Capture(StreamReader reader, string file) {
    return Task.Run(() => {
      var buffer = new char[4096]; var tail = new Queue<byte[]>();
      long total = 0; int prefix = 0, tailSize = 0;
      using (var output = new FileStream(file, FileMode.Create, FileAccess.Write, FileShare.ReadWrite)) {
        int read;
        while ((read = reader.Read(buffer, 0, buffer.Length)) > 0) {
          var bytes = Encoding.UTF8.GetBytes(buffer, 0, read); total += bytes.Length;
          if (prefix < 1048576) { int n = Math.Min(bytes.Length, 1048576 - prefix); output.Write(bytes, 0, n); prefix += n; output.Flush(); }
          else { tail.Enqueue(bytes); tailSize += bytes.Length; while (tailSize > 524288 && tail.Count > 0) tailSize -= tail.Dequeue().Length; }
        }
        if (total > prefix) {
          var note = Encoding.UTF8.GetBytes("\n[Startup output bounded; skipped bytes: " + (total - prefix - tailSize) + "]\n"); output.Write(note, 0, note.Length);
          foreach (var bytes in tail) output.Write(bytes, 0, bytes.Length);
        }
      }
    });
  }
}
'@
}
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
  $startInfo = New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName = $File
  $startInfo.Arguments = $Arguments -join ' '
  if ($File -match '\.(cmd|bat)$') {
    $startInfo.FileName = "$env:SystemRoot\System32\cmd.exe"
    $startInfo.Arguments = '/d /s /c ""' + $File + '" ' + ($Arguments -join ' ') + '"'
  }
  $startInfo.WorkingDirectory = $Directory
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  $startInfo.StandardOutputEncoding = [System.Text.UTF8Encoding]::new($false)
  $startInfo.StandardErrorEncoding = [System.Text.UTF8Encoding]::new($false)
  $child = New-Object System.Diagnostics.Process
  $child.StartInfo = $startInfo
  [void]$child.Start()
  $stdoutCapture = [TeamAgentBoundedCapture]::Capture($child.StandardOutput, $Output)
  $stderrCapture = [TeamAgentBoundedCapture]::Capture($child.StandardError, $Errors)
  $childHandle = $child.Handle # Retain the handle for ExitCode on Windows PowerShell 5.
  $elapsed = [System.Diagnostics.Stopwatch]::StartNew()
  try {
    while (-not $child.WaitForExit(200)) {
      & $Pulse
      if ($elapsed.Elapsed.TotalSeconds -ge $TimeoutSeconds) { throw $TimeoutMessage }
    }
    & $Pulse
    $stdoutCapture.GetAwaiter().GetResult()
    $stderrCapture.GetAwaiter().GetResult()
    return $child.ExitCode
  } catch {
    Stop-StartupProcessTree $child
    throw
  } finally {
    $elapsed.Stop()
    $child.Dispose()
  }
}
