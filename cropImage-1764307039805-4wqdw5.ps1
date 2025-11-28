Add-Type -AssemblyName System.Drawing
$source = "D:\\vpt-tool-source\\snap\\snap-1764307030284.png"
$output = "D:\\vpt-tool-source\\snap\\template-1764307039805.png"
$img = [System.Drawing.Image]::FromFile($source)
$rect = New-Object System.Drawing.Rectangle(432, 341, 54, 15)
$bitmap = New-Object System.Drawing.Bitmap($rect.Width, $rect.Height)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.DrawImage($img, 0, 0, $rect, [System.Drawing.GraphicsUnit]::Pixel)
$graphics.Dispose()
$bitmap.Save($output, [System.Drawing.Imaging.ImageFormat]::Png)
$bitmap.Dispose()
$img.Dispose()
Write-Output "SUCCESS"