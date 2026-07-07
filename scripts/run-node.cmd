@ECHO OFF
SETLOCAL

SET "NODE_EXE=%npm_node_execpath%"
SET "NODE_EXE=%NODE_EXE:"=%"

IF EXIST "%NODE_EXE%" GOTO run

FOR %%I IN (node.exe) DO (
  SET "NODE_EXE=%%~$PATH:I"
)

IF EXIST "%NODE_EXE%" GOTO run

ECHO Could not find node.exe. Install Node.js or add it to PATH. 1>&2
EXIT /B 1

:run
"%NODE_EXE%" %*
