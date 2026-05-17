@echo off
setlocal
echo Kurulum yapiliyor... Lutfen bekleyin.

:: Bulundugu klasorun yolunu al ve cift ters slash (\\) formatina cevir
set "HOST_DIR=%~dp0"
set "HOST_DIR=%HOST_DIR:\=\\%"

:: JSON dosyasini otomatik olarak yarat!
echo {> com.tabgroup.master.json
echo   "name": "com.tabgroup.master",>> com.tabgroup.master.json
echo   "description": "TabGroup Master Native Host",>> com.tabgroup.master.json
echo   "path": "%HOST_DIR%host.bat",>> com.tabgroup.master.json
echo   "type": "stdio",>> com.tabgroup.master.json
echo   "allowed_origins": [>> com.tabgroup.master.json
echo     "chrome-extension://endanmmjoefnpoaojffcegllnbfkjfad/">> com.tabgroup.master.json
echo   ]>> com.tabgroup.master.json
echo }>> com.tabgroup.master.json

:: Kayit defterine ekle
REG ADD "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.tabgroup.master" /ve /t REG_SZ /d "%~dp0com.tabgroup.master.json" /f

echo Basarili! JSON dosyasi bilgisayariniza ozel olarak otomatik uretildi ve sisteme islendi.
echo Artik eklentiyi kullanabilirsiniz.
pause