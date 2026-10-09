' LazyEditMirror audio engine launcher.
'
' Starts helper\sync-helper.mjs with Node.js in the background, without a
' console window. Registered by the installer as the handler of the
' lazyeditmirror: URL scheme (which the panel opens when the engine is not
' running) and as a per-user startup item. If Node.js or ffmpeg are missing it
' offers to install them with winget, in a visible window, and nothing else.

Option Explicit
Dim shell, fso, here, logFile, answer
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)

Function Found(command)
    Found = (shell.Run("cmd /c where " & command & " >nul 2>&1", 0, True) = 0)
End Function

If Not Found("node") Then
    answer = MsgBox("LazyEditMirror's audio engine needs Node.js, which is not installed." & vbCrLf & vbCrLf & _
        "Install it now with winget? A window will open and close by itself.", vbYesNo + vbQuestion, "LazyEditMirror")
    If answer = vbYes Then
        shell.Run "cmd /c winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements", 1, True
        MsgBox "Done. The audio engine will start the next time the panel needs it.", vbInformation, "LazyEditMirror"
    End If
    WScript.Quit 1
End If

If Not Found("ffmpeg") Then
    answer = MsgBox("LazyEditMirror's audio engine needs ffmpeg, which is not installed." & vbCrLf & vbCrLf & _
        "Install it now with winget? A window will open and close by itself.", vbYesNo + vbQuestion, "LazyEditMirror")
    If answer = vbYes Then
        shell.Run "cmd /c winget install -e --id Gyan.FFmpeg --accept-source-agreements --accept-package-agreements", 1, True
        MsgBox "Done. The audio engine will start the next time the panel needs it.", vbInformation, "LazyEditMirror"
    End If
    WScript.Quit 1
End If

' Hidden window (0), do not wait. The engine exits by itself when nothing uses
' it for a few hours, and quietly steps aside if another instance is running.
shell.Run "node """ & here & "\sync-helper.mjs"" --hidden", 0, False
