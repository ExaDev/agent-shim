# Runs the door's own dial against a loopback listener through the built binary, on the platform it was built for.
# `doctor` probes every http provider's base URL with that dial: from a reserved source port, for a name such as `localhost`.
# A provider on a listener that is up must not be reported unreachable, and one on a port nothing listens on must be, so the probe
# is shown to have run and not skipped. Windows refuses a bind inside an excluded port range, which only this run can show.
param(
  [Parameter(Mandatory = $true)][string]$Binary
)

$ErrorActionPreference = 'Stop'
$Binary = (Resolve-Path $Binary).Path

$root = Join-Path ([System.IO.Path]::GetTempPath()) ("agent-shim-dial-smoke-" + [System.Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $root | Out-Null
$env:AGENT_SHIM_HOME = $root

$live = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
$closed = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
try {
  $live.Start()
  $closed.Start()
  $livePort = $live.LocalEndpoint.Port
  $closedPort = $closed.LocalEndpoint.Port
  $closed.Stop()

  foreach ($entry in @(@('smoke-live', $livePort), @('smoke-closed', $closedPort))) {
    & $Binary provider add $entry[0] --kind http --display-name $entry[0] --base-url "http://localhost:$($entry[1])" --credential literal:smoke | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "provider add $($entry[0]) exited $LASTEXITCODE" }
  }

  # doctor exits non-zero for findings unrelated to a runner (no Claude Code installed), so its findings are read, not its status.
  $report = (& $Binary doctor --json) | ConvertFrom-Json
  $failed = @($report.findings | Where-Object { $_.section -eq 'provider' -and $_.severity -eq 'fail' })

  if (@($failed | Where-Object { $_.subject -eq 'smoke-live' }).Count -ne 0) {
    throw ('the dial could not reach a loopback listener that is up: ' + (($failed | Where-Object { $_.subject -eq 'smoke-live' } | ForEach-Object { $_.message }) -join '; '))
  }
  if (@($failed | Where-Object { $_.subject -eq 'smoke-closed' }).Count -eq 0) {
    throw 'doctor did not probe the providers: a port nothing listens on was not reported unreachable'
  }
  Write-Host 'the dial reached the loopback listener, and reported the closed port unreachable'
}
finally {
  $live.Stop()
  $closed.Stop()
  Remove-Item -Recurse -Force $root -ErrorAction SilentlyContinue
}
