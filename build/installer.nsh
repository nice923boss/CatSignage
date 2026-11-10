; electron-builder 會自動載入 build/installer.nsh，這裡只放反安裝要多做的兩件事。
; 升級安裝（electron-builder 先反安裝舊版時會帶 --updated）兩件都不做，素材與開機自動啟動都要留著。

!define CATSIGNAGE_RUN_KEY "Software\Microsoft\Windows\CurrentVersion\Run"

!macro customUnInstall
  ${ifNot} ${isUpdated}
    ; 開機自動啟動：刪掉指向這份安裝的 Run 項目，否則反安裝後每次登入都會去找不存在的執行檔
    ; Electron 寫入時會替路徑加引號，加不加引號的寫法都比對
    StrCpy $R5 '"$INSTDIR\${APP_EXECUTABLE_FILENAME}"'
    StrLen $R6 $R5
    StrCpy $R3 "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
    StrLen $R2 $R3
    StrCpy $R7 0
    catsignage_run_loop:
      ClearErrors
      EnumRegValue $R8 HKCU "${CATSIGNAGE_RUN_KEY}" $R7
      IfErrors catsignage_run_done
      StrCmp $R8 "" catsignage_run_done
      ReadRegStr $R9 HKCU "${CATSIGNAGE_RUN_KEY}" $R8
      StrCpy $R4 $R9 $R6
      StrCpy $R1 $R9 $R2
      ${if} $R4 == $R5
      ${orIf} $R1 == $R3
        DeleteRegValue HKCU "${CATSIGNAGE_RUN_KEY}" $R8
        DetailPrint "已移除開機自動啟動項目：$R8"
      ${else}
        IntOp $R7 $R7 + 1
      ${endIf}
      Goto catsignage_run_loop
    catsignage_run_done:

    ; 已下載的素材與設定：有畫面的反安裝才詢問，預設按鈕是「否」（保留）；靜默反安裝一律保留
    ${ifNot} ${Silent}
      MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "要一併刪除這台電腦上的 CatSignage 素材與設定嗎？$\r$\n$\r$\n位置：$APPDATA\CatSignage$\r$\n$\r$\n選「是」會永久刪除，無法復原。$\r$\n選「否」會保留，之後重新安裝可以直接沿用。" IDYES catsignage_delete_data IDNO catsignage_keep_data
      catsignage_delete_data:
        SetShellVarContext current
        RMDir /r "$APPDATA\CatSignage"
        DetailPrint "已刪除素材與設定：$APPDATA\CatSignage"
        Goto catsignage_data_done
      catsignage_keep_data:
        DetailPrint "保留素材與設定：$APPDATA\CatSignage"
      catsignage_data_done:
    ${endIf}
  ${endIf}
!macroend
