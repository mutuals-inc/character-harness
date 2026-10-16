#Requires -Version 5.1
<#
.SYNOPSIS
Supply the Brotli build tool omitted by early Windows Kaigen SDK drops.
#>
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'Run this script on Windows.' }
$sdkRoot = Join-Path $PSScriptRoot 'hz'
if (-not (Test-Path -LiteralPath (Join-Path $sdkRoot 'hzsdk.hzt'))) {
    throw 'A binary Kaigen SDK must be linked at player/hz; run kaigen restore first.'
}
$toolRoot = Join-Path $sdkRoot 'tools\brotli'
$toolExe = Join-Path $toolRoot 'brotli.exe'
$compressorSource = @'
const fs = require('node:fs');
const path = require('node:path');
const { parseArgs } = require('node:util');
const { brotliCompressSync, constants } = require('node:zlib');
try {
  const { values } = parseArgs({ options: {
    input: { type: 'string' }, output: { type: 'string' },
    quality: { type: 'string', default: '11' }, force: { type: 'boolean', default: false },
  }});
  const quality = Number(values.quality);
  if (!values.input || !values.output || !Number.isInteger(quality) || quality < 0 || quality > 11)
    throw new Error('usage: brotli --input FILE --output FILE [--quality 0..11] [--force]');
  if (path.resolve(values.input).toLowerCase() === path.resolve(values.output).toLowerCase())
    throw new Error('input and output must be different files');
  const compressed = brotliCompressSync(fs.readFileSync(values.input), {
    params: { [constants.BROTLI_PARAM_QUALITY]: quality },
  });
  fs.writeFileSync(values.output, compressed, { flag: values.force ? 'w' : 'wx' });
} catch (error) { console.error(`brotli: ${error.message}`); process.exitCode = 1; }
'@
$launcherSource = @'
using System;
using System.Diagnostics;
using System.IO;
using System.Text;
internal static class BrotliLauncher {
    private static string Quote(string value) {
        var result = new StringBuilder("\"");
        int slashes = 0;
        foreach (char c in value) {
            if (c == '\\') { slashes++; continue; }
            result.Append('\\', c == '"' ? slashes * 2 + 1 : slashes);
            result.Append(c);
            slashes = 0;
        }
        result.Append('\\', slashes * 2);
        return result.Append('"').ToString();
    }
    private static int Main(string[] args) {
        try {
            string root = AppDomain.CurrentDomain.BaseDirectory;
            var arguments = new StringBuilder(Quote(Path.Combine(root, "brotli.cjs")));
            foreach (string argument in args) arguments.Append(' ').Append(Quote(argument));
            var start = new ProcessStartInfo {
                FileName = File.ReadAllText(Path.Combine(root, "node-path.txt")).Trim(),
                Arguments = arguments.ToString(), UseShellExecute = false, CreateNoWindow = true
            };
            using (Process child = Process.Start(start)) { child.WaitForExit(); return child.ExitCode; }
        } catch (Exception error) { Console.Error.WriteLine("brotli: " + error.Message); return 1; }
    }
}
'@
if ((Test-Path -LiteralPath $toolExe) -and -not (Test-Path -LiteralPath (Join-Path $toolRoot 'brotli.cjs'))) {
    Write-Host 'The SDK already has a Brotli tool; leaving it unchanged.'
    return
}
$node = (Get-Command node.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
if (Test-Path -LiteralPath $toolExe) {
    [IO.File]::WriteAllText((Join-Path $toolRoot 'brotli.cjs'), $compressorSource, [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText((Join-Path $toolRoot 'node-path.txt'), $node, [Text.UTF8Encoding]::new($false))
    Write-Host 'Refreshed the existing Node-backed Brotli adapter.'
    return
}
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $compiler)) { throw 'The Windows .NET Framework C# compiler is unavailable.' }
# Compile in an ASCII path: the legacy Framework compiler mishandles accents.
$scratch = Join-Path $env:TEMP ('mutuals-brotli-' + [Guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Path $scratch
try {
    [IO.File]::WriteAllText((Join-Path $scratch 'brotli.cs'), $launcherSource, [Text.UTF8Encoding]::new($false))
    Push-Location $scratch
    try {
        & $compiler /nologo /target:exe /out:brotli.exe brotli.cs
        if ($LASTEXITCODE -ne 0) { throw 'Could not compile the Brotli launcher.' }
    }
    finally { Pop-Location }
    $null = New-Item -ItemType Directory -Path $toolRoot -Force
    [IO.File]::WriteAllText((Join-Path $toolRoot 'brotli.cjs'), $compressorSource, [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText((Join-Path $toolRoot 'node-path.txt'), $node, [Text.UTF8Encoding]::new($false))
    # Install the executable last, so an interrupted setup is safe to retry.
    Copy-Item -LiteralPath (Join-Path $scratch 'brotli.exe') -Destination $toolExe
    Write-Host "Installed the Node-backed Brotli build adapter at $toolExe"
}
finally {
    $scratchFull = [IO.Path]::GetFullPath($scratch)
    $tempRoot = [IO.Path]::GetFullPath($env:TEMP).TrimEnd('\', '/') + '\'
    if ($scratchFull.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase)) {
        Remove-Item -LiteralPath $scratchFull -Recurse -Force
    }
}
