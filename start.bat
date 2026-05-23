@echo off
set "PATH=C:\Program Files\Git\bin;C:\Users\b1953\AppData\Local\Programs\Python\Python314;C:\Users\b1953\AppData\Local\Programs\Python\Launcher;F:\Node;%PATH%"
start "Backend" cmd /c "cd /d F:\MyProject_justlove\MindCloud-Zome\backend && python run.py"
timeout /t 4 /nobreak >nul
cd /d F:\MyProject_justlove\MindCloud-Zome\frontend
npm run dev
taskkill /FI "WINDOWTITLE eq Backend" /F >nul 2>&1
