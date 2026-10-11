$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

$appConfigPath = Join-Path $root '.env'
if (Test-Path -LiteralPath $appConfigPath) {
    foreach ($line in Get-Content -LiteralPath $appConfigPath) {
        if ($line -match '^\s*(FHIR_BASE_URL|FHIR_CLIENT_ID|ANUVAAD_PUBLIC_URL)\s*=\s*(.*?)\s*$') {
            $name = $matches[1]
            $value = $matches[2].Trim('"').Trim("'")
            if ($value) { [Environment]::SetEnvironmentVariable($name, $value, 'Process') }
        }
    }
}

function Read-ContainerSetting([string]$container, [string]$setting) {
    $entries = & docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' $container 2>$null
    if ($LASTEXITCODE -ne 0) { throw "Could not read required settings for $container." }
    $prefix = "$setting="
    $entry = $entries | Where-Object { $_.StartsWith($prefix, [System.StringComparison]::Ordinal) } | Select-Object -First 1
    if (-not $entry) { throw "The $setting setting is missing from $container." }
    return $entry.Substring($prefix.Length)
}

try {
    & (Join-Path $PSScriptRoot 'start-local-data.ps1')
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

    $postgresReady = $false
    $neo4jReady = $false
    for ($attempt = 0; $attempt -lt 45; $attempt++) {
        & docker exec anuvaad-postgres18 pg_isready -U $env:PGUSER -d $env:PGDATABASE *> $null
        if ($LASTEXITCODE -eq 0) { $postgresReady = $true }
        $neo4jReady = Test-NetConnection -ComputerName '127.0.0.1' -Port 17687 -InformationLevel Quiet -WarningAction SilentlyContinue
        if ($postgresReady -and $neo4jReady) { break }
        Start-Sleep -Seconds 2
    }
    if (-not $postgresReady -or -not $neo4jReady) { throw 'PostgreSQL and Neo4j did not both become ready within 90 seconds.' }

    # The optional biomedical NER sidecar is isolated from the clinical API.
    # If its image cannot be built (for example, no network on first launch),
    # the rest of the app remains available and health reports NLP as unavailable.
    $nlpImage = 'anuvaad-clinical-nlp:scispacy-0.5.4'
    $nlpContainer = 'anuvaad-clinical-nlp'
    $nlpImageExists = $false
    & docker image inspect $nlpImage *> $null
    if ($LASTEXITCODE -eq 0) { $nlpImageExists = $true }
    if (-not $nlpImageExists) {
        Write-Output 'Building the biomedical NLP service (first launch downloads its model)…'
        & docker build --tag $nlpImage (Join-Path $root 'clinical-nlp')
        if ($LASTEXITCODE -eq 0) { $nlpImageExists = $true }
        else { Write-Warning 'Biomedical NLP image build failed; continuing without NLP suggestions.' }
    }
    if ($nlpImageExists) {
        $nlpRunning = & docker ps --filter "name=^/$nlpContainer$" --format '{{.Names}}'
        if ($nlpRunning -notcontains $nlpContainer) {
            $nlpExists = & docker ps -a --filter "name=^/$nlpContainer$" --format '{{.Names}}'
            if ($nlpExists -contains $nlpContainer) {
                & docker start $nlpContainer | Out-Null
            } else {
                & docker run -d --name $nlpContainer --restart unless-stopped --publish '127.0.0.1:18001:8000' $nlpImage | Out-Null
            }
        }
        $nlpReady = $false
        for ($attempt = 0; $attempt -lt 30; $attempt++) {
            try {
                $nlpHealth = Invoke-RestMethod -Uri 'http://127.0.0.1:18001/health' -TimeoutSec 3
                if ($nlpHealth.status -eq 'ready') { $nlpReady = $true; break }
            } catch {}
            Start-Sleep -Seconds 2
        }
        if ($nlpReady) {
            $env:CLINICAL_NLP_URL = 'http://127.0.0.1:18001'
            Write-Output "Biomedical NLP ready: $($nlpHealth.model)."
        } else {
            Write-Warning 'Biomedical NLP container is still loading or unavailable; the API will identify it as unavailable.'
        }
    }
    Write-Output 'PostgreSQL and Neo4j are ready. Starting Anuvaad…'
    & node (Join-Path $root 'server.js')
} catch {
    Write-Error $_
    exit 1
}
