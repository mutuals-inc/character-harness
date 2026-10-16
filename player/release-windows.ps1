#Requires -Version 5.1
<#
.SYNOPSIS
Build the Windows player and attach its portable ZIP and checksums to a draft GitHub release.
.EXAMPLE
.\player\release-windows.ps1 v0.1.0-windows-x64 -NoRelease
.EXAMPLE
.\player\release-windows.ps1 v0.1.0-windows-x64
.EXAMPLE
.\player\release-windows.ps1 v0.1.0-windows-x64 -NoRelease -AllowDirty
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [ValidatePattern('^v[0-9]+\.[0-9]+\.[0-9]+-windows-x64$')]
    [string] $Tag,
    [switch] $NoRelease,
    # Local previews only: package the working tree without requiring a tag.
    [switch] $AllowDirty
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
if ($env:OS -ne 'Windows_NT') { throw 'Run this script on Windows.' }
if ($AllowDirty -and -not $NoRelease) { throw '-AllowDirty requires -NoRelease.' }

function Invoke-Checked {
    param([string] $Command, [string[]] $Arguments)
    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$Command failed (exit $LASTEXITCODE)."
    }
}

function Remove-PlayerOutput {
    param([string] $RelativePath)
    $target = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot $RelativePath))
    $playerRoot = [IO.Path]::GetFullPath($PSScriptRoot).TrimEnd('\', '/') + '\'
    if (-not $target.StartsWith($playerRoot, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to remove a path outside player: $target"
    }
    if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
}

Push-Location $PSScriptRoot
try {
    $repoRoot = (Invoke-Checked git @('rev-parse', '--show-toplevel')).Trim()
    $commit = (Invoke-Checked git @('rev-parse', 'HEAD')).Trim()
    if (-not $AllowDirty) {
        $changes = @(Invoke-Checked git @('-C', $repoRoot, 'status', '--porcelain'))
        if ($changes.Count) { throw "The tree has changes; release from a clean checkout of $Tag. For a local preview, use -NoRelease -AllowDirty." }
        $tagCommit = (Invoke-Checked git @('rev-parse', '--verify', "refs/tags/$Tag^{commit}")).Trim()
        if ($tagCommit -ne $commit) { throw "HEAD is not $Tag; check out that tag first." }
    }
    if (-not $NoRelease) {
        $null = Get-Command gh -ErrorAction Stop
        $remoteTags = @(Invoke-Checked git @('ls-remote', '--tags', 'origin', "refs/tags/$Tag", "refs/tags/$Tag^{}"))
        $peeled = @($remoteTags | Where-Object { $_ -match '\^\{\}$' })
        $remoteCommit = if ($peeled.Count) { ($peeled[0] -split '\s+')[0] }
            elseif ($remoteTags.Count) { ($remoteTags[0] -split '\s+')[0] } else { '' }
        if ($remoteCommit -ne $commit) { throw "$Tag on origin is not this commit; push the tag first." }
    }

    $builder = Join-Path $PSScriptRoot 'hz\hzbuild.exe'
    if (-not (Test-Path -LiteralPath $builder)) { throw 'player/hz is missing; run kaigen restore from player first.' }
    if (-not (Test-Path -LiteralPath 'hz\tools\brotli\brotli.exe')) {
        throw 'The linked Kaigen SDK is missing tools/brotli/brotli.exe, required by publish. Repair the SDK installation or obtain the missing build tool from Kaigen, then retry.'
    }

    $projectPath = Join-Path $PSScriptRoot 'hzproject.hzt'
    $projectBytes = [IO.File]::ReadAllBytes($projectPath)
    $projectText = [IO.File]::ReadAllText($projectPath)
    $version = $Tag.Substring(1) -replace '-windows-x64$', ''
    $versionPattern = [regex]::new('(?m)^(  version )[^\r\n]*')
    if ($versionPattern.Matches($projectText).Count -ne 1) { throw 'hzproject.hzt: expected one publish version line.' }
    $engineMatch = [regex]::Match($projectText, '(?m)^engine_version ([^\r\n]+)')
    $engineVersion = $engineMatch.Groups[1].Value
    $previousCompilerOptions = [Environment]::GetEnvironmentVariable('_CL_', 'Process')
    try {
        $releaseProject = $versionPattern.Replace($projectText, "`${1}$version")
        [IO.File]::WriteAllText($projectPath, $releaseProject, [Text.UTF8Encoding]::new($false))
        # Imported personal models and stale publish files must not ship.
        Remove-PlayerOutput 'cooked\vrm'
        Remove-PlayerOutput 'out\windows\publish'
        $null = New-Item -ItemType Directory -Path 'out\windows\compiler' -Force
        # _CL_ appends MSVC options; keep compiler PDBs out of the project root.
        [Environment]::SetEnvironmentVariable('_CL_',
            ($previousCompilerOptions + ' /Fd"out\windows\compiler\vc.pdb"').Trim(), 'Process')
        Invoke-Checked $builder @('windows', 'publish')
    }
    finally {
        if ($null -eq $previousCompilerOptions) {
            [Environment]::SetEnvironmentVariable('_CL_', [NullString]::Value, 'Process')
        }
        else {
            [Environment]::SetEnvironmentVariable('_CL_', $previousCompilerOptions, 'Process')
        }
        [IO.File]::WriteAllBytes($projectPath, $projectBytes)
    }

    $publishRoot = Join-Path $PSScriptRoot 'out\windows\publish'
    $executables = @(Get-ChildItem -LiteralPath $publishRoot -Filter '*.exe' -Recurse -File |
        Where-Object { $_.Directory.Parent.FullName -eq $publishRoot })
    if ($executables.Count -ne 1) { throw 'The publish build did not produce exactly one player executable in out/windows/publish/<project>.' }
    $exe = $executables[0]
    $bundle = $exe.Directory.FullName
    $output = Join-Path $PSScriptRoot 'out\release\windows-x64'
    $packageName = "character-player-$version-windows-x64"
    Remove-PlayerOutput 'out\release\windows-x64'
    $stage = Join-Path $output $packageName
    $null = New-Item -ItemType Directory -Path $stage -Force
    # Publish can leave linker intermediates beside the app; never distribute them.
    Get-ChildItem -LiteralPath $bundle -Force | Where-Object {
        $_.Name -ne 'obj' -and $_.Extension -notin @('.pdb', '.lib', '.exp', '.ilk')
    } | ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $stage -Recurse }
    # Include external assets when the SDK's publish output contains only the EXE.
    if (-not (Test-Path -LiteralPath (Join-Path $stage 'cooked\catalog.hza'))) {
        $cookedRoot = Join-Path $PSScriptRoot 'cooked'
        if (-not (Test-Path -LiteralPath (Join-Path $cookedRoot 'catalog.hza'))) {
            throw 'The publish build did not produce cooked/catalog.hza; refusing to package an incomplete player.'
        }
        Get-ChildItem -LiteralPath $cookedRoot -Recurse -File | Where-Object {
            $_.Extension -ne '.br'
        } | ForEach-Object {
            $relative = $_.FullName.Substring($cookedRoot.Length).TrimStart('\', '/')
            $destination = Join-Path (Join-Path $stage 'cooked') $relative
            $null = New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($destination)) -Force
            Copy-Item -LiteralPath $_.FullName -Destination $destination
        }
    }
    Copy-Item -LiteralPath (Join-Path $repoRoot 'LICENSE') -Destination (Join-Path $stage 'LICENSE.txt')
    Copy-Item -LiteralPath (Join-Path $repoRoot 'NOTICE') -Destination (Join-Path $stage 'NOTICE.txt')
    Copy-Item -LiteralPath 'assets\vad\LICENSE' -Destination (Join-Path $stage 'LICENSE-silero-vad.txt')
    $readme = @"
Character Player $version - Windows x64

Keep this entire folder together, including any cooked/ assets and DLLs.
This is the player, not the Node conversation runtime. No Kaigen installation
or licence is needed to run it.

From a matching character-harness source checkout:
  npm.cmd ci --omit=dev
  Copy-Item .env.example .env

Add your XAI_API_KEY and ELEVENLABS_API_KEY to .env, then set:
  HARNESS_PLAYER='"C:/path/to/$packageName/$($exe.Name)"'

From the harness root run:
  npm.cmd start

Allow microphone access for desktop apps in Windows Settings and speak first.
This build is unsigned; Windows may show a publisher warning.
Built from $Tag ($commit), Kaigen $engineVersion.
"@
    [IO.File]::WriteAllText((Join-Path $stage 'README.txt'), $readme, [Text.UTF8Encoding]::new($false))
    $zip = Join-Path $output "$packageName.zip"
    Compress-Archive -LiteralPath $stage -DestinationPath $zip -CompressionLevel Optimal
    $checksum = Join-Path $output 'SHA256SUMS-windows-x64'
    $sumLines = @($zip) | ForEach-Object {
        "$((Get-FileHash -LiteralPath $_ -Algorithm SHA256).Hash.ToLowerInvariant())  $([IO.Path]::GetFileName($_))"
    }
    [IO.File]::WriteAllText($checksum, (($sumLines -join "`n") + "`n"), [Text.UTF8Encoding]::new($false))
    Write-Host "Player executable: $(Join-Path $stage $exe.Name)"
    Write-Host "Portable ZIP: $zip"
    $sumLines | ForEach-Object { Write-Host $_ }
    if ($NoRelease) { Write-Host 'Local build complete; no GitHub release created.'; return }

    $notes = Join-Path $output 'notes.md'
    $sourceUrl = "https://github.com/mutuals-inc/character-harness/blob/$Tag"
    $releaseNotes = @"
Windows x64 player v$version (unsigned). Download and extract **$packageName.zip**.
Keep its executable, cooked assets and any DLLs together. The compiled engine
and FoxGlove model and animations are included; no Kaigen installation or licence is required.

### Run the full harness

1. Install Node.js 24 or later and download this tag's **Source code (zip)**.
2. Extract the source, open PowerShell in its root (beside package.json), and run ``npm.cmd ci --omit=dev``.
3. Copy ``.env.example`` to ``.env`` and add your own ``XAI_API_KEY`` and ``ELEVENLABS_API_KEY``.
4. Set ``HARNESS_PLAYER`` in ``.env`` to the extracted player's path, preserving both quote levels:

``````dotenv
HARNESS_PLAYER='"C:/Users/you/Apps/$packageName/$($exe.Name)"'
``````

5. Run ``npm.cmd run check -- characters/foxglove``, then ``npm.cmd start`` from the harness root.
   The runtime opens the player automatically. Allow desktop microphone access in Windows Settings and **speak first**.

The player alone does not run the conversation; Node and provider API keys are required.
FoxGlove needs no additional animation setup. Provider usage is billed to your accounts.
For startup problems, read PowerShell output and ``.cache/player.log``.

See the [harness quickstart]($sourceUrl/README.md#quickstart),
[Windows installation guide]($sourceUrl/player/README.md#install-a-release-windows),
[custom character guide]($sourceUrl/docs/bring-your-own-character.md), and
[architecture]($sourceUrl/docs/architecture.md).

Verify the ZIP using ``Get-FileHash -Algorithm SHA256`` and ``SHA256SUMS-windows-x64``.
Built from $Tag ($commit), Kaigen $engineVersion.

SHA-256:
``````text
$($sumLines -join "`n")
``````
"@
    [IO.File]::WriteAllText($notes, $releaseNotes, [Text.UTF8Encoding]::new($false))
    # A rerun may add missing assets to this platform's draft.
    $releases = Invoke-Checked gh @('release', 'list', '--limit', '1000', '--json', 'tagName,isDraft') | ConvertFrom-Json
    $existing = @($releases | Where-Object { $_.tagName -eq $Tag })
    if ($existing.Count) {
        if (-not $existing[0].isDraft) { throw 'This release is already public; refusing to change it.' }
        Invoke-Checked gh @('release', 'upload', $Tag, $zip, $checksum)
    }
    else {
        Invoke-Checked gh @('release', 'create', $Tag, '--draft', '--verify-tag', '--title', "v$version - Windows x64", '--notes-file', $notes, $zip, $checksum)
    }
    Write-Host "Draft release $Tag updated; review it on GitHub before publishing."
}
finally {
    Pop-Location
}
