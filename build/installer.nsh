!macro customInstall
  CreateShortCut "$DESKTOP\轻任务.lnk" "$INSTDIR\轻任务.exe" "" "$INSTDIR\resources\app-icon.ico" 0
  CreateShortCut "$SMPROGRAMS\轻任务.lnk" "$INSTDIR\轻任务.exe" "" "$INSTDIR\resources\app-icon.ico" 0
!macroend

!macro customUnInstall
  Delete "$DESKTOP\轻任务.lnk"
  Delete "$SMPROGRAMS\轻任务.lnk"
!macroend
