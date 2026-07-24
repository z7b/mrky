Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$distPath = (Get-Item "dist").FullName
$zipPath = (Get-Item ".").FullName + "\panda-extension-edge-v1.1.0.zip"
$desktopZipPath = "C:\Users\sief\Desktop\panda-extension-edge-v1.1.0.zip"

if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
if (Test-Path $desktopZipPath) { Remove-Item $desktopZipPath -Force }

$zip = [System.IO.Compression.ZipFile]::Open($zipPath, 'Create')

Get-ChildItem -Path $distPath -Recurse | Where-Object { -not $_.PSIsContainer } | ForEach-Object {
    $relativePath = $_.FullName.Substring($distPath.Length + 1).Replace('\', '/')
    [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $_.FullName, $relativePath, [System.IO.Compression.CompressionLevel]::Optimal)
}

$zip.Dispose()

Copy-Item $zipPath $desktopZipPath -Force
Write-Host "ZIP created successfully at $zipPath and $desktopZipPath"
