@echo off
rem CatSignage launcher (ASCII only: cmd reads .bat as CP950)
rem Usage: start.bat [--profile=NAME]
pushd "%~dp0.."

if not exist "node_modules\electron\package.json" (
  echo [1/3] Installing npm dependencies...
  call npm install
  if errorlevel 1 goto fail
)

if not exist "node_modules\electron\dist\electron.exe" (
  echo [2/3] Electron binary missing, downloading...
  node "node_modules\electron\install.js"
  if errorlevel 1 goto fail
)

if not exist "node_modules\electron\dist\electron.exe" (
  echo ERROR: node_modules\electron\dist\electron.exe still missing.
  echo Run "node node_modules\electron\install.js" manually and check network.
  goto fail
)

echo [3/3] Starting CatSignage...
"node_modules\electron\dist\electron.exe" "." %*
set RC=%errorlevel%
popd
exit /b %RC%

:fail
echo.
echo Startup failed. See messages above.
popd
pause
exit /b 1
