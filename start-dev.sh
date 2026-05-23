#!/bin/bash
# CloudMind-Zome 一键启动 (Git Bash)

cd "$(dirname "$0")"

echo "=== CloudMind-Zome Dev Launcher ==="

# Kill old processes
echo "[1/3] Stopping old processes..."
taskkill //F //IM python.exe 2>/dev/null
taskkill //F //IM node.exe 2>/dev/null
sleep 2

# Start backend
echo "[2/3] Starting backend on port 8849..."
cd backend
/c/Users/b1953/AppData/Local/Programs/Python/Launcher/py run.py &
BACKEND_PID=$!
cd ..

sleep 4

# Start frontend
echo "[3/3] Starting frontend on port 1420..."
cd frontend
/f/Node/npm run dev &
FRONTEND_PID=$!
cd ..

echo ""
echo "Backend:  http://127.0.0.1:8849"
echo "Frontend: http://localhost:1420"
echo ""
echo "Press Enter to stop all services..."
read

echo "Shutting down..."
kill $BACKEND_PID 2>/dev/null
kill $FRONTEND_PID 2>/dev/null
taskkill //F //IM python.exe 2>/dev/null
taskkill //F //IM node.exe 2>/dev/null
echo "Done."
