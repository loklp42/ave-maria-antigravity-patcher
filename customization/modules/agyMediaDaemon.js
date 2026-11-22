"use strict";
const https = require("https");
const crypto = require("crypto");
const readline = require("readline");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

let appRef = null;
try { appRef = require("electron").app; } catch {}

const lyricsCache = new Map();
const coverCache = new Map(); // coverKey -> { buf: Buffer, mime: string, hires: boolean }
const coverInFlight = new Set();

let lastSmtcKey = "";
let lastSmtcBuf = null;
let lastSmtcMime = "image/jpeg";
let pinnedAppId = "";

const PS_DAEMON_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -AssemblyName System.Runtime.WindowsRuntime
Add-Type -TypeDefinition @"
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
public class AgyMediaKeys {
    [DllImport("user32.dll")]
    public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
    public static void Send(byte vk) {
        keybd_event(vk, 0, 0, UIntPtr.Zero);
        keybd_event(vk, 0, 2, UIntPtr.Zero);
    }
}

public class AgyAudioVol {
    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    private class MMDeviceEnumerator {}

    [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IMMDeviceEnumerator {
        int NotImpl1();
        [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice ppDevice);
    }

    [Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IMMDevice {
        [PreserveSig] int Activate(ref Guid iid, int dwClsCtx, IntPtr pActivationParams, [MarshalAs(UnmanagedType.IUnknown)] out object ppInterface);
    }

    [Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAudioEndpointVolume {
        int f1(); int f2(); int f3(); int f4(); int f5();
        [PreserveSig] int SetMasterVolumeLevelScalar(float fLevel, ref Guid pguidEventContext);
        int f7();
        [PreserveSig] int GetMasterVolumeLevelScalar(out float pfLevel);
        int f9(); int f10(); int f11();
        [PreserveSig] int SetMute([MarshalAs(UnmanagedType.Bool)] bool bMute, ref Guid pguidEventContext);
        [PreserveSig] int GetMute([MarshalAs(UnmanagedType.Bool)] out bool pbMute);
    }

    [Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAudioSessionManager2 {
        int f1(); int f2();
        [PreserveSig] int GetSessionEnumerator(out IAudioSessionEnumerator SessionEnum);
    }

    [Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAudioSessionEnumerator {
        [PreserveSig] int GetCount(out int SessionCount);
        [PreserveSig] int GetSession(int SessionCount, out IAudioSessionControl2 Session);
    }

    [Guid("BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAudioSessionControl2 {
        int f1(); int f2(); int f3(); int f4(); int f5(); int f6(); int f7(); int f8(); int f9();
        [PreserveSig] int GetSessionIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string pRetVal);
        [PreserveSig] int GetSessionInstanceIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string pRetVal);
        [PreserveSig] int GetProcessId(out uint pRetVal);
        [PreserveSig] int IsSystemSoundsSession();
    }

    [Guid("87CE5498-68D6-44E5-9215-6DA47EF883D8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface ISimpleAudioVolume {
        [PreserveSig] int SetMasterVolume(float fLevel, ref Guid EventContext);
        [PreserveSig] int GetMasterVolume(out float pfLevel);
        [PreserveSig] int SetMute([MarshalAs(UnmanagedType.Bool)] bool bMute, ref Guid EventContext);
        [PreserveSig] int GetMute([MarshalAs(UnmanagedType.Bool)] out bool pbMute);
    }

    private static IMMDevice GetDefaultDevice() {
        var enumerator = (IMMDeviceEnumerator)(new MMDeviceEnumerator());
        IMMDevice dev;
        if (enumerator.GetDefaultAudioEndpoint(0, 1, out dev) != 0) return null;
        return dev;
    }

    private static bool MatchesApp(string appHint, string procName, string sid) {
        if (string.IsNullOrEmpty(appHint)) return false;
        string h = appHint.ToLowerInvariant();
        string p = (procName ?? "").ToLowerInvariant();
        string s = (sid ?? "").ToLowerInvariant();
        string[] keys = new string[] {
            "yandex", "spotify", "applemusic", "itunes", "chrome", "msedge", "edge",
            "firefox", "opera", "brave", "vivaldi", "aimp", "foobar", "vlc",
            "tidal", "deezer", "telegram", "ayugram", "discord"
        };
        foreach (var k in keys) {
            if (h.Contains(k) && (p.Contains(k) || s.Contains(k))) return true;
        }
        string clean = h.Replace(".exe", "");
        int bang = clean.IndexOf("!");
        if (bang > 0) clean = clean.Substring(0, bang);
        if (clean.Length >= 3 && (p.Contains(clean) || s.Contains(clean))) return true;
        return false;
    }

    public static int[] GetVolumeInfo(string appHint) {
        // returns [volume 0..100, muted 0|1, scope 1=app|0=master, ok 1|0]
        try {
            var dev = GetDefaultDevice();
            if (dev == null) return new int[] { 100, 0, 0, 0 };
            if (!string.IsNullOrEmpty(appHint)) {
                Guid iidMgr = typeof(IAudioSessionManager2).GUID;
                object oMgr;
                if (dev.Activate(ref iidMgr, 23, IntPtr.Zero, out oMgr) == 0 && oMgr != null) {
                    var mgr = (IAudioSessionManager2)oMgr;
                    IAudioSessionEnumerator en;
                    if (mgr.GetSessionEnumerator(out en) == 0 && en != null) {
                        int count = 0; en.GetCount(out count);
                        for (int i = 0; i < count; i++) {
                            IAudioSessionControl2 ctl;
                            if (en.GetSession(i, out ctl) == 0 && ctl != null) {
                                uint pid = 0; ctl.GetProcessId(out pid);
                                string sid = ""; try { ctl.GetSessionIdentifier(out sid); } catch {}
                                string pname = "";
                                if (pid > 0) { try { pname = Process.GetProcessById((int)pid).ProcessName; } catch {} }
                                if (MatchesApp(appHint, pname, sid)) {
                                    var sav = ctl as ISimpleAudioVolume;
                                    if (sav != null) {
                                        float lvl; bool muted;
                                        sav.GetMasterVolume(out lvl);
                                        sav.GetMute(out muted);
                                        return new int[] { (int)Math.Round(lvl * 100f), muted ? 1 : 0, 1, 1 };
                                    }
                                }
                            }
                        }
                    }
                }
            }
            Guid iidEp = typeof(IAudioEndpointVolume).GUID;
            object oEp;
            if (dev.Activate(ref iidEp, 23, IntPtr.Zero, out oEp) == 0 && oEp != null) {
                var ep = (IAudioEndpointVolume)oEp;
                float lvl; bool muted;
                ep.GetMasterVolumeLevelScalar(out lvl);
                ep.GetMute(out muted);
                return new int[] { (int)Math.Round(lvl * 100f), muted ? 1 : 0, 0, 1 };
            }
        } catch {}
        return new int[] { 100, 0, 0, 0 };
    }

    public static int[] SetVolumeInfo(string appHint, int volPercent, int muteMode) {
        // volPercent: 0..100 or -1 to leave unchanged; muteMode: 0=unmute, 1=mute, -1=unchanged
        try {
            var dev = GetDefaultDevice();
            if (dev == null) return new int[] { 100, 0, 0, 0 };
            Guid ctx = Guid.Empty;
            bool matchedAny = false;
            int lastVol = volPercent >= 0 ? Math.Max(0, Math.Min(100, volPercent)) : 100;
            int lastMute = muteMode >= 0 ? muteMode : 0;

            if (!string.IsNullOrEmpty(appHint)) {
                Guid iidMgr = typeof(IAudioSessionManager2).GUID;
                object oMgr;
                if (dev.Activate(ref iidMgr, 23, IntPtr.Zero, out oMgr) == 0 && oMgr != null) {
                    var mgr = (IAudioSessionManager2)oMgr;
                    IAudioSessionEnumerator en;
                    if (mgr.GetSessionEnumerator(out en) == 0 && en != null) {
                        int count = 0; en.GetCount(out count);
                        for (int i = 0; i < count; i++) {
                            IAudioSessionControl2 ctl;
                            if (en.GetSession(i, out ctl) == 0 && ctl != null) {
                                uint pid = 0; ctl.GetProcessId(out pid);
                                string sid = ""; try { ctl.GetSessionIdentifier(out sid); } catch {}
                                string pname = "";
                                if (pid > 0) { try { pname = Process.GetProcessById((int)pid).ProcessName; } catch {} }
                                if (MatchesApp(appHint, pname, sid)) {
                                    var sav = ctl as ISimpleAudioVolume;
                                    if (sav != null) {
                                        if (volPercent >= 0) sav.SetMasterVolume(lastVol / 100f, ref ctx);
                                        if (muteMode >= 0) sav.SetMute(muteMode == 1, ref ctx);
                                        float lvl; bool muted;
                                        sav.GetMasterVolume(out lvl);
                                        sav.GetMute(out muted);
                                        lastVol = (int)Math.Round(lvl * 100f);
                                        lastMute = muted ? 1 : 0;
                                        matchedAny = true;
                                    }
                                }
                            }
                        }
                    }
                }
            }
            if (matchedAny) return new int[] { lastVol, lastMute, 1, 1 };

            Guid iidEp = typeof(IAudioEndpointVolume).GUID;
            object oEp;
            if (dev.Activate(ref iidEp, 23, IntPtr.Zero, out oEp) == 0 && oEp != null) {
                var ep = (IAudioEndpointVolume)oEp;
                if (volPercent >= 0) ep.SetMasterVolumeLevelScalar(lastVol / 100f, ref ctx);
                if (muteMode >= 0) ep.SetMute(muteMode == 1, ref ctx);
                float lvl; bool muted;
                ep.GetMasterVolumeLevelScalar(out lvl);
                ep.GetMute(out muted);
                return new int[] { (int)Math.Round(lvl * 100f), muted ? 1 : 0, 0, 1 };
            }
        } catch {}
        return new int[] { 100, 0, 0, 0 };
    }
}
"@

$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1'
})[0]

function Await-WinRt($WinRtTask, $ResultType) {
    $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
    $netTask = $asTask.Invoke($null, @($WinRtTask))
    $netTask.Wait(3000) | Out-Null
    if ($netTask.IsCompleted -and -not $netTask.IsFaulted) { return $netTask.Result }
    return $null
}

[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType=WindowsRuntime] | Out-Null
[Windows.Storage.Streams.IRandomAccessStreamWithContentType, Windows.Storage.Streams, ContentType=WindowsRuntime] | Out-Null
[Windows.Storage.Streams.IRandomAccessStream, Windows.Storage.Streams, ContentType=WindowsRuntime] | Out-Null
$asStreamMethod = [System.IO.WindowsRuntimeStreamExtensions].GetMethod('AsStream', [Type[]]@([Windows.Storage.Streams.IRandomAccessStream]))
$mgr = Await-WinRt ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])

function Get-AppDisplayName([string]$appId) {
    $a = if ($appId) { $appId.ToLowerInvariant() } else { '' }
    if ($a -match 'yandex') { return 'Яндекс Музыка' }
    if ($a -match 'spotify') { return 'Spotify' }
    if ($a -match 'applemusic|itunes') { return 'Apple Music' }
    if ($a -match 'chrome') { return 'Chrome' }
    if ($a -match 'msedge|edge') { return 'Edge' }
    if ($a -match 'firefox') { return 'Firefox' }
    if ($a -match 'opera') { return 'Opera' }
    if ($a -match 'brave') { return 'Brave' }
    if ($a -match 'vivaldi') { return 'Vivaldi' }
    if ($a -match 'aimp') { return 'AIMP' }
    if ($a -match 'foobar') { return 'foobar2000' }
    if ($a -match 'vlc') { return 'VLC' }
    if ($a -match 'vk|boom') { return 'VK Музыка' }
    if ($a -match 'tidal') { return 'TIDAL' }
    if ($a -match 'deezer') { return 'Deezer' }
    if ($a -match 'ayugram|telegram') { return 'Telegram' }
    if ($a -match 'discord') { return 'Discord' }
    return 'Медиа'
}

function Score-Session($s, $info, $pb, $tl, [string]$pin) {
    $score = 0
    $app = [string]$s.SourceAppUserModelId
    $a = $app.ToLowerInvariant()
    $st = $pb.PlaybackStatus.ToString()
    if ($pin -and $app -eq $pin) { $score += 500 }
    if ($st -eq 'Playing') { $score += 120 }
    elseif ($st -eq 'Paused') { $score += 55 }
    elseif ($st -eq 'Stopped') { $score -= 30 }
    if ($a -match 'yandex|spotify|applemusic|itunes|aimp|foobar|tidal|deezer|music') { $score += 40 }
    elseif ($a -match 'chrome|msedge|edge|firefox|opera|brave|vivaldi|vlc') { $score += 22 }
    elseif ($a -match 'ayugram|telegram|discord|whatsapp|viber') {
        if ($st -ne 'Playing') { $score -= 80 }
    }
    if ($info -and $info.Title) { $score += 15 }
    if ($tl -and $tl.EndTime.TotalSeconds -gt 10) { $score += 15 }
    return $score
}

$cachedThumbKey = ''
[Console]::Out.WriteLine('{"ready":true}')
[Console]::Out.Flush()

while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    $line = $line.Trim()
    if (-not $line) { continue }
    $reqId = ''
    try {
        $req = $line | ConvertFrom-Json
        $reqId = [string]$req.id
        $cmd = [string]$req.cmd
        $pin = [string]$req.app
        if (-not $mgr) {
            $mgr = Await-WinRt ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
        }
        $sessions = if ($mgr) { @($mgr.GetSessions()) } else { @() }
        $best = $null
        $bestInfo = $null
        $bestPb = $null
        $bestTl = $null
        $bestScore = -99999
        $sessionList = @()

        foreach ($s in $sessions) {
            try {
                $pb = $s.GetPlaybackInfo()
                $tl = $s.GetTimelineProperties()
                $info = Await-WinRt ($s.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
                $sc = Score-Session $s $info $pb $tl $pin
                $appStr = [string]$s.SourceAppUserModelId
                $stStr = $pb.PlaybackStatus.ToString()
                $durSec = [double]$tl.EndTime.TotalSeconds
                $isDeadMessenger = ($appStr.ToLowerInvariant() -match 'ayugram|telegram|discord|whatsapp|viber') -and ($stStr -ne 'Playing') -and ($durSec -le 0)
                if ($info -and $info.Title -and -not $isDeadMessenger) {
                    $sessionList += @{
                        app = $appStr
                        appName = Get-AppDisplayName $appStr
                        title = [string]$info.Title
                        artist = [string]$info.Artist
                        status = $stStr
                    }
                    if ($sc -gt $bestScore) {
                        $bestScore = $sc
                        $best = $s
                        $bestInfo = $info
                        $bestPb = $pb
                        $bestTl = $tl
                    }
                }
            } catch {}
        }

        if ($cmd -in @('playpause', 'next', 'prev', 'seek') -and -not $best) {
            $error = if ($sessions.Count -gt 0) { 'no_track' } else { 'no_media_session' }
            [Console]::Out.WriteLine((@{ id = $reqId; ok = $false; error = $error } | ConvertTo-Json -Compress))
            [Console]::Out.Flush()
            continue
        }

        if ($cmd -eq 'status') {
            if (-not $best -or -not $bestInfo -or -not $bestInfo.Title -or $bestScore -lt 0) {
                $cachedThumbKey = ''
                $out = @{ id = $reqId; ok = $true; data = @{ sessions = $sessionList } } | ConvertTo-Json -Compress -Depth 4
                [Console]::Out.WriteLine($out)
                [Console]::Out.Flush()
                continue
            }
            $st = $bestPb.PlaybackStatus.ToString()
            $rawPos = [double]$bestTl.Position.TotalSeconds
            $startSec = [double]$bestTl.StartTime.TotalSeconds
            $dur = [double]$bestTl.EndTime.TotalSeconds
            $livePos = $rawPos
            if ($st -eq 'Playing' -and $bestTl.LastUpdatedTime.Year -gt 2000) {
                $delta = ([DateTimeOffset]::UtcNow - $bestTl.LastUpdatedTime).TotalSeconds
                if ($delta -gt 0 -and $delta -lt 43200) {
                    $livePos = $rawPos + $delta
                }
            }
            if ($dur -gt 0 -and $livePos -gt $dur) { $livePos = $dur }
            if ($livePos -lt 0) { $livePos = 0 }

            $appId = [string]$best.SourceAppUserModelId
            $tKey = $appId + '|' + [string]$bestInfo.Artist + '|' + [string]$bestInfo.Title
            $thumbB64 = ''
            $thumbMime = 'image/jpeg'
            $thumbUnchanged = $false
            if ($req.forceThumb -ne $true -and $tKey -eq $cachedThumbKey -and $cachedThumbKey -ne '') {
                $thumbUnchanged = $true
            } elseif ($bestInfo.Thumbnail) {
                try {
                    $stream = Await-WinRt ($bestInfo.Thumbnail.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStreamWithContentType])
                    if ($stream -and $asStreamMethod) {
                        $netStream = $asStreamMethod.Invoke($null, @($stream))
                        if ($netStream) {
                            $ms = New-Object System.IO.MemoryStream
                            $netStream.CopyTo($ms)
                            $bytes = $ms.ToArray()
                            $ms.Dispose()
                            $netStream.Dispose()
                            if ($bytes.Length -gt 16 -and $bytes.Length -lt 4194304) {
                                if ($bytes[0] -eq 137 -and $bytes[1] -eq 80 -and $bytes[2] -eq 78 -and $bytes[3] -eq 71) { $thumbMime = 'image/png' }
                                elseif ($bytes[0] -eq 255 -and $bytes[1] -eq 216 -and $bytes[2] -eq 255) { $thumbMime = 'image/jpeg' }
                                elseif ($bytes[0] -eq 82 -and $bytes[1] -eq 73 -and $bytes[2] -eq 70 -and $bytes[3] -eq 70) { $thumbMime = 'image/webp' }
                                elseif ($bytes[0] -eq 71 -and $bytes[1] -eq 73 -and $bytes[2] -eq 70) { $thumbMime = 'image/gif' }
                                $thumbB64 = [Convert]::ToBase64String($bytes)
                                $cachedThumbKey = $tKey
                            }
                        }
                    }
                } catch {}
            } else {
                $cachedThumbKey = ''
            }

            $volInfo = [AgyAudioVol]::GetVolumeInfo($appId)
            $payload = @{
                title = [string]$bestInfo.Title
                artist = [string]$bestInfo.Artist
                album = [string]$bestInfo.AlbumTitle
                app = $appId
                appName = Get-AppDisplayName $appId
                status = $st
                pos = [math]::Round($livePos, 2)
                rawPos = [math]::Round($rawPos, 2)
                start = [math]::Round($startSec, 2)
                dur = [math]::Round($dur, 2)
                canSeek = [bool]$bestPb.Controls.IsPlaybackPositionEnabled
                canNext = [bool]$bestPb.Controls.IsNextEnabled
                canPrev = [bool]$bestPb.Controls.IsPreviousEnabled
                volume = [int]$volInfo[0]
                muted = ([int]$volInfo[1] -eq 1)
                volumeScope = if ([int]$volInfo[2] -eq 1) { 'app' } else { 'master' }
                volumeSupported = ([int]$volInfo[3] -eq 1)
                thumbUnchanged = $thumbUnchanged
                thumb = $thumbB64
                thumbMime = $thumbMime
                sessions = $sessionList
            }
            $out = @{ id = $reqId; ok = $true; data = $payload } | ConvertTo-Json -Compress -Depth 5
            [Console]::Out.WriteLine($out)
            [Console]::Out.Flush()
        }
        elseif ($cmd -eq 'playpause') {
            $done = $false
            if ($best) {
                try { $done = [bool](Await-WinRt ($best.TryTogglePlayPauseAsync()) ([bool])) } catch {}
            }
            $fallback = $false
            if (-not $done -and $sessions.Count -eq 1) { [AgyMediaKeys]::Send(0xB3); $fallback = $true }
            $controlError = if (-not $done -and -not $fallback) { 'control_unsupported' } else { $null }
            [Console]::Out.WriteLine((@{ id = $reqId; ok = ($done -or $fallback); smtc = $done; fallback = $fallback; error = $controlError } | ConvertTo-Json -Compress))
            [Console]::Out.Flush()
        }
        elseif ($cmd -eq 'next') {
            $done = $false
            if ($best) {
                try { $done = [bool](Await-WinRt ($best.TrySkipNextAsync()) ([bool])) } catch {}
            }
            $fallback = $false
            if (-not $done -and $sessions.Count -eq 1) { [AgyMediaKeys]::Send(0xB0); $fallback = $true }
            $controlError = if (-not $done -and -not $fallback) { 'control_unsupported' } else { $null }
            $cachedThumbKey = ''
            [Console]::Out.WriteLine((@{ id = $reqId; ok = ($done -or $fallback); smtc = $done; fallback = $fallback; error = $controlError } | ConvertTo-Json -Compress))
            [Console]::Out.Flush()
        }
        elseif ($cmd -eq 'prev') {
            $done = $false
            if ($best) {
                try { $done = [bool](Await-WinRt ($best.TrySkipPreviousAsync()) ([bool])) } catch {}
            }
            $fallback = $false
            if (-not $done -and $sessions.Count -eq 1) { [AgyMediaKeys]::Send(0xB1); $fallback = $true }
            $controlError = if (-not $done -and -not $fallback) { 'control_unsupported' } else { $null }
            $cachedThumbKey = ''
            [Console]::Out.WriteLine((@{ id = $reqId; ok = ($done -or $fallback); smtc = $done; fallback = $fallback; error = $controlError } | ConvertTo-Json -Compress))
            [Console]::Out.Flush()
        }
        elseif ($cmd -eq 'seek') {
            $done = $false
            $sec = [double]$req.sec
            if ($sec -lt 0) { $sec = 0 }
            if ($best) {
                try {
                    $startSec = [double]$bestTl.StartTime.TotalSeconds
                    $endSec = [double]$bestTl.EndTime.TotalSeconds
                    $durationSec = [math]::Max(0, $endSec - $startSec)
                    if ($durationSec -gt 0 -and $sec -gt $durationSec) { $sec = $durationSec }
                    $targetSec = $startSec + $sec
                    $ticks = [int64][math]::Round($targetSec * 10000000.0)
                    $done = [bool](Await-WinRt ($best.TryChangePlaybackPositionAsync($ticks)) ([bool]))
                } catch {}
            }
            [Console]::Out.WriteLine((@{ id = $reqId; ok = $true; sought = $done; sec = $sec } | ConvertTo-Json -Compress))
            [Console]::Out.Flush()
        }
        elseif ($cmd -eq 'setvolume') {
            $hint = if ($best) { [string]$best.SourceAppUserModelId } else { [string]$req.app }
            $vArg = if ($null -ne $req.volume) { [int][math]::Round([double]$req.volume) } else { -1 }
            $mArg = if ($null -ne $req.muted) { if ([bool]$req.muted) { 1 } else { 0 } } else { -1 }
            $resVol = [AgyAudioVol]::SetVolumeInfo($hint, $vArg, $mArg)
            [Console]::Out.WriteLine((@{
                id = $reqId
                ok = ([int]$resVol[3] -eq 1)
                volume = [int]$resVol[0]
                muted = ([int]$resVol[1] -eq 1)
                volumeScope = if ([int]$resVol[2] -eq 1) { 'app' } else { 'master' }
            } | ConvertTo-Json -Compress))
            [Console]::Out.Flush()
        }
        else {
            [Console]::Out.WriteLine((@{ id = $reqId; ok = $false; error = 'unknown_cmd' } | ConvertTo-Json -Compress))
            [Console]::Out.Flush()
        }
    } catch {
        $errMsg = $_.Exception.Message
        [Console]::Out.WriteLine((@{ id = $reqId; ok = $false; error = $errMsg } | ConvertTo-Json -Compress))
        [Console]::Out.Flush()
    }
}
`;

function httpsGetJson(url, timeoutMs = 4500) {
    return new Promise((resolve) => {
        const req = https.get(
            url,
            {
                timeout: timeoutMs,
                headers: {
                    "User-Agent": "AntigravityPlayer/2.1",
                    Accept: "application/json",
                },
            },
            (res) => {
                if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    res.resume();
                    httpsGetJson(res.headers.location, timeoutMs).then(resolve);
                    return;
                }
                if (res.statusCode && res.statusCode >= 400) {
                    res.resume();
                    resolve(null);
                    return;
                }
                let body = "";
                res.on("data", (c) => {
                    body += c;
                    if (body.length > 1024 * 1024) req.destroy();
                });
                res.on("end", () => {
                    try { resolve(JSON.parse(body)); } catch { resolve(null); }
                });
            }
        );
        req.on("error", () => resolve(null));
        req.on("timeout", () => { req.destroy(); resolve(null); });
    });
}

function httpsGetBuffer(url, timeoutMs = 5000) {
    return new Promise((resolve) => {
        const req = https.get(
            url,
            { timeout: timeoutMs, headers: { "User-Agent": "AntigravityPlayer/2.1" } },
            (res) => {
                if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    res.resume();
                    httpsGetBuffer(res.headers.location, timeoutMs).then(resolve);
                    return;
                }
                if (res.statusCode && res.statusCode >= 400) {
                    res.resume();
                    resolve(null);
                    return;
                }
                const chunks = [];
                let total = 0;
                res.on("data", (c) => {
                    total += c.length;
                    if (total > 6 * 1024 * 1024) { req.destroy(); resolve(null); return; }
                    chunks.push(c);
                });
                res.on("end", () => {
                    const buf = Buffer.concat(chunks);
                    const ct = String(res.headers["content-type"] || "image/jpeg").split(";")[0].trim();
                    resolve(buf.length > 2000 ? { buf, mime: ct.startsWith("image/") ? ct : "image/jpeg" } : null);
                });
            }
        );
        req.on("error", () => resolve(null));
        req.on("timeout", () => { req.destroy(); resolve(null); });
    });
}

function cleanTrackString(s) {
    return String(s || "")
        .replace(/\((?:feat\.?|ft\.?|prod\.?|with|official|lyric|audio|video|remix|sped up|slowed)[^)]*\)/gi, "")
        .replace(/\[[^\]]*\]/g, "")
        .replace(/\s+/g, " ")
        .trim();
}

function primaryArtist(artist) {
    return String(artist || "").split(/,|&|\bfeat\.?\b|\bft\.?\b|×|;/i)[0].trim();
}

function makeCoverHash(artist, title) {
    return crypto.createHash("sha1").update((artist || "").toLowerCase() + "||" + (title || "").toLowerCase()).digest("hex").slice(0, 14);
}

function pruneCoverCache() {
    while (coverCache.size > 28) {
        const firstKey = coverCache.keys().next().value;
        coverCache.delete(firstKey);
    }
}

async function fetchHiResCoverAsync(coverHash, artist, title) {
    if (!title || coverInFlight.has(coverHash)) return;
    const existing = coverCache.get(coverHash);
    if (existing && existing.hires) return;

    coverInFlight.add(coverHash);
    try {
        const cleanT = cleanTrackString(title) || title;
        const mainA = primaryArtist(artist);
        const query = (mainA ? mainA + " " : "") + cleanT;

        let artUrl = "";

        // 1. Deezer API (1000x1000 cover_xl, great Russian & global catalog)
        const dz = await httpsGetJson("https://api.deezer.com/search?limit=5&q=" + encodeURIComponent(query), 4000);
        if (dz && Array.isArray(dz.data) && dz.data.length) {
            const match = dz.data.find((it) => {
                const t = String(it.title || "").toLowerCase();
                const a = String(it.artist?.name || "").toLowerCase();
                return (t.includes(cleanT.toLowerCase()) || cleanT.toLowerCase().includes(t)) &&
                    (!mainA || a.includes(mainA.toLowerCase()) || mainA.toLowerCase().includes(a));
            }) || dz.data[0];
            artUrl = match?.album?.cover_xl || match?.album?.cover_big || "";
        }

        // 2. Fallback: iTunes Search API (1000x1000bb.jpg)
        if (!artUrl) {
            const it = await httpsGetJson("https://itunes.apple.com/search?entity=song&limit=5&term=" + encodeURIComponent(query), 4000);
            if (it && Array.isArray(it.results) && it.results.length) {
                const raw = it.results[0].artworkUrl100 || it.results[0].artworkUrl60 || "";
                if (raw) artUrl = raw.replace(/\d+x\d+bb\./i, "1000x1000bb.");
            }
        }

        if (artUrl) {
            const img = await httpsGetBuffer(artUrl, 5000);
            if (img && img.buf && img.buf.length > 4000) {
                coverCache.set(coverHash, { buf: img.buf, mime: img.mime, hires: true });
                pruneCoverCache();
            }
        }
    } catch {} finally {
        coverInFlight.delete(coverHash);
    }
}

function getCoverByHash(hash) {
    if (!hash) return null;
    return coverCache.get(hash) || null;
}

function createDaemonScriptFile() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "antigravity-media-"));
    const filePath = path.join(directory, "media-daemon.ps1");
    try {
        fs.writeFileSync(filePath, "\uFEFF" + PS_DAEMON_SCRIPT, "utf8");
        return { directory, filePath };
    } catch (error) {
        try { fs.rmSync(directory, { recursive: true, force: true }); } catch {}
        throw error;
    }
}

function removeDaemonScriptFile(location) {
    if (!location) return;
    try { fs.rmSync(location.directory, { recursive: true, force: true }); } catch {}
}

class MediaDaemon {
    constructor() {
        this.proc = null;
        this.ready = false;
        this.starting = null;
        this.startError = "";
        this.scriptLocation = null;
        this.pending = new Map();
        this.seq = 0;
        this.lastStatus = { ts: 0, data: {} };
    }

    ensureStarted() {
        if (this.proc && !this.proc.killed && this.ready) return Promise.resolve();
        if (this.starting) return this.starting;

        let resolveStart;
        const starting = new Promise((resolve) => { resolveStart = resolve; });
        this.starting = starting;

        let child = null;
        let readyTimer = null;
        let cleaned = false;
        let scriptLocation = null;
        const settle = () => resolveStart();
        const cleanupScript = () => {
            if (!scriptLocation) return;
            removeDaemonScriptFile(scriptLocation);
            if (!fs.existsSync(scriptLocation.directory)) {
                if (this.scriptLocation === scriptLocation) this.scriptLocation = null;
                scriptLocation = null;
            }
        };
        const cleanup = (error = "daemon_exited") => {
            if (cleaned) return;
            cleaned = true;
            if (readyTimer) clearTimeout(readyTimer);
            cleanupScript();
            this.ready = false;
            this.startError = error || "daemon_exited";
            if (this.starting === starting) this.starting = null;
            if (this.proc === child) this.proc = null;
            for (const [, entry] of this.pending) {
                clearTimeout(entry.timer);
                entry.resolve({ ok: false, error: "daemon_exited" });
            }
            this.pending.clear();
            settle();
        };

        try {
            scriptLocation = createDaemonScriptFile();
            this.scriptLocation = scriptLocation;
            child = spawn(
                "powershell.exe",
                ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-File", scriptLocation.filePath],
                { stdio: ["pipe", "pipe", "pipe"], windowsHide: true }
            );
            this.proc = child;
            this.ready = false;
            this.startError = "";

            const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
            if (child.stderr) child.stderr.on("data", () => {});
            readyTimer = setTimeout(() => {
                if (this.ready) return;
                this.startError = "startup_timeout";
                try { if (child && !child.killed) child.kill(); } catch {}
                cleanup("startup_timeout");
            }, 8000);

            rl.on("line", (line) => {
                const trimmed = (line || "").trim();
                if (!trimmed || !trimmed.startsWith("{")) return;
                let msg;
                try { msg = JSON.parse(trimmed); } catch { return; }
                if (msg.ready) {
                    if (readyTimer) clearTimeout(readyTimer);
                    this.ready = true;
                    this.startError = "";
                    if (this.starting === starting) this.starting = null;
                    cleanupScript();
                    settle();
                    return;
                }
                if (msg.id && this.pending.has(msg.id)) {
                    const entry = this.pending.get(msg.id);
                    this.pending.delete(msg.id);
                    clearTimeout(entry.timer);
                    entry.resolve(msg);
                }
            });

            child.on("exit", () => cleanup("daemon_exited"));
            child.on("error", (error) => cleanup(error && error.code ? error.code : "daemon_spawn_failed"));
        } catch (error) {
            cleanupScript();
            this.ready = false;
            this.startError = error && error.code ? error.code : "daemon_start_failed";
            if (this.starting === starting) this.starting = null;
            if (this.proc === child) this.proc = null;
            settle();
        }

        return starting;
    }

    send(payload, timeoutMs = 3500) {
        return this.ensureStarted().then(() => {
            if (!this.proc || this.proc.killed || !this.proc.stdin.writable) {
                return { ok: false, error: this.startError || "daemon_unavailable" };
            }
            const id = "m" + (++this.seq);
            const msg = Object.assign({ id }, payload);
            return new Promise((resolve) => {
                const timer = setTimeout(() => {
                    this.pending.delete(id);
                    resolve({ ok: false, error: "timeout" });
                }, timeoutMs);
                this.pending.set(id, { resolve, timer });
                try {
                    this.proc.stdin.write(JSON.stringify(msg) + "\n", "utf8");
                } catch {
                    clearTimeout(timer);
                    this.pending.delete(id);
                    resolve({ ok: false, error: "write_failed" });
                }
            });
        });
    }

    async getStatus(force = false) {
        const now = Date.now();
        if (!force && this.lastStatus.data && now - this.lastStatus.ts < 650) {
            return this.lastStatus.data;
        }
        const resp = await this.send({
            cmd: "status",
            app: pinnedAppId || "",
            forceThumb: !lastSmtcBuf,
        });
        if (!resp || !resp.ok || !resp.data || typeof resp.data !== "object" || Array.isArray(resp.data)) {
            lastSmtcKey = "";
            lastSmtcBuf = null;
            const empty = { sessions: [] };
            this.lastStatus = { ts: Date.now(), data: empty };
            return empty;
        }
        const d = resp.data;
        if (!Array.isArray(d.sessions)) d.sessions = [];
        const title = String(d.title || "").trim();
        if (title) {
            d.title = title;
            const start = Number.isFinite(Number(d.start)) ? Number(d.start) : 0;
            const end = Number.isFinite(Number(d.dur)) ? Number(d.dur) : 0;
            const absolutePos = Number.isFinite(Number(d.pos)) ? Number(d.pos) : 0;
            const absoluteRawPos = Number.isFinite(Number(d.rawPos)) ? Number(d.rawPos) : absolutePos;
            const duration = Math.max(0, end - start);
            const relativePos = Math.max(0, absolutePos - start);
            const relativeRawPos = Math.max(0, absoluteRawPos - start);
            d.start = start;
            d.dur = duration;
            d.pos = duration > 0 ? Math.min(duration, relativePos) : relativePos;
            d.rawPos = duration > 0 ? Math.min(duration, relativeRawPos) : relativeRawPos;

            const coverHash = makeCoverHash(d.artist, d.title);
            const smtcKey = (d.app || "") + "|" + (d.artist || "") + "|" + d.title;

            if (d.thumb && d.thumb.length > 40) {
                const mime = d.thumbMime && d.thumbMime.startsWith("image/") ? d.thumbMime : "image/jpeg";
                lastSmtcKey = smtcKey;
                lastSmtcBuf = Buffer.from(d.thumb, "base64");
                lastSmtcMime = mime;
                if (!coverCache.has(coverHash)) {
                    coverCache.set(coverHash, { buf: lastSmtcBuf, mime: lastSmtcMime, hires: false });
                    pruneCoverCache();
                }
            } else if (!d.thumbUnchanged && lastSmtcKey !== smtcKey) {
                lastSmtcKey = smtcKey;
                lastSmtcBuf = null;
            }

            // Trigger background 1000x1000 hi-res cover upgrade!
            const cached = coverCache.get(coverHash);
            if (!cached || !cached.hires) {
                void fetchHiResCoverAsync(coverHash, d.artist, d.title);
            }

            const finalEntry = coverCache.get(coverHash);
            d.coverKey = finalEntry ? coverHash : "";
            d.coverRev = finalEntry ? (finalEntry.hires ? "hr" : "lo") : "";
        } else {
            lastSmtcKey = "";
            lastSmtcBuf = null;
            delete d.title;
            d.coverKey = "";
            d.coverRev = "";
        }

        delete d.thumb;
        delete d.thumbUnchanged;
        delete d.thumbMime;
        d.serverTimeMs = Date.now();
        d.pinnedApp = pinnedAppId || "";
        this.lastStatus = { ts: Date.now(), data: d };
        return d;
    }

    async control(cmd, extra = {}) {
        const requiresTrack = ["playpause", "next", "prev", "seek"].includes(String(cmd || ""));
        if (requiresTrack && !String(this.lastStatus.data && this.lastStatus.data.title || "").trim()) {
            this.lastStatus.ts = 0;
            return { ok: false, error: "no_media_session" };
        }
        const resp = await this.send(Object.assign({ cmd, app: pinnedAppId || "" }, extra));
        this.lastStatus.ts = 0;
        return resp;
    }

    async setVolume(opts = {}) {
        const payload = { cmd: "setvolume", app: pinnedAppId || (this.lastStatus.data && this.lastStatus.data.app) || "" };
        if (opts.volume !== undefined && Number.isFinite(Number(opts.volume))) {
            payload.volume = Math.max(0, Math.min(100, Math.round(Number(opts.volume))));
        }
        if (typeof opts.muted === "boolean") {
            payload.muted = opts.muted;
        }
        const resp = await this.send(payload);
        if (resp && resp.ok && this.lastStatus.data) {
            this.lastStatus.data.volume = resp.volume;
            this.lastStatus.data.muted = resp.muted;
            this.lastStatus.data.volumeScope = resp.volumeScope;
        }
        return resp;
    }

    selectSession(appId) {
        pinnedAppId = String(appId || "");
        lastSmtcKey = "";
        lastSmtcBuf = null;
        this.lastStatus.ts = 0;
        return { ok: true, pinnedApp: pinnedAppId };
    }

    dispose() {
        try {
            if (this.proc && !this.proc.killed) this.proc.kill();
        } catch {}
        removeDaemonScriptFile(this.scriptLocation);
        if (this.scriptLocation && !fs.existsSync(this.scriptLocation.directory)) this.scriptLocation = null;
        this.proc = null;
        this.ready = false;
    }
}

const daemon = new MediaDaemon();
if (appRef && typeof appRef.on === "function") {
    appRef.on("before-quit", () => daemon.dispose());
}

async function fetchLyrics(artist, title, durationSec = 0) {
    const rawArtist = String(artist || "").trim();
    const rawTitle = String(title || "").trim();
    const dur = Number(durationSec) > 0 ? Math.round(Number(durationSec)) : 0;
    const key = (rawArtist + "||" + rawTitle).toLowerCase();
    if (!rawTitle) return { synced: "", plain: "", found: false };
    if (lyricsCache.has(key)) return lyricsCache.get(key);

    const params = new URLSearchParams({ artist_name: rawArtist, track_name: rawTitle });
    if (dur > 0) params.set("duration", String(dur));
    let exact = await httpsGetJson("https://lrclib.net/api/get?" + params.toString());
    if (exact && (exact.syncedLyrics || exact.plainLyrics)) {
        const res = {
            synced: exact.syncedLyrics || "",
            plain: exact.plainLyrics || "",
            trackName: exact.trackName || rawTitle,
            artistName: exact.artistName || rawArtist,
            found: true,
        };
        lyricsCache.set(key, res);
        return res;
    }

    const cleanTitle = cleanTrackString(rawTitle) || rawTitle;
    const mainArtist = primaryArtist(rawArtist);
    const queries = [];
    if (mainArtist) queries.push(mainArtist + " " + cleanTitle);
    if (cleanTitle !== rawTitle && rawArtist) queries.push(rawArtist + " " + cleanTitle);
    queries.push(cleanTitle);

    const seenQueries = new Set();
    let bestPlain = null;
    for (const q of queries) {
        const qNorm = q.trim().toLowerCase();
        if (!qNorm || seenQueries.has(qNorm)) continue;
        seenQueries.add(qNorm);

        const list = await httpsGetJson("https://lrclib.net/api/search?q=" + encodeURIComponent(q.trim()));
        if (!Array.isArray(list) || !list.length) continue;

        const scored = list
            .filter((item) => item && (item.syncedLyrics || item.plainLyrics))
            .map((item) => {
                let score = 0;
                if (item.syncedLyrics) score += 60;
                if (item.plainLyrics) score += 10;
                const itTitle = String(item.trackName || "").toLowerCase();
                const itArtist = String(item.artistName || "").toLowerCase();
                if (itTitle === cleanTitle.toLowerCase() || itTitle === rawTitle.toLowerCase()) score += 45;
                else if (itTitle.includes(cleanTitle.toLowerCase()) || cleanTitle.toLowerCase().includes(itTitle)) score += 22;
                if (mainArtist && itArtist.includes(mainArtist.toLowerCase())) score += 35;
                if (dur > 0 && item.duration) {
                    const diff = Math.abs(Number(item.duration) - dur);
                    if (diff <= 2) score += 35;
                    else if (diff <= 5) score += 20;
                    else if (diff <= 12) score += 8;
                    else if (diff > 35) score -= 25;
                }
                return { item, score };
            })
            .sort((a, b) => b.score - a.score);

        if (scored.length > 0 && scored[0].score >= 30) {
            const top = scored[0].item;
            if (top.syncedLyrics) {
                const res = {
                    synced: top.syncedLyrics || "",
                    plain: top.plainLyrics || "",
                    trackName: top.trackName || rawTitle,
                    artistName: top.artistName || rawArtist,
                    found: true,
                };
                lyricsCache.set(key, res);
                return res;
            }
            if (!bestPlain) bestPlain = top;
        }
    }

    if (bestPlain) {
        const res = {
            synced: "",
            plain: bestPlain.plainLyrics || "",
            trackName: bestPlain.trackName || rawTitle,
            artistName: bestPlain.artistName || rawArtist,
            found: true,
        };
        lyricsCache.set(key, res);
        return res;
    }

    const empty = { synced: "", plain: "", found: false };
    lyricsCache.set(key, empty);
    return empty;
}

module.exports = {
    mediaDaemon: daemon,
    fetchLyrics,
    getCoverByHash,
};
