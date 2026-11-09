Unicode true
SetCompressor /SOLID zlib

XPStyle on

!include "MUI2.nsh"
!include "FileFunc.nsh"

!define PRODUCT_NAME "课序 CampusPulse"
!define PRODUCT_VERSION "1.0.0"
!define PRODUCT_PUBLISHER "CampusPulse"
!define PRODUCT_WEB_SITE "https://github.com/"
!define APP_EXE "CampusPulse.exe"
!define UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\CampusPulse"
!define MUI_ICON "..\build\icon.ico"
!define MUI_UNICON "..\build\icon.ico"
!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN "$INSTDIR\${APP_EXE}"
!define MUI_FINISHPAGE_RUN_TEXT "启动课序 CampusPulse"

Name "${PRODUCT_NAME}"
OutFile "..\dist\CampusPulse-Setup-${PRODUCT_VERSION}.exe"
InstallDir "$LOCALAPPDATA\Programs\CampusPulse"
InstallDirRegKey HKCU "Software\CampusPulse" "InstallDir"
RequestExecutionLevel user
BrandingText "课序 CampusPulse · 本地优先的课程提醒工具"
VIProductVersion "1.0.0.0"
VIAddVersionKey "ProductName" "${PRODUCT_NAME}"
VIAddVersionKey "CompanyName" "${PRODUCT_PUBLISHER}"
VIAddVersionKey "FileDescription" "课序 CampusPulse 安装程序"
VIAddVersionKey "FileVersion" "1.0.0.0"
VIAddVersionKey "ProductVersion" "1.0.0.0"
VIAddVersionKey "LegalCopyright" "Copyright (c) 2026 CampusPulse"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_LICENSE "..\LICENSE"
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "SimpChinese"

Section "Install"
  SetShellVarContext current
  nsExec::Exec 'taskkill /IM "${APP_EXE}" /F'
  CreateDirectory "$INSTDIR"
  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
  File "..\dist\payload.zip"
  File "..\tools\7za.exe"
  nsExec::ExecToLog '"$PLUGINSDIR\7za.exe" x "$PLUGINSDIR\payload.zip" -o"$INSTDIR" -y'
  Pop $0
  StrCmp $0 "0" extract_ok
    MessageBox MB_ICONSTOP "解压安装文件失败（$0）。"
    Abort
  extract_ok:
  SetOutPath "$INSTDIR"

  CreateDirectory "$SMPROGRAMS\课序 CampusPulse"
  CreateShortCut "$SMPROGRAMS\课序 CampusPulse\课序 CampusPulse.lnk" "$INSTDIR\${APP_EXE}" "" "$INSTDIR\${APP_EXE}" 0
  CreateShortCut "$SMPROGRAMS\课序 CampusPulse\卸载课序.lnk" "$INSTDIR\Uninstall.exe"
  CreateShortCut "$DESKTOP\课序 CampusPulse.lnk" "$INSTDIR\${APP_EXE}" "" "$INSTDIR\${APP_EXE}" 0

  WriteUninstaller "$INSTDIR\Uninstall.exe"
  WriteRegStr HKCU "Software\CampusPulse" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayName" "${PRODUCT_NAME}"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayVersion" "${PRODUCT_VERSION}"
  WriteRegStr HKCU "${UNINST_KEY}" "Publisher" "${PRODUCT_PUBLISHER}"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayIcon" "$INSTDIR\${APP_EXE}"
  WriteRegStr HKCU "${UNINST_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINST_KEY}" "UninstallString" "$\"$INSTDIR\Uninstall.exe$\""
  WriteRegStr HKCU "${UNINST_KEY}" "QuietUninstallString" "$\"$INSTDIR\Uninstall.exe$\" /S"
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoRepair" 1
  WriteRegDWORD HKCU "${UNINST_KEY}" "EstimatedSize" 96000
SectionEnd

Section "Uninstall"
  SetShellVarContext current
  nsExec::Exec 'taskkill /IM "${APP_EXE}" /F'
  Delete "$DESKTOP\课序 CampusPulse.lnk"
  Delete "$SMPROGRAMS\课序 CampusPulse\课序 CampusPulse.lnk"
  Delete "$SMPROGRAMS\课序 CampusPulse\卸载课序.lnk"
  RMDir "$SMPROGRAMS\课序 CampusPulse"

  IfSilent KeepData
  MessageBox MB_YESNO|MB_ICONQUESTION "是否保留本机的日程与运行日志？$\r$\n选择“否”将删除 $APPDATA\CampusPulse 下的全部数据。" IDYES KeepData IDNO DeleteData
  DeleteData:
    RMDir /r "$APPDATA\CampusPulse"
  KeepData:

  Delete "$INSTDIR\Uninstall.exe"
  RMDir /r "$INSTDIR"
  DeleteRegKey HKCU "${UNINST_KEY}"
  DeleteRegKey HKCU "Software\CampusPulse"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "CampusPulse"
SectionEnd
