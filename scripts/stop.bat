@echo off
rem Stop every running CatSignage instance (ASCII only)
chcp 65001 1>nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop.ps1"
exit /b %errorlevel%
