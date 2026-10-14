param(
    [Parameter(Mandatory = $true)]
    [string] $EnginePath,
    [switch] $Release
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$playerRoot = Join-Path $repoRoot 'player'
$engineRoot = (Resolve-Path -LiteralPath $EnginePath).Path
$builder = Join-Path $engineRoot 'hzbuild.exe'
if (!(Test-Path -LiteralPath $builder -PathType Leaf)) {
    throw "No hzbuild.exe in $engineRoot. Install the engine version in player/hzproject.hzt first."
}
$engineLink = Join-Path $playerRoot 'hz'
if (Test-Path -LiteralPath $engineLink) {
    $existing = Get-Item -LiteralPath $engineLink
    if (!$existing.Target -or [IO.Path]::GetFullPath([string]$existing.Target) -ne $engineRoot) {
        throw "player/hz already exists and points elsewhere. Move it aside before selecting another engine."
    }
} else {
    New-Item -ItemType Junction -Path $engineLink -Target $engineRoot | Out-Null
}
Push-Location $repoRoot
try {
    & npm.cmd ci
    if ($LASTEXITCODE -ne 0) { throw 'npm ci failed' }
    & npm.cmd run typecheck
    if ($LASTEXITCODE -ne 0) { throw 'TypeScript checks failed' }
    & npm.cmd test
    if ($LASTEXITCODE -ne 0) { throw 'Runtime tests failed' }
} finally { Pop-Location }
Push-Location $playerRoot
try {
    $buildArgs = @('windows')
    if ($Release) { $buildArgs += '--release' }
    & $builder @buildArgs
    if ($LASTEXITCODE -ne 0) { throw 'Windows player build failed' }
} finally { Pop-Location }
Write-Output 'Windows build ready. Configure .env and a character model as described in docs/windows.md.'
