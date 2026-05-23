@echo off
chcp 65001 >nul
title CloudMind-Zome Stop

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop-dev.ps1"
pause
