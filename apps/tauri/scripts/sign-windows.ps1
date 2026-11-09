<#
.SYNOPSIS
  Authenticode-sign one or more Windows binaries for the Lynse release pipeline.

.DESCRIPTION
  Called from two places:

    * Tauri's `bundle.windows.signCommand` (one file per call; the literal
      `%1` token is replaced by Tauri with the binary path as a single argv
      element). This signs the main exe and the MSI *while `tauri build` is
      still running*, which is mandatory: the minisign updater .sig is
      generated from the MSI afterwards, so re-signing the MSI post-build
      would silently invalidate every in-app update.
    * The release workflow's "Authenticode-sign Windows STT sidecars" step
      (all .exe/.dll under resources/sidecars in a single call). Those
      binaries live in the on-demand runtime archive, not in the MSI, so
      Tauri never sees them.

  Backends, selected by environment variable:

    LYNSE_WINDOWS_SIGN_MODE = auto (default) | pfx | command | off

    LYNSE_WINDOWS_SIGN_COMMAND   Command template for a cloud-HSM / key-vault
                                 signer. `{file}` (or "{file}") is replaced
                                 with the quoted absolute path. The template
                                 is evaluated by PowerShell, so $env:SECRET
                                 references work (quote them, e.g.
                                 "$env:MY_SECRET", if the value may contain
                                 spaces). Use this for AzureSignTool,
                                 SSL.com CodeSignTool, DigiCert KeyLocker,
                                 artifact-signing-cli, etc.
    WINDOWS_CERTIFICATE          Base64 .pfx, used by the built-in pfx
    WINDOWS_CERTIFICATE_PASSWORD backend. Imported into the per-user store so
                                 the password never appears on a signtool
                                 command line. Intended for self-signed
                                 rehearsal / legacy certificates: since June
                                 2023 public CAs may no longer issue
                                 exportable code-signing .pfx files.
    WINDOWS_CERTIFICATE_THUMBPRINT  Optional. Lets a caller that already
                                 imported the PFX skip the import here.
    WINDOWS_TIMESTAMP_URL        RFC3161 timestamp server for the pfx backend
                                 (default http://timestamp.digicert.com).
    LYNSE_REQUIRE_WINDOWS_SIGNING=1  Fail instead of warning when no
                                 credentials are configured.

  When no credentials are configured the script warns and exits 0, preserving
  the unsigned build (mirrors the macOS APPLE_* opt-in behaviour in CI).
  Once credentials ARE configured, any signing failure is a hard error.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true, Position = 0)]
  [string[]] $Files,
  [switch] $Verify
)

$ErrorActionPreference = 'Stop'

function Fail([string] $Message) { throw $Message }

function Warn([string] $Message) {
  Write-Warning $Message
  if ($env:GITHUB_ACTIONS -eq 'true') {
    Write-Host "::warning::$Message"
  }
}

$template   = $env:LYNSE_WINDOWS_SIGN_COMMAND
$pfxB64     = $env:WINDOWS_CERTIFICATE
$pfxPass    = $env:WINDOWS_CERTIFICATE_PASSWORD
$require    = ($env:LYNSE_REQUIRE_WINDOWS_SIGNING -eq '1')
$mode       = $env:LYNSE_WINDOWS_SIGN_MODE

if ([string]::IsNullOrWhiteSpace($mode) -or $mode -eq 'auto') {
  if ($template)                    { $mode = 'command' }
  elseif ($pfxB64 -and $pfxPass)    { $mode = 'pfx' }
  else                              { $mode = 'off' }
}

if ($mode -eq 'off') {
  $msg = 'No Windows code-signing credentials configured; shipping UNSIGNED binaries (Windows 11 Smart App Control / SmartScreen will warn).'
  if ($require) { Fail "LYNSE_REQUIRE_WINDOWS_SIGNING=1 but $msg" }
  Warn $msg
  exit 0
}

if ($mode -notin @('pfx', 'command')) {
  Fail "Unknown LYNSE_WINDOWS_SIGN_MODE '$mode' (expected auto|pfx|command|off)"
}
if ($mode -eq 'command' -and $template -notmatch '\{file\}') {
  Fail 'LYNSE_WINDOWS_SIGN_COMMAND must contain a {file} placeholder'
}

# Resolve signtool once per invocation. Tauri already knows where it lives,
# but the sidecar-signing step calls this script standalone.
$signtool = $null
if ($env:TAURI_WINDOWS_SIGNTOOL_PATH -and (Test-Path -LiteralPath $env:TAURI_WINDOWS_SIGNTOOL_PATH)) {
  $signtool = $env:TAURI_WINDOWS_SIGNTOOL_PATH
}
if (-not $signtool) {
  $found = Get-Command 'signtool.exe' -ErrorAction SilentlyContinue
  if ($found) { $signtool = $found.Source }
}
if (-not $signtool) {
  $kitsRoot = (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows Kits\Installed Roots' -Name KitsRoot10 -ErrorAction SilentlyContinue).KitsRoot10
  if ($kitsRoot) {
    $signtool = Get-ChildItem -Path (Join-Path $kitsRoot 'bin') -Filter 'signtool.exe' -Recurse -File -ErrorAction SilentlyContinue |
      Where-Object { $_.FullName -like '*\x64\*' } |
      Sort-Object FullName -Descending |
      Select-Object -First 1 -ExpandProperty FullName
  }
}

# pfx backend: import once, then sign by thumbprint so no password ever
# reaches a command line (which would be visible to other processes).
$thumbprint    = $env:WINDOWS_CERTIFICATE_THUMBPRINT
$timestampUrl  = $env:WINDOWS_TIMESTAMP_URL
if (-not $timestampUrl) { $timestampUrl = 'http://timestamp.digicert.com' }

if ($mode -eq 'pfx') {
  if (-not $signtool)   { Fail 'pfx backend needs signtool.exe (Windows SDK)' }
  if (-not $pfxB64 -or -not $pfxPass) {
    Fail 'pfx backend needs WINDOWS_CERTIFICATE and WINDOWS_CERTIFICATE_PASSWORD'
  }
  if (-not $thumbprint) {
    $tmpDir = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { [IO.Path]::GetTempPath() }
    $pfxPath = Join-Path $tmpDir 'lynse-codesign.pfx'
    try {
      [IO.File]::WriteAllBytes($pfxPath, [Convert]::FromBase64String(($pfxB64 -replace '\s', '')))
      # Use the .NET API instead of Import-PfxCertificate: the PKIClient
      # cmdlet is not guaranteed to be available in PowerShell 7 on Windows.
      $flags = [System.Security.Cryptography.X509Certificates.X509KeyStorageFlags]::PersistKeySet
      $cert = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new($pfxPath, $pfxPass, $flags)
      $store = [System.Security.Cryptography.X509Certificates.X509Store]::new('My', 'CurrentUser')
      try {
        $store.Open('ReadWrite')
        $store.Add($cert)
      }
      finally { $store.Close() }
      $thumbprint = $cert.Thumbprint
    }
    finally {
      Remove-Item -LiteralPath $pfxPath -Force -ErrorAction SilentlyContinue
    }
  }
}

function Invoke-Sign([string] $File) {
  $full = (Resolve-Path -LiteralPath $File).Path

  switch ($mode) {
    'pfx' {
      & $signtool sign /fd SHA256 /sha1 $thumbprint /tr $timestampUrl /td SHA256 /d 'Lynse' $full
      if ($LASTEXITCODE -ne 0) { Fail "signtool failed for $full (exit $LASTEXITCODE)" }
    }
    'command' {
      # Accept both {file} and "{file}" in the template; always emit a quoted
      # absolute path. Never echo $text: it may contain expanded credentials.
      $quoted = '"' + $full + '"'
      $text = $template.Replace('"{file}"', $quoted).Replace('{file}', $quoted)
      # $LASTEXITCODE is $null until a native process runs; $null -ne 0 would
      # otherwise be reported as a failure for a pure-PowerShell template.
      $global:LASTEXITCODE = 0
      Invoke-Expression -Command $text | Out-Host
      if ($LASTEXITCODE -ne 0) { Fail "custom sign command failed for $full (exit $LASTEXITCODE)" }
    }
  }

  if ($Verify) {
    $sig = Get-AuthenticodeSignature -FilePath $full
    # Do not require Status == Valid here: a self-signed rehearsal certificate
    # has an untrusted root but still carries a real signature.
    if ($sig.Status -eq 'NotSigned' -or -not $sig.SignerCertificate) {
      Fail "No Authenticode signature on $full after signing (status $($sig.Status))"
    }
    Write-Host "signed: $full [$($sig.Status)] $($sig.SignerCertificate.Subject)"
  }
}

foreach ($file in $Files) {
  # Tauri's WiX bundler signs its own Wix*Extension.dll build helpers too.
  # They never ship to users, and signing them burns cloud-HSM calls / hits
  # per-signature quotas. try_sign only checks our exit code, so skipping is
  # safe. Keep this narrow: only Wix*.dll under a `wix` build directory.
  $leaf = [IO.Path]::GetFileName($file)
  if ($file -match '[\\/]wix[\\/]' -and $leaf -match '^Wix.*\.dll$') {
    Write-Host "skip WiX build-tool DLL: $file"
    continue
  }
  Invoke-Sign $file
}
