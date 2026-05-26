@echo off
echo Starting WE-CFM-Orchestrator with DevTools enabled...
cd /d G:\WECRYP
set WECRYPTO_OPEN_DEVTOOLS=1
set ELECTRON_ENABLE_LOGGING=1
npm run start
