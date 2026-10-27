Remove-Item 'C:\Users\16321\AppData\Local\Temp\*' -Recurse -Force -ErrorAction SilentlyContinue
pip cache purge
npm cache clean --force
Clear-RecycleBin -Force -ErrorAction SilentlyContinue
Write-Output 'cleanup done'
