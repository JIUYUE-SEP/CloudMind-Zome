#Requires -Version 5.1
$base = "https://unpkg.com/live2d-widget-model-shizuku@1.0.5/assets"
$local = "$PSScriptRoot/shizuku"

function dl($path) {
    $dir = Split-Path "$local/$path" -Parent
    if (!(Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    $url = "$base/$path"
    $dest = "$local/$path"
    if (Test-Path $dest) { return }
    try {
        Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing -TimeoutSec 30
        Write-Host "OK  $path"
    } catch {
        Write-Host "ERR $path"
    }
}

# model json
dl "shizuku.model.json"

# moc
dl "moc/shizuku.moc"
for ($i=0; $i -le 5; $i++) { dl "moc/shizuku.1024/texture_0$i.png" }

# physics & pose
dl "shizuku.physics.json"
dl "shizuku.pose.json"

# expressions
for ($i=1; $i -le 4; $i++) { dl "exp/f0$i.exp.json" }

# motions idle
for ($i=0; $i -le 2; $i++) { dl "mtn/idle_0$i.mtn" }

# motions tapBody
for ($i=0; $i -le 2; $i++) {
    dl "mtn/tapBody_0$i.mtn"
    dl "snd/tapBody_0$i.mp3"
}

# motions pinch
for ($i=0; $i -le 2; $i++) {
    dl "mtn/pinchIn_0$i.mtn"
    dl "mtn/pinchOut_0$i.mtn"
    dl "snd/pinchIn_0$i.mp3"
    dl "snd/pinchOut_0$i.mp3"
}

# motions shake
for ($i=0; $i -le 2; $i++) {
    dl "mtn/shake_0$i.mtn"
    dl "snd/shake_0$i.mp3"
}

# motions flickHead
for ($i=0; $i -le 2; $i++) {
    dl "mtn/flickHead_0$i.mtn"
    dl "snd/flickHead_0$i.mp3"
}

Write-Host "Done. Files in $local"
