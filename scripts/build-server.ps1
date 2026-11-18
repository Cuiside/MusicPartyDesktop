param([string]$Version = '', [string]$OutputDir = '')
$ErrorActionPreference = 'Stop'
if (-not $Version) { $Version = (Get-Content -LiteralPath (Join-Path $PSScriptRoot '../package.json') -Raw | ConvertFrom-Json).version }
if ($Version -notmatch '^[0-9A-Za-z][0-9A-Za-z.+-]*$') { throw 'Invalid build version.' }
$root = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$web = Join-Path $root 'music-party-web'
$target = Join-Path $root "target/MusicParty-$Version.jar"
$buildRoot = Join-Path $PSScriptRoot '../server-builds'
$buildDir = if ($OutputDir) { [IO.Path]::GetFullPath($OutputDir) } else { Join-Path $buildRoot ($Version + '-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N').Substring(0,8)) }
$jar = Join-Path $buildDir 'server.jar'
$receipt = Join-Path $buildDir 'server-build.json'
if (Test-Path -LiteralPath $buildDir) { throw 'Output directory already exists. Choose a new directory.' }
if (-not $env:JAVA_HOME -or -not (Test-Path -LiteralPath (Join-Path $env:JAVA_HOME 'bin/javac.exe'))) {
    throw 'JAVA_HOME must point to a JDK with javac (version 21 or later).'
}
$javacVersion = & (Join-Path $env:JAVA_HOME 'bin/javac.exe') -version 2>&1 | Out-String
if ($javacVersion -notmatch 'javac\s+(\d+)' -or [int]$Matches[1] -lt 21) { throw 'JDK 21 or later is required.' }
$oldPath = $env:PATH
$env:PATH = (Join-Path $env:JAVA_HOME 'bin') + [IO.Path]::PathSeparator + $oldPath
try {
    Push-Location $web
    try { & npm.cmd run build; if ($LASTEXITCODE -ne 0) { throw 'Web build failed.' } } finally { Pop-Location }
    if (-not (Test-Path -LiteralPath (Join-Path $web 'dist/index.html'))) { throw 'Web build did not produce index.html.' }
    Push-Location $root
    try {
        $revision = (& git rev-parse HEAD).Trim()
        if ($LASTEXITCODE -ne 0 -or $revision -notmatch '^[a-f0-9]{40}$') { throw 'Cannot identify repository revision.' }
        $dirty = [bool](& git status --porcelain --untracked-files=normal)
        $sourceDigest = (& node (Join-Path $PSScriptRoot 'lib/source-digest.cjs')).Trim()
        if ($LASTEXITCODE -ne 0 -or $sourceDigest -notmatch '^[A-F0-9]{64}$') { throw 'Cannot fingerprint source files.' }
        & ./mvnw.cmd -B clean package '-Pdesktop-integrated' "-Drevision=$Version"
        if ($LASTEXITCODE -ne 0) { throw 'Maven build or tests failed.' }
        if (-not (Test-Path -LiteralPath $target)) { throw 'Expected server JAR was not produced.' }
        $entries = & (Join-Path $env:JAVA_HOME 'bin/jar.exe') tf $target
        if ($LASTEXITCODE -ne 0 -or $entries -notcontains 'BOOT-INF/classes/static/index.html') { throw 'Server JAR does not contain the Web UI.' }
        $afterDigest = (& node (Join-Path $PSScriptRoot 'lib/source-digest.cjs')).Trim()
        if ($LASTEXITCODE -ne 0 -or $afterDigest -ne $sourceDigest) { throw 'Source files changed during the build; discard this JAR and retry.' }
    } finally { Pop-Location }
    [IO.Directory]::CreateDirectory((Split-Path -Parent $buildDir)) | Out-Null
    New-Item -ItemType Directory -Path $buildDir | Out-Null
    [IO.File]::Copy($target, $jar, $false)
    $record = [ordered]@{ version = $Version; gitRevision = $revision; sourceDigest = $sourceDigest; dirty = $dirty; sha256 = (Get-FileHash -LiteralPath $jar -Algorithm SHA256).Hash; webIncluded = $true; jdk = $javacVersion.Trim() }
    [IO.File]::WriteAllText($receipt, (($record | ConvertTo-Json) + "`n"), [Text.UTF8Encoding]::new($false))
    Write-Host "Server JAR and build receipt prepared in: $buildDir"
} finally { $env:PATH = $oldPath }
