!macro customInstall
  CreateDirectory "$INSTDIR\bin"
  FileOpen $0 "$INSTDIR\bin\synergy.cmd" w
  FileWrite $0 "@echo off$\r$\n"
  FileWrite $0 "\"$INSTDIR\resources\synergy\bin\synergy.exe\" %*$\r$\n"
  FileClose $0

  ReadRegStr $0 HKCU "Environment" "Path"
  StrCpy $1 "$INSTDIR\bin"
  Push $0
  Push $1
  Call StrStr
  Pop $2
  ${If} $2 == ""
    ${If} $0 == ""
      WriteRegExpandStr HKCU "Environment" "Path" "$1"
    ${Else}
      WriteRegExpandStr HKCU "Environment" "Path" "$0;$1"
    ${EndIf}
  ${EndIf}
  SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=5000
!macroend

!macro customUnInstall
  ReadRegStr $0 HKCU "Environment" "Path"
  StrCpy $1 "$INSTDIR\bin"
  Push $0
  Push $1
  Call un.RemovePathEntry
  Pop $2
  WriteRegExpandStr HKCU "Environment" "Path" "$2"
  Delete "$INSTDIR\bin\synergy.cmd"
  RMDir "$INSTDIR\bin"
  SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=5000
!macroend

Function StrStr
  Exch $R1
  Exch
  Exch $R2
  Push $R3
  Push $R4
  Push $R5
  StrLen $R3 $R1
  StrCpy $R4 0
  loop:
    StrCpy $R5 $R2 $R3 $R4
    StrCmp $R5 $R1 done
    StrCmp $R5 "" notfound
    IntOp $R4 $R4 + 1
    Goto loop
  done:
    StrCpy $R1 $R2 "" $R4
    Goto end
  notfound:
    StrCpy $R1 ""
  end:
    Pop $R5
    Pop $R4
    Pop $R3
    Pop $R2
    Exch $R1
FunctionEnd

Function un.RemovePathEntry
  Exch $R1
  Exch
  Exch $R2
  Push $R3
  Push $R4
  Push $R5
  Push $R6
  StrCpy $R3 ""
  loop:
    StrCpy $R4 $R2 1
    StrCmp $R4 "" done
    StrCpy $R5 0
  entry:
    StrCpy $R4 $R2 1 $R5
    StrCmp $R4 ";" entry_done
    StrCmp $R4 "" entry_done
    IntOp $R5 $R5 + 1
    Goto entry
  entry_done:
    StrCpy $R6 $R2 $R5
    IntOp $R5 $R5 + 1
    StrCpy $R2 $R2 "" $R5
    StrCmp $R6 $R1 loop
    StrCmp $R6 "" loop
    StrCmp $R3 "" first append
  first:
    StrCpy $R3 $R6
    Goto loop
  append:
    StrCpy $R3 "$R3;$R6"
    Goto loop
  done:
    Pop $R6
    Pop $R5
    Pop $R4
    Exch $R3
    Exch 3
    Pop $R2
    Pop $R1
    Pop $R3
FunctionEnd
