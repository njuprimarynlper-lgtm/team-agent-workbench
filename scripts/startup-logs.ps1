# Shared startup staging and offline collection. Never reads account databases,
# native authentication, conversation files or arbitrary folders.
function Get-WorkbenchLogRoot([string]$Edition) {
  $root = if ($Edition -eq 'user') { $env:WORKBENCH_DATA_DIR } else { $env:WORKBENCH_ADMIN_DATA_DIR }
  if (-not $root) { $root = Join-Path $env:APPDATA $(if ($Edition -eq 'user') { 'TeamAgentUser' } else { 'TeamAgentAdmin' }) }
  return [IO.Path]::GetFullPath($root)
}
function Limit-StartupLogs([string]$Directory) {
  $resolvedRoot = [IO.Path]::GetFullPath($Directory)
  if (-not (Test-Path -LiteralPath $resolvedRoot)) { return }
  $files = @(Get-ChildItem -LiteralPath $resolvedRoot -File | Where-Object { $_.Name -match '^(user|admin)-\d{8}-\d{6}-\d{3}-\d+(?:-[\w-]+)?\.(log|out|err)$' } | Sort-Object LastWriteTime)
  [long]$total = ($files | Measure-Object Length -Sum).Sum
  foreach ($file in $files) {
    if ($file.FullName.StartsWith($resolvedRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -and ($file.LastWriteTime -lt (Get-Date).AddDays(-14) -or $total -gt 4MB)) {
      try { Remove-Item -LiteralPath $file.FullName -Force -ErrorAction Stop; $total -= $file.Length } catch { }
    }
  }
}
function Export-StartupDiagnostics([string]$Edition, [string]$Destination, [string]$LegacyDirectory = '') {
  Add-Type -AssemblyName System.IO.Compression
  $root = Get-WorkbenchLogRoot $Edition
  $output = [IO.File]::Open($Destination, [IO.FileMode]::CreateNew)
  $archive = New-Object IO.Compression.ZipArchive($output, [IO.Compression.ZipArchiveMode]::Create, $false)
  try {
    $sources = @((Join-Path $root 'logs\startup'))
    if ($LegacyDirectory) { $sources += $LegacyDirectory }
    $included = 0
    foreach ($directory in $sources) {
      if (-not (Test-Path -LiteralPath $directory)) { continue }
      foreach ($file in @(Get-ChildItem -LiteralPath $directory -File | Where-Object { $_.Name -match ('^' + $Edition + '-\d{8}-\d{6}-\d{3}-\d+(?:-[\w-]+)?\.(log|out|err)$') } | Sort-Object LastWriteTime -Descending | Select-Object -First 16)) {
        if ($file.Attributes -band [IO.FileAttributes]::ReparsePoint) { continue }
        $stream = New-Object IO.FileStream($file.FullName, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
        try {
          if ($stream.Length -gt 65536) { [void]$stream.Seek(-65536, [IO.SeekOrigin]::End) }
          $reader = New-Object IO.StreamReader($stream, [Text.Encoding]::UTF8)
          $text = $reader.ReadToEnd()
          $text = $text -replace 'TAE[12]\.[A-Za-z0-9_-]+','[access code]' -replace '(?i)Bearer\s+[^\s"'',;]+','Bearer [redacted]' -replace '(?i)((password|passwd|passphrase|access[_-]?code|api[_-]?key|token|secret|cookie)["'']?\s*[:=]\s*)[^\s,;]+','$1[redacted]' -replace 'https?://[^\s"'']+','[URL]' -replace 'sk-[A-Za-z0-9_-]{12,}','[token]'
          $entry = $archive.CreateEntry('startup/' + $included + '-' + $file.Name)
          $writer = New-Object IO.StreamWriter($entry.Open(), [Text.UTF8Encoding]::new($false)); try { $writer.Write($text) } finally { $writer.Dispose() }
          $included++
        } finally { $stream.Dispose() }
      }
    }
    $runtimeEntry = $archive.CreateEntry('diagnostic.jsonl')
    $runtimeWriter = New-Object IO.StreamWriter($runtimeEntry.Open(), [Text.UTF8Encoding]::new($false))
    $runtimeCount = 0
    try {
      $logDirectory = Join-Path $root 'logs'
      if (Test-Path -LiteralPath $logDirectory) {
        foreach ($file in @(Get-ChildItem -LiteralPath $logDirectory -File | Where-Object { $_.Name -match '^diagnostic-\d{13}-[a-f0-9-]+\.jsonl(\.gz)?$' } | Sort-Object LastWriteTime -Descending)) {
          if ($file.Attributes -band [IO.FileAttributes]::ReparsePoint) { continue }
          $raw = New-Object IO.FileStream($file.FullName, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
          $stream = $raw
          try {
            if ($file.Extension -eq '.gz') { $stream = New-Object IO.Compression.GZipStream($raw, [IO.Compression.CompressionMode]::Decompress) }
            $reader = New-Object IO.StreamReader($stream, [Text.Encoding]::UTF8)
            while (($line = $reader.ReadLine()) -ne $null) {
              try { $row = $line | ConvertFrom-Json -ErrorAction Stop } catch { continue }
              # An offline collector has no verified current team account. Only
              # global startup/crash diagnostics may leave the machine here.
              if ($row.schema -ne 1 -or $row.category -ne 'diagnostic' -or $row.account) { continue }
              $safe = @{schema=1; at=$row.at; version=$row.version; instance=$row.instance; category='diagnostic'; name=$row.name; code=$row.code; outcome=$row.outcome; detail=$row.detail; stack=$row.stack}
              $runtimeWriter.WriteLine(($safe | ConvertTo-Json -Compress)); $runtimeCount++
            }
          } catch { } finally { $stream.Dispose(); $raw.Dispose() }
        }
      }
    } finally { $runtimeWriter.Dispose() }
    $entry = $archive.CreateEntry('report.json'); $writer = New-Object IO.StreamWriter($entry.Open(), [Text.UTF8Encoding]::new($false))
    try { $writer.Write((@{ schemaVersion=1; kind='diagnostic'; source='startup-offline'; exportedAt=(Get-Date).ToUniversalTime().ToString('o'); edition=$Edition; files=$included; runtimeRecords=$runtimeCount; coverage='Global startup/crash report; at most 16 startup files per source and 64 KiB per file. No conversation, credentials or account-level records included. Use the application for account-scoped runtime diagnostics.' } | ConvertTo-Json)) } finally { $writer.Dispose() }
  } finally { $archive.Dispose(); $output.Dispose() }
}
