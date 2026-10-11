$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

function Read-ContainerSetting([string]$container, [string]$setting) {
    $entries = & docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' $container 2>$null
    if ($LASTEXITCODE -ne 0) { throw "Could not read required settings for $container." }
    $prefix = "$setting="
    $entry = $entries | Where-Object { $_.StartsWith($prefix, [System.StringComparison]::Ordinal) } | Select-Object -First 1
    if (-not $entry) { throw "The $setting setting is missing from $container." }
    return $entry.Substring($prefix.Length)
}

try {
    & (Join-Path $PSScriptRoot 'start-local-data.ps1') | Out-Null
    $postgresPassword = Read-ContainerSetting 'anuvaad-postgres18' 'POSTGRES_PASSWORD'
    $neo4jAuth = Read-ContainerSetting 'anuvaad-neo4j' 'NEO4J_AUTH'
    $authParts = $neo4jAuth.Split('/', 2)
    if ($authParts.Length -ne 2) { throw 'Neo4j authentication setting is malformed.' }

    $env:PGHOST = '127.0.0.1'
    $env:PGPORT = '15432'
    $env:PGDATABASE = 'anuvaad'
    $env:PGUSER = 'anuvaad'
    $env:PGPASSWORD = $postgresPassword
    $env:NEO4J_URI = 'bolt://127.0.0.1:17687'
    $env:NEO4J_USER = $authParts[0]
    $env:NEO4J_PASSWORD = $authParts[1]

    & node (Join-Path $PSScriptRoot 'import-ddinter.js')
    if ($LASTEXITCODE -ne 0) { throw 'DDInter data were not imported.' }
    & node (Join-Path $PSScriptRoot 'check-ddinter-index.js')
    if ($LASTEXITCODE -ne 0) { throw 'DDInter interaction lookup did not pass its reference-row check.' }
} catch {
    Write-Error $_
    exit 1
}
