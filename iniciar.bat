@echo off
title AI Assist
echo.
echo ==============================
echo   AI Assist - Iniciando...
echo ==============================
echo.

for /f "tokens=5" %%a in ('netstat -ano ^| findstr :3000 ^| findstr LISTENING 2^>nul') do (
    echo Reiniciando: deteniendo servidor anterior...
    taskkill /f /pid %%a >nul 2>&1
)

echo Iniciando servidor...
start /min "" cmd /c npm run dev

echo.
echo Espera unos 20 segundos mientras carga...
echo Luego abre tu navegador y visita:
echo.
echo    http://localhost:3000/
echo.
echo [No cierres esta ventana]
echo.
pause
