# Bundled FFmpeg (sidecar)

This folder holds the platform-specific FFmpeg binary used for video export:

```
ffmpeg-<rust-target-triple>[.exe]
```

Example on Windows x64:

```
ffmpeg-x86_64-pc-windows-msvc.exe
```

Download / refresh with:

```bash
pnpm ffmpeg:download
```

`tauri:dev` / `tauri:build` also run this automatically when the binary is missing.
