$ErrorActionPreference = 'Stop'

function New-LocalSecret {
    $bytes = [byte[]]::new(32)
    $generator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $generator.GetBytes($bytes) } finally { $generator.Dispose() }
    return [BitConverter]::ToString($bytes).Replace('-', '')
}

function Test-ContainerExists([string]$name) {
    $match = docker ps -a --filter "name=^/$name$" --format '{{.Names}}'
    return [bool]($match -contains $name)
}

function Test-ContainerRunning([string]$name) {
    $match = docker ps --filter "name=^/$name$" --format '{{.Names}}'
    return [bool]($match -contains $name)
}

function Start-AppContainer([string]$name, [string[]]$arguments) {
    if (Test-ContainerRunning $name) {
        Write-Output "$name is already running."
        return
    }
    if (Test-ContainerExists $name) {
        docker start $name | Out-Null
    } else {
        & docker @arguments | Out-Null
    }
    if ($LASTEXITCODE -ne 0) { throw "Docker could not start $name." }
    Write-Output "Started $name."
}

try {
    docker info --format '{{.ServerVersion}}' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Docker Engine is not ready. Start Docker Desktop and retry.' }

    # PostgreSQL 18 stores its cluster directly under /var/lib/postgresql.
    # Keep the first, failed attempt intact and create the corrected service
    # under a new name so no existing volume is replaced or discarded.
    if (Test-ContainerRunning 'anuvaad-postgres') {
        docker stop anuvaad-postgres | Out-Null
    }
    $postgresPassword = New-LocalSecret
    $neo4jPassword = New-LocalSecret
    $postgresArgs = @(
        'run', '-d', '--name', 'anuvaad-postgres18', '--restart', 'unless-stopped',
        '--publish', '127.0.0.1:15432:5432',
        '--volume', 'anuvaad_postgres18_data:/var/lib/postgresql',
        '--env', 'POSTGRES_DB=anuvaad',
        '--env', 'POSTGRES_USER=anuvaad',
        '--env', "POSTGRES_PASSWORD=$postgresPassword",
        'postgres:18-alpine'
    )
    $neo4jAuth = "neo4j/$neo4jPassword"
    $neo4jArgs = @(
        'run', '-d', '--name', 'anuvaad-neo4j', '--restart', 'unless-stopped',
        '--publish', '127.0.0.1:17474:7474',
        '--publish', '127.0.0.1:17687:7687',
        '--volume', 'anuvaad_neo4j_data:/data',
        '--env', "NEO4J_AUTH=$neo4jAuth",
        'neo4j:latest'
    )

    Start-AppContainer 'anuvaad-postgres18' $postgresArgs
    Start-AppContainer 'anuvaad-neo4j' $neo4jArgs

    Write-Output ''
    Write-Output 'App data services:'
    Write-Output 'PostgreSQL: 127.0.0.1:15432 (database anuvaad)'
    Write-Output 'Neo4j Browser: http://127.0.0.1:17474'
    Write-Output 'Neo4j Bolt: bolt://127.0.0.1:17687'
    Write-Output 'Persistent Docker volumes: anuvaad_postgres18_data, anuvaad_neo4j_data'
    Write-Output 'Database passwords are held by the Docker containers and are not printed.'
} catch {
    Write-Error $_
    exit 1
}
