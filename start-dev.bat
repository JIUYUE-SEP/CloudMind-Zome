@echo off
chcp 65001 >nul
title CloudMind-Zome Dev

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-dev.ps1"
if errorlevel 1 pause
