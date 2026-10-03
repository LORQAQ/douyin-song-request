Option Explicit
Dim fso, shell, root, script, logDir, logFile
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
root = fso.GetParentFolderName(WScript.ScriptFullName)
script = root & "\src\index.js"
logDir = root & "\logs"
If Not fso.FolderExists(logDir) Then
  fso.CreateFolder(logDir)
End If
logFile = logDir & "\background.log"
shell.CurrentDirectory = root
' 0 = hidden window, redirect output to log so failures are visible
shell.Run "cmd /c node """ & script & """ --open >> """ & logFile & """ 2>&1", 0, false
