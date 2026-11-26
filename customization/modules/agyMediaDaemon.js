"use strict";
const https = require("https");
const http = require("http");
const net = require("net");
const dns = require("dns");
const { fileURLToPath } = require("url");
const crypto = require("crypto");
const readline = require("readline");
const { spawn, execFile } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

let appRef = null;
try { appRef = require("electron").app; } catch {}

const lyricsCache = new Map(); // key -> { val: object, ts: number }
const lyricsInFlight = new Map(); // key -> Promise<object>
const MAX_LYRICS_CACHE = 100;
const LYRICS_MISS_TTL_MS = 30 * 1000;
const coverCache = new Map(); // coverKey -> { buf: Buffer, mime: string, hires: boolean }
const coverInFlight = new Set();

function isValidMprisTarget(target) {
    return typeof target === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(target);
}

function isValidDbusObjectPath(trackId) {
    return typeof trackId === "string" && /^\/[A-Za-z0-9_\/.-]{1,256}$/.test(trackId);
}

function getLyricsCached(key, now = Date.now()) {
    const entry = lyricsCache.get(key);
    if (!entry) return null;
    if (!entry.val.found && (now - entry.ts) > LYRICS_MISS_TTL_MS) {
        lyricsCache.delete(key);
        return null;
    }
    // LRU touch
    lyricsCache.delete(key);
    lyricsCache.set(key, entry);
    return entry.val;
}

function setLyricsCached(key, val, now = Date.now()) {
    if (lyricsCache.has(key)) lyricsCache.delete(key);
    lyricsCache.set(key, { val, ts: now });
    while (lyricsCache.size > MAX_LYRICS_CACHE) {
        const oldestKey = lyricsCache.keys().next().value;
        lyricsCache.delete(oldestKey);
    }
}

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

function strictDetectImageMime(buf) {
    if (!buf || buf.length < 16) return null;
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
    if (buf.subarray(0, 4).toString("ascii") === "RIFF" && buf.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
    const gifSig = buf.subarray(0, 6).toString("ascii");
    if (gifSig === "GIF87a" || gifSig === "GIF89a") return "image/gif";
    return null;
}

function expandIpv6Hextets(ip) {
    let s = String(ip || "").trim().toLowerCase();
    if (!s) return null;
    if (s.includes(".")) {
        const lastColon = s.lastIndexOf(":");
        if (lastColon < 0) return null;
        const ipv4Part = s.slice(lastColon + 1);
        if (!net.isIPv4(ipv4Part)) return null;
        const octets = ipv4Part.split(".").map((n) => parseInt(n, 10));
        if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
        const hHigh = ((octets[0] << 8) | octets[1]).toString(16);
        const hLow = ((octets[2] << 8) | octets[3]).toString(16);
        s = s.slice(0, lastColon + 1) + hHigh + ":" + hLow;
    }
    const doubleColonParts = s.split("::");
    if (doubleColonParts.length > 2) return null;
    let groups;
    if (doubleColonParts.length === 2) {
        const left = doubleColonParts[0] ? doubleColonParts[0].split(":") : [];
        const right = doubleColonParts[1] ? doubleColonParts[1].split(":") : [];
        const fillCount = 8 - (left.length + right.length);
        if (fillCount < 1) return null;
        groups = [...left, ...new Array(fillCount).fill("0"), ...right];
    } else {
        groups = s.split(":");
    }
    if (groups.length !== 8) return null;
    const nums = [];
    for (const g of groups) {
        if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
        nums.push(parseInt(g, 16));
    }
    return nums;
}

function hextetsToIpv4(hHi, hLo) {
    return `${(hHi >> 8) & 0xff}.${hHi & 0xff}.${(hLo >> 8) & 0xff}.${hLo & 0xff}`;
}

function isPrivateOrReservedIp(rawIp) {
    let ip = String(rawIp || "").trim().toLowerCase();
    if (!ip) return true;
    if (ip.startsWith("[") && ip.endsWith("]")) ip = ip.slice(1, -1);
    const zoneIdx = ip.indexOf("%");
    if (zoneIdx >= 0) ip = ip.slice(0, zoneIdx);

    if (ip.startsWith("::ffff:")) {
        const mapped = ip.slice(7);
        if (net.isIPv4(mapped)) return isPrivateOrReservedIp(mapped);
    }

    if (net.isIPv4(ip)) {
        const parts = ip.split(".").map((n) => parseInt(n, 10));
        if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
        const [a, b] = parts;
        if (a === 0 || a === 10 || a === 127) return true;
        if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
        if (a === 169 && b === 254) return true; // Link-local / metadata
        if (a === 172 && b >= 16 && b <= 31) return true;
        if (a === 192 && b === 168) return true;
        if (a >= 224) return true; // Multicast & reserved
        return false;
    }

    if (net.isIPv6(ip)) {
        const hextets = expandIpv6Hextets(ip);
        if (!hextets) return true;
        const isAllZeroPrefix = hextets[0] === 0 && hextets[1] === 0 && hextets[2] === 0 && hextets[3] === 0;
        // IPv4-mapped ::ffff:a.b.c.d / ::ffff:XXXX:XXXX and IPv4-translated ::ffff:0:a.b.c.d
        if (isAllZeroPrefix && hextets[4] === 0 && hextets[5] === 0xffff) {
            return isPrivateOrReservedIp(hextetsToIpv4(hextets[6], hextets[7]));
        }
        if (isAllZeroPrefix && hextets[4] === 0xffff && hextets[5] === 0) {
            return isPrivateOrReservedIp(hextetsToIpv4(hextets[6], hextets[7]));
        }
        // Unspecified ::, loopback ::1, and deprecated IPv4-compatible ::a.b.c.d
        if (isAllZeroPrefix && hextets[4] === 0 && hextets[5] === 0) {
            if (hextets[6] === 0 && hextets[7] <= 1) return true;
            return isPrivateOrReservedIp(hextetsToIpv4(hextets[6], hextets[7]));
        }
        // NAT64 well-known prefixes (64:ff9b::/96 and 64:ff9b:1::/48)
        if (hextets[0] === 0x0064 && hextets[1] === 0xff9b && (hextets[2] === 0 || hextets[2] === 1)) {
            return isPrivateOrReservedIp(hextetsToIpv4(hextets[6], hextets[7]));
        }
        const h0 = hextets[0];
        if ((h0 & 0xfe00) === 0xfc00) return true; // fc00::/7 ULA
        if ((h0 & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
        if ((h0 & 0xff00) === 0xff00) return true; // ff00::/8 multicast
        return false;
    }

    return true;
}

function isSafePublicArtUrl(urlStr) {
    try {
        const parsed = new URL(String(urlStr || ""));
        if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
        let host = parsed.hostname.toLowerCase();
        if (!host) return false;
        if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
        if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
            return false;
        }
        if (net.isIP(host)) {
            return !isPrivateOrReservedIp(host);
        }
        return true;
    } catch {
        return false;
    }
}

async function resolvePublicHost(hostname) {
    let host = String(hostname || "").trim().toLowerCase();
    if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
    if (!host) return null;
    if (net.isIP(host)) {
        if (isPrivateOrReservedIp(host)) return null;
        return { address: host, family: net.isIPv6(host) ? 6 : 4 };
    }
    try {
        const addrs = await dns.promises.lookup(host, { all: true, verbatim: true });
        if (!Array.isArray(addrs) || addrs.length === 0) return null;
        for (const a of addrs) {
            if (!a || !a.address || isPrivateOrReservedIp(a.address)) return null;
        }
        return { address: addrs[0].address, family: addrs[0].family || (net.isIPv6(addrs[0].address) ? 6 : 4) };
    } catch {
        return null;
    }
}

async function resolvePinnedPublicUrl(urlStr, { httpsOnly = false } = {}) {
    if (!isSafePublicArtUrl(urlStr)) return null;
    let parsed;
    try { parsed = new URL(String(urlStr || "")); } catch { return null; }
    if (httpsOnly && parsed.protocol !== "https:") return null;
    const resolved = await resolvePublicHost(parsed.hostname);
    if (!resolved) return null;
    const pinnedLookup = (_hostname, options, cb) => {
        if (typeof options === "function") {
            options(null, resolved.address, resolved.family);
            return;
        }
        if (options && options.all) {
            cb(null, [{ address: resolved.address, family: resolved.family }]);
            return;
        }
        cb(null, resolved.address, resolved.family);
    };
    return { parsed, pinnedLookup };
}

async function httpsGetJson(url, timeoutMs = 4500, redirectsLeft = 3) {
    const target = await resolvePinnedPublicUrl(url, { httpsOnly: true });
    if (!target) return null;
    const { parsed, pinnedLookup } = target;
    return new Promise((resolve) => {
        let done = false;
        const finish = (val) => { if (done) return; done = true; resolve(val); };
        let req;
        try {
            req = https.get(
                parsed,
                {
                    timeout: timeoutMs,
                    lookup: pinnedLookup,
                    headers: {
                        "User-Agent": "AntigravityPlayer/2.1",
                        Accept: "application/json",
                    },
                },
                (res) => {
                    if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                        res.resume();
                        if (redirectsLeft <= 0) { finish(null); return; }
                        try {
                            const nextUrl = new URL(res.headers.location, parsed).toString();
                            httpsGetJson(nextUrl, timeoutMs, redirectsLeft - 1).then(finish);
                        } catch { finish(null); }
                        return;
                    }
                    if (res.statusCode !== 200) {
                        res.resume();
                        finish(null);
                        return;
                    }
                    const chunks = [];
                    let total = 0;
                    res.on("data", (c) => {
                        const b = Buffer.isBuffer(c) ? c : Buffer.from(c);
                        total += b.length;
                        if (total > 1024 * 1024) { req.destroy(); finish(null); return; }
                        chunks.push(b);
                    });
                    res.on("error", () => finish(null));
                    res.on("end", () => {
                        try { finish(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { finish(null); }
                    });
                }
            );
        } catch {
            finish(null);
            return;
        }
        req.on("error", () => finish(null));
        req.on("timeout", () => { req.destroy(); finish(null); });
    });
}

async function httpsGetBuffer(url, timeoutMs = 5000, redirectsLeft = 3) {
    const target = await resolvePinnedPublicUrl(url, { httpsOnly: true });
    if (!target) return null;
    const { parsed, pinnedLookup } = target;
    return new Promise((resolve) => {
        let done = false;
        const finish = (val) => { if (done) return; done = true; resolve(val); };
        let req;
        try {
            req = https.get(
                parsed,
                {
                    timeout: timeoutMs,
                    lookup: pinnedLookup,
                    headers: { "User-Agent": "AntigravityPlayer/2.1" },
                },
                (res) => {
                    if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                        res.resume();
                        if (redirectsLeft <= 0) { finish(null); return; }
                        try {
                            const nextUrl = new URL(res.headers.location, parsed).toString();
                            httpsGetBuffer(nextUrl, timeoutMs, redirectsLeft - 1).then(finish);
                        } catch { finish(null); }
                        return;
                    }
                    if (res.statusCode !== 200) {
                        res.resume();
                        finish(null);
                        return;
                    }
                    const chunks = [];
                    let total = 0;
                    res.on("data", (c) => {
                        const b = Buffer.isBuffer(c) ? c : Buffer.from(c);
                        total += b.length;
                        if (total > 6 * 1024 * 1024) { req.destroy(); finish(null); return; }
                        chunks.push(b);
                    });
                    res.on("error", () => finish(null));
                    res.on("end", () => {
                        const buf = Buffer.concat(chunks);
                        const mime = strictDetectImageMime(buf);
                        finish(buf.length > 2000 && mime ? { buf, mime } : null);
                    });
                }
            );
        } catch {
            finish(null);
            return;
        }
        req.on("error", () => finish(null));
        req.on("timeout", () => { req.destroy(); finish(null); });
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
        this._startSettle = null;
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
        let rl = null;
        let readyTimer = null;
        let cleaned = false;
        let scriptLocation = null;
        const settle = () => {
            if (this._startSettle === settle) this._startSettle = null;
            resolveStart();
        };
        this._startSettle = settle;
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
            const timerRef = readyTimer;
            readyTimer = null;
            if (timerRef) {
                clearTimeout(timerRef);
                if (this._readyTimer === timerRef) this._readyTimer = null;
            }
            const rlRef = rl;
            rl = null;
            if (rlRef) {
                try { rlRef.close(); } catch {}
                if (this._rl === rlRef) this._rl = null;
            }
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

            child.stdin?.on?.("error", () => {});
            rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
            this._rl = rl;
            if (child.stderr) child.stderr.on("data", () => {});
            readyTimer = setTimeout(() => {
                if (this.ready) return;
                this.startError = "startup_timeout";
                try { if (child && !child.killed) child.kill(); } catch {}
                cleanup("startup_timeout");
            }, 8000);
            this._readyTimer = readyTimer;

            rl.on("line", (line) => {
                const trimmed = (line || "").trim();
                if (!trimmed || !trimmed.startsWith("{")) return;
                let msg;
                try { msg = JSON.parse(trimmed); } catch { return; }
                if (msg.ready) {
                    const timerRef = readyTimer;
                    readyTimer = null;
                    if (timerRef) {
                        clearTimeout(timerRef);
                        if (this._readyTimer === timerRef) this._readyTimer = null;
                    }
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
        if (!force && this._statusInFlight) {
            return this._statusInFlight;
        }
        const p = this._fetchStatusInternal().finally(() => {
            if (this._statusInFlight === p) this._statusInFlight = null;
        });
        this._statusInFlight = p;
        return p;
    }

    async _fetchStatusInternal() {
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
        if (this._readyTimer) {
            clearTimeout(this._readyTimer);
            this._readyTimer = null;
        }
        if (this._rl) {
            try { this._rl.close(); } catch {}
            this._rl = null;
        }
        for (const [, entry] of this.pending) {
            clearTimeout(entry.timer);
            entry.resolve({ ok: false, error: "disposed" });
        }
        this.pending.clear();
        try {
            if (this.proc && !this.proc.killed) this.proc.kill();
        } catch {}
        removeDaemonScriptFile(this.scriptLocation);
        if (this.scriptLocation && !fs.existsSync(this.scriptLocation.directory)) this.scriptLocation = null;
        this.proc = null;
        this.ready = false;
        this.starting = null;
        if (!this.startError) this.startError = "disposed";
        if (typeof this._startSettle === "function") {
            const settle = this._startSettle;
            this._startSettle = null;
            settle();
        }
    }
}

// =========================================================================
// Linux Native Media Daemon (MPRIS2 over D-Bus + PipeWire / PulseAudio)
// =========================================================================

function runCmdLinux(cmd, args, timeoutMs = 2000) {
    return new Promise((resolve) => {
        execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024, encoding: "utf8" }, (err, stdout, stderr) => {
            resolve({
                ok: !err,
                code: err ? (err.code ?? 1) : 0,
                stdout: String(stdout || ""),
                stderr: String(stderr || ""),
            });
        });
    });
}

function getLinuxAppDisplayName(appId) {
    const a = String(appId || "").toLowerCase();
    if (/yandex/.test(a)) return "Яндекс Музыка";
    if (/spotify/.test(a)) return "Spotify";
    if (/applemusic|itunes/.test(a)) return "Apple Music";
    if (/chromium|chrome/.test(a)) return "Chrome";
    if (/msedge|edge/.test(a)) return "Edge";
    if (/firefox|zen|librewolf/.test(a)) return "Firefox";
    if (/opera/.test(a)) return "Opera";
    if (/brave/.test(a)) return "Brave";
    if (/vivaldi/.test(a)) return "Vivaldi";
    if (/vlc/.test(a)) return "VLC";
    if (/mpv/.test(a)) return "mpv";
    if (/rhythmbox/.test(a)) return "Rhythmbox";
    if (/audacious/.test(a)) return "Audacious";
    if (/strawberry|clementine/.test(a)) return "Strawberry";
    if (/elisa/.test(a)) return "Elisa";
    if (/amberol/.test(a)) return "Amberol";
    if (/tidal/.test(a)) return "TIDAL";
    if (/deezer/.test(a)) return "Deezer";
    if (/vk|boom/.test(a)) return "VK Музыка";
    if (/ayugram|telegram/.test(a)) return "Telegram";
    if (/discord|vesktop/.test(a)) return "Discord";
    const clean = String(appId || "").replace(/^org\.mpris\.MediaPlayer2\./i, "").split(".")[0];
    return clean ? clean.charAt(0).toUpperCase() + clean.slice(1) : "Медиа";
}

function scoreLinuxSession(appId, title, status, durSec, pin) {
    let score = 0;
    const a = String(appId || "").toLowerCase();
    const st = String(status || "");
    if (pin && appId === pin) score += 500;
    if (st === "Playing") score += 120;
    else if (st === "Paused") score += 55;
    else if (st === "Stopped") score -= 30;
    if (/yandex|spotify|applemusic|rhythmbox|audacious|strawberry|clementine|elisa|amberol|tidal|deezer|music/.test(a)) score += 40;
    else if (/chrome|chromium|edge|firefox|opera|brave|vivaldi|vlc|mpv/.test(a)) score += 22;
    else if (/ayugram|telegram|discord|vesktop|whatsapp|viber/.test(a)) {
        if (st !== "Playing") score -= 80;
    }
    if (title) score += 15;
    if (durSec > 10) score += 15;
    return score;
}

function detectImageMime(buf) {
    if (!buf || buf.length < 12) return "image/jpeg";
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
    if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46) return "image/webp";
    if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return "image/gif";
    return "image/jpeg";
}

async function httpOrHttpsGetBuffer(urlStr, timeoutMs = 4500, redirectsLeft = 3) {
    const target = await resolvePinnedPublicUrl(urlStr);
    if (!target) {
        return null;
    }
    const { parsed, pinnedLookup } = target;
    const client = parsed.protocol === "https:" ? https : http;

    return new Promise((resolve) => {
        let done = false;
        const finish = (val) => { if (done) return; done = true; resolve(val); };
        let req;
        try {
            req = client.get(
                parsed,
                {
                    timeout: timeoutMs,
                    lookup: pinnedLookup,
                    headers: { "User-Agent": "AntigravityPlayer/2.1" },
                },
                (res) => {
                    if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                        res.resume();
                        if (redirectsLeft <= 0) { finish(null); return; }
                        try {
                            const nextUrl = new URL(res.headers.location, parsed).toString();
                            httpOrHttpsGetBuffer(nextUrl, timeoutMs, redirectsLeft - 1).then(finish);
                        } catch { finish(null); }
                        return;
                    }
                    if (res.statusCode !== 200) {
                        res.resume();
                        finish(null);
                        return;
                    }
                    const chunks = [];
                    let total = 0;
                    res.on("data", (c) => {
                        const b = Buffer.isBuffer(c) ? c : Buffer.from(c);
                        total += b.length;
                        if (total > 6 * 1024 * 1024) { req.destroy(); finish(null); return; }
                        chunks.push(b);
                    });
                    res.on("error", () => finish(null));
                    res.on("end", () => {
                        const buf = Buffer.concat(chunks);
                        const mime = strictDetectImageMime(buf);
                        finish(buf.length > 64 && mime ? { buf, mime } : null);
                    });
                }
            );
        } catch {
            finish(null);
            return;
        }
        req.on("error", () => finish(null));
        req.on("timeout", () => { req.destroy(); finish(null); });
    });
}

function parseGVariantUnescape(s) {
    return String(s || "")
        .replace(/\\'/g, "'")
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, "\\");
}

function parseGdbusPlayerProps(raw) {
    const text = String(raw || "");
    const statusMatch = /'PlaybackStatus':\s*<'([^']*)'>/.exec(text);
    const posMatch = /'Position':\s*<(?:int64\s+|uint64\s+)?(\d+)>/.exec(text);
    const canSeekMatch = /'CanSeek':\s*<(true|false)>/.exec(text);
    const canNextMatch = /'CanGoNext':\s*<(true|false)>/.exec(text);
    const canPrevMatch = /'CanGoPrevious':\s*<(true|false)>/.exec(text);

    const titleMatch = /'xesam:title':\s*<'((?:\\.|[^'\\])*)'>/.exec(text);
    const albumMatch = /'xesam:album':\s*<'((?:\\.|[^'\\])*)'>/.exec(text);
    const artMatch = /'mpris:artUrl':\s*<'((?:\\.|[^'\\])*)'>/.exec(text);
    const trackIdMatch = /'mpris:trackid':\s*<(?:objectpath\s+)?'((?:\\.|[^'\\])*)'>/.exec(text);
    const lenMatch = /'mpris:length':\s*<(?:int64\s+|uint64\s+)?(\d+)>/.exec(text);

    let artist = "";
    const artistArrMatch = /'xesam:artist':\s*<\[([^\]]*)\]>/.exec(text);
    if (artistArrMatch) {
        const names = [];
        const itemRe = /'((?:\\.|[^'\\])*)'/g;
        let m;
        while ((m = itemRe.exec(artistArrMatch[1])) !== null) {
            names.push(parseGVariantUnescape(m[1]));
        }
        artist = names.join(", ");
    } else {
        const artistStrMatch = /'xesam:artist':\s*<'((?:\\.|[^'\\])*)'>/.exec(text);
        if (artistStrMatch) artist = parseGVariantUnescape(artistStrMatch[1]);
    }

    return {
        status: statusMatch ? statusMatch[1] : "Stopped",
        posSec: posMatch ? Number(posMatch[1]) / 1e6 : 0,
        durSec: lenMatch ? Number(lenMatch[1]) / 1e6 : 0,
        title: titleMatch ? parseGVariantUnescape(titleMatch[1]) : "",
        artist,
        album: albumMatch ? parseGVariantUnescape(albumMatch[1]) : "",
        artUrl: artMatch ? parseGVariantUnescape(artMatch[1]) : "",
        trackId: trackIdMatch ? parseGVariantUnescape(trackIdMatch[1]) : "",
        canSeek: canSeekMatch ? canSeekMatch[1] === "true" : true,
        canNext: canNextMatch ? canNextMatch[1] === "true" : true,
        canPrev: canPrevMatch ? canPrevMatch[1] === "true" : true,
    };
}

function matchesLinuxAudioApp(appHint, propText) {
    if (!appHint || !propText) return false;
    const h = String(appHint).toLowerCase().replace(/^org\.mpris\.mediaplayer2\./, "").split(".")[0];
    const p = String(propText).toLowerCase();
    const keys = [
        "yandex", "spotify", "chrome", "chromium", "edge", "firefox", "opera",
        "brave", "vivaldi", "vlc", "mpv", "rhythmbox", "audacious", "strawberry",
        "elisa", "amberol", "tidal", "deezer", "telegram", "ayugram", "discord", "vesktop",
    ];
    for (const k of keys) {
        if (h.includes(k) && p.includes(k)) return true;
    }
    return h.length >= 3 && p.includes(h);
}

class LinuxMediaDaemon {
    constructor() {
        this.lastStatus = { ts: 0, data: {} };
        this._mprisBackend = null; // "playerctl" | "gdbus" | "none"
        this._audioBackend = null; // "pactl" | "wpctl" | "amixer" | "none"
        this._trackIdByPlayer = new Map();
        this._artInFlight = new Set();
    }

    async _detectMprisBackend() {
        if (this._mprisBackend !== null) return this._mprisBackend;
        const p = await runCmdLinux("playerctl", ["--version"], 1200);
        if (p.ok) { this._mprisBackend = "playerctl"; return "playerctl"; }
        const g = await runCmdLinux("gdbus", ["--version"], 1200);
        if (g.ok) { this._mprisBackend = "gdbus"; return "gdbus"; }
        this._mprisBackend = "none";
        return "none";
    }

    async _detectAudioBackend() {
        if (this._audioBackend !== null) return this._audioBackend;
        const pa = await runCmdLinux("pactl", ["--version"], 1200);
        if (pa.ok) { this._audioBackend = "pactl"; return "pactl"; }
        const wp = await runCmdLinux("wpctl", ["--version"], 1200);
        if (wp.ok) { this._audioBackend = "wpctl"; return "wpctl"; }
        const am = await runCmdLinux("amixer", ["--version"], 1200);
        if (am.ok) { this._audioBackend = "amixer"; return "amixer"; }
        this._audioBackend = "none";
        return "none";
    }

    async _listPlayersViaPlayerctl() {
        const res = await runCmdLinux("playerctl", ["-l"], 1500);
        if (!res.ok || !res.stdout.trim()) return [];
        const names = res.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
        const out = [];
        const sep = "\x1f";
        const fmt = [
            "{{status}}",
            "{{title}}",
            "{{artist}}",
            "{{album}}",
            "{{position}}",
            "{{mpris:length}}",
            "{{mpris:artUrl}}",
            "{{mpris:trackid}}",
        ].join(sep);

        await Promise.all(names.map(async (player) => {
            if (!isValidMprisTarget(player)) return;
            const meta = await runCmdLinux("playerctl", ["-p", player, "--format", fmt, "--", "metadata"], 1500);
            if (!meta.ok) return;
            const parts = meta.stdout.replace(/\r?\n$/, "").split(sep);
            const status = (parts[0] || "Stopped").trim();
            const title = (parts[1] || "").trim();
            const artist = (parts[2] || "").trim();
            const album = (parts[3] || "").trim();
            const posUs = Number(parts[4]) || 0;
            const lenUs = Number(parts[5]) || 0;
            const artUrl = (parts[6] || "").trim();
            const trackId = (parts[7] || "").trim();
            if (trackId) this._trackIdByPlayer.set(player, trackId);
            out.push({
                app: player,
                status,
                title,
                artist,
                album,
                posSec: posUs / 1e6,
                durSec: lenUs / 1e6,
                artUrl,
                trackId,
                canSeek: lenUs > 0,
                canNext: true,
                canPrev: true,
            });
        }));
        return out;
    }

    async _listPlayersViaGdbus() {
        const listRes = await runCmdLinux("gdbus", [
            "call", "--session",
            "--dest", "org.freedesktop.DBus",
            "--object-path", "/org/freedesktop/DBus",
            "--method", "org.freedesktop.DBus.ListNames",
        ], 1500);
        if (!listRes.ok) return [];
        const busNames = [];
        const re = /'(org\.mpris\.MediaPlayer2\.[^']+)'/g;
        let m;
        while ((m = re.exec(listRes.stdout)) !== null) {
            busNames.push(m[1]);
        }
        if (!busNames.length) return [];

        const out = [];
        await Promise.all(busNames.map(async (busName) => {
            const propsRes = await runCmdLinux("gdbus", [
                "call", "--session",
                "--dest", busName,
                "--object-path", "/org/mpris/MediaPlayer2",
                "--method", "org.freedesktop.DBus.Properties.GetAll",
                "org.mpris.MediaPlayer2.Player",
            ], 1500);
            if (!propsRes.ok) return;
            const parsed = parseGdbusPlayerProps(propsRes.stdout);
            if (parsed.trackId) this._trackIdByPlayer.set(busName, parsed.trackId);
            out.push({ app: busName, ...parsed });
        }));
        return out;
    }

    async _getVolumeInfo(appHint) {
        const backend = await this._detectAudioBackend();
        if (backend === "pactl") {
            if (appHint) {
                const inputs = await runCmdLinux("pactl", ["list", "sink-inputs"], 1500);
                if (inputs.ok && inputs.stdout) {
                    const blocks = inputs.stdout.split(/Sink Input #/).slice(1);
                    for (const b of blocks) {
                        if (!matchesLinuxAudioApp(appHint, b)) continue;
                        const volMatch = /Volume:[^\n]*?(\d+)%/.exec(b);
                        const muteMatch = /Mute:\s*(yes|no)/i.exec(b);
                        if (volMatch) {
                            return {
                                volume: Math.max(0, Math.min(100, parseInt(volMatch[1], 10))),
                                muted: muteMatch ? muteMatch[1].toLowerCase() === "yes" : false,
                                volumeScope: "app",
                                volumeSupported: true,
                            };
                        }
                    }
                }
            }
            const [vRes, mRes] = await Promise.all([
                runCmdLinux("pactl", ["get-sink-volume", "@DEFAULT_SINK@"], 1200),
                runCmdLinux("pactl", ["get-sink-mute", "@DEFAULT_SINK@"], 1200),
            ]);
            const vMatch = /(\d+)%/.exec(vRes.stdout);
            if (vRes.ok && vMatch) {
                return {
                    volume: Math.max(0, Math.min(100, parseInt(vMatch[1], 10))),
                    muted: /yes/i.test(mRes.stdout),
                    volumeScope: "master",
                    volumeSupported: true,
                };
            }
        } else if (backend === "wpctl") {
            const res = await runCmdLinux("wpctl", ["get-volume", "@DEFAULT_AUDIO_SINK@"], 1200);
            const m = /Volume:\s*([0-9.]+)/.exec(res.stdout);
            if (res.ok && m) {
                return {
                    volume: Math.max(0, Math.min(100, Math.round(parseFloat(m[1]) * 100))),
                    muted: /\[MUTED\]/i.test(res.stdout),
                    volumeScope: "master",
                    volumeSupported: true,
                };
            }
        } else if (backend === "amixer") {
            const res = await runCmdLinux("amixer", ["sget", "Master"], 1200);
            const m = /\[(\d+)%\]/.exec(res.stdout);
            if (res.ok && m) {
                return {
                    volume: Math.max(0, Math.min(100, parseInt(m[1], 10))),
                    muted: /\[off\]/i.test(res.stdout),
                    volumeScope: "master",
                    volumeSupported: true,
                };
            }
        }
        return { volume: 100, muted: false, volumeScope: "master", volumeSupported: false };
    }

    async _setVolumeInfo(appHint, volPercent, muteMode) {
        const backend = await this._detectAudioBackend();
        if (backend === "pactl") {
            if (appHint) {
                const inputs = await runCmdLinux("pactl", ["list", "sink-inputs"], 1500);
                if (inputs.ok && inputs.stdout) {
                    const blocks = inputs.stdout.split(/Sink Input #/).slice(1);
                    const matchedIds = [];
                    for (const b of blocks) {
                        const idMatch = /^(\d+)/.exec(b);
                        if (idMatch && matchesLinuxAudioApp(appHint, b)) {
                            matchedIds.push(idMatch[1]);
                        }
                    }
                    if (matchedIds.length > 0) {
                        for (const id of matchedIds) {
                            if (volPercent >= 0) await runCmdLinux("pactl", ["set-sink-input-volume", id, `${volPercent}%`], 1200);
                            if (muteMode >= 0) await runCmdLinux("pactl", ["set-sink-input-mute", id, muteMode ? "1" : "0"], 1200);
                        }
                        const info = await this._getVolumeInfo(appHint);
                        return { ok: true, ...info };
                    }
                }
            }
            if (volPercent >= 0) await runCmdLinux("pactl", ["set-sink-volume", "@DEFAULT_SINK@", `${volPercent}%`], 1200);
            if (muteMode >= 0) await runCmdLinux("pactl", ["set-sink-mute", "@DEFAULT_SINK@", muteMode ? "1" : "0"], 1200);
            const info = await this._getVolumeInfo("");
            return { ok: info.volumeSupported, ...info };
        } else if (backend === "wpctl") {
            if (volPercent >= 0) await runCmdLinux("wpctl", ["set-volume", "@DEFAULT_AUDIO_SINK@", (volPercent / 100).toFixed(2)], 1200);
            if (muteMode >= 0) await runCmdLinux("wpctl", ["set-mute", "@DEFAULT_AUDIO_SINK@", muteMode ? "1" : "0"], 1200);
            const info = await this._getVolumeInfo("");
            return { ok: info.volumeSupported, ...info };
        } else if (backend === "amixer") {
            if (volPercent >= 0) await runCmdLinux("amixer", ["sset", "Master", `${volPercent}%`], 1200);
            if (muteMode >= 0) await runCmdLinux("amixer", ["sset", "Master", muteMode ? "mute" : "unmute"], 1200);
            const info = await this._getVolumeInfo("");
            return { ok: info.volumeSupported, ...info };
        }
        return { ok: false, volume: 100, muted: false, volumeScope: "master" };
    }

    _loadArtUrlAsync(coverHash, artUrl) {
        if (!artUrl || coverCache.has(coverHash) || this._artInFlight.has(coverHash)) return;
        if (artUrl.startsWith("file://")) {
            try {
                const filePath = fileURLToPath(artUrl);
                if (/^\/(?:proc|sys|dev|etc)(?:\/|$)/.test(filePath)) return;
                const st = fs.lstatSync(filePath);
                if (!st.isFile() || st.size <= 64 || st.size >= 6 * 1024 * 1024) return;
                this._artInFlight.add(coverHash);
                void fs.promises.readFile(filePath).then((buf) => {
                    const mime = strictDetectImageMime(buf);
                    if (mime && !coverCache.has(coverHash)) {
                        coverCache.set(coverHash, { buf, mime, hires: false });
                        pruneCoverCache();
                    }
                }).catch(() => {}).finally(() => {
                    this._artInFlight.delete(coverHash);
                });
            } catch {}
            return;
        }
        if (isSafePublicArtUrl(artUrl)) {
            this._artInFlight.add(coverHash);
            void httpOrHttpsGetBuffer(artUrl, 4000).then((img) => {
                if (img && img.buf && img.mime && !coverCache.has(coverHash)) {
                    coverCache.set(coverHash, { buf: img.buf, mime: img.mime, hires: false });
                    pruneCoverCache();
                }
            }).catch(() => {}).finally(() => {
                this._artInFlight.delete(coverHash);
            });
        }
    }

    async getStatus(force = false) {
        const now = Date.now();
        if (!force && this.lastStatus.data && now - this.lastStatus.ts < 650) {
            return this.lastStatus.data;
        }
        if (!force && this._statusInFlight) {
            return this._statusInFlight;
        }
        const p = this._fetchLinuxStatusInternal().finally(() => {
            if (this._statusInFlight === p) this._statusInFlight = null;
        });
        this._statusInFlight = p;
        return p;
    }

    async _fetchLinuxStatusInternal() {
        const backend = await this._detectMprisBackend();
        if (backend === "none") {
            const empty = { sessions: [] };
            this.lastStatus = { ts: Date.now(), data: empty };
            return empty;
        }

        const players = backend === "playerctl"
            ? await this._listPlayersViaPlayerctl()
            : await this._listPlayersViaGdbus();

        let best = null;
        let bestScore = -99999;
        const sessionList = [];

        for (const p of players) {
            const isDeadMessenger = /ayugram|telegram|discord|vesktop|whatsapp|viber/i.test(p.app) && p.status !== "Playing" && p.durSec <= 0;
            if (!p.title || isDeadMessenger) continue;
            sessionList.push({
                app: p.app,
                appName: getLinuxAppDisplayName(p.app),
                title: p.title,
                artist: p.artist,
                status: p.status,
            });
            const sc = scoreLinuxSession(p.app, p.title, p.status, p.durSec, pinnedAppId);
            if (sc > bestScore) {
                bestScore = sc;
                best = p;
            }
        }

        if (!best || bestScore < 0) {
            const empty = { sessions: sessionList, pinnedApp: pinnedAppId || "", serverTimeMs: Date.now() };
            this.lastStatus = { ts: Date.now(), data: empty };
            return empty;
        }

        const coverHash = makeCoverHash(best.artist, best.title);
        if (best.artUrl) {
            this._loadArtUrlAsync(coverHash, best.artUrl);
        }
        const cached = coverCache.get(coverHash);
        if (!cached || !cached.hires) {
            void fetchHiResCoverAsync(coverHash, best.artist, best.title);
        }
        const finalEntry = coverCache.get(coverHash);
        const volInfo = await this._getVolumeInfo(best.app);
        const dur = Math.max(0, Number(best.durSec) || 0);
        const pos = Math.max(0, dur > 0 ? Math.min(dur, Number(best.posSec) || 0) : (Number(best.posSec) || 0));

        const d = {
            title: best.title,
            artist: best.artist,
            album: best.album,
            app: best.app,
            appName: getLinuxAppDisplayName(best.app),
            status: best.status,
            pos: Math.round(pos * 100) / 100,
            rawPos: Math.round(pos * 100) / 100,
            start: 0,
            dur: Math.round(dur * 100) / 100,
            canSeek: Boolean(best.canSeek),
            canNext: Boolean(best.canNext),
            canPrev: Boolean(best.canPrev),
            volume: volInfo.volume,
            muted: volInfo.muted,
            volumeScope: volInfo.volumeScope,
            volumeSupported: volInfo.volumeSupported,
            sessions: sessionList,
            coverKey: finalEntry ? coverHash : "",
            coverRev: finalEntry ? (finalEntry.hires ? "hr" : "lo") : "",
            serverTimeMs: Date.now(),
            pinnedApp: pinnedAppId || "",
        };
        this.lastStatus = { ts: Date.now(), data: d };
        return d;
    }

    async control(cmd, extra = {}) {
        const cur = this.lastStatus.data && this.lastStatus.data.title ? this.lastStatus.data : await this.getStatus(true);
        const target = pinnedAppId || (cur && cur.app) || "";
        if (!target) {
            this.lastStatus.ts = 0;
            return { ok: false, error: "no_media_session" };
        }
        if (!isValidMprisTarget(target)) {
            this.lastStatus.ts = 0;
            return { ok: false, error: "invalid_target" };
        }
        const backend = await this._detectMprisBackend();
        let res = { ok: false };

        if (backend === "playerctl") {
            if (cmd === "playpause") res = await runCmdLinux("playerctl", ["-p", target, "play-pause"], 1500);
            else if (cmd === "next") res = await runCmdLinux("playerctl", ["-p", target, "next"], 1500);
            else if (cmd === "prev") res = await runCmdLinux("playerctl", ["-p", target, "previous"], 1500);
            else if (cmd === "seek") {
                const sec = Math.max(0, Number(extra.sec) || 0);
                res = await runCmdLinux("playerctl", ["-p", target, "position", String(sec)], 1500);
            }
        } else if (backend === "gdbus") {
            const busName = target.startsWith("org.mpris.MediaPlayer2.") ? target : `org.mpris.MediaPlayer2.${target}`;
            const methodMap = { playpause: "PlayPause", next: "Next", prev: "Previous" };
            if (methodMap[cmd]) {
                res = await runCmdLinux("gdbus", [
                    "call", "--session", "--dest", busName,
                    "--object-path", "/org/mpris/MediaPlayer2",
                    "--method", `org.mpris.MediaPlayer2.Player.${methodMap[cmd]}`,
                ], 1500);
            } else if (cmd === "seek") {
                const rawTrackId = this._trackIdByPlayer.get(busName) || "";
                const trackId = isValidDbusObjectPath(rawTrackId) ? rawTrackId : "/org/mpris/MediaPlayer2/TrackList/NoTrack";
                const sec = Math.max(0, Number(extra.sec) || 0);
                const usec = Math.round(sec * 1e6);
                res = await runCmdLinux("gdbus", [
                    "call", "--session", "--dest", busName,
                    "--object-path", "/org/mpris/MediaPlayer2",
                    "--method", "org.mpris.MediaPlayer2.Player.SetPosition",
                    "--", trackId, String(usec),
                ], 1500);
            }
        }

        this.lastStatus.ts = 0;
        if (cmd === "seek") {
            return { ok: true, sought: Boolean(res.ok), sec: Math.max(0, Number(extra.sec) || 0) };
        }
        return { ok: Boolean(res.ok), error: res.ok ? null : "control_unsupported" };
    }

    async setVolume(opts = {}) {
        const appHint = pinnedAppId || (this.lastStatus.data && this.lastStatus.data.app) || "";
        const vArg = opts.volume !== undefined && Number.isFinite(Number(opts.volume))
            ? Math.max(0, Math.min(100, Math.round(Number(opts.volume))))
            : -1;
        const mArg = typeof opts.muted === "boolean" ? (opts.muted ? 1 : 0) : -1;
        const resp = await this._setVolumeInfo(appHint, vArg, mArg);
        if (resp && resp.ok && this.lastStatus.data) {
            this.lastStatus.data.volume = resp.volume;
            this.lastStatus.data.muted = resp.muted;
            this.lastStatus.data.volumeScope = resp.volumeScope;
        }
        return resp;
    }

    selectSession(appId) {
        pinnedAppId = String(appId || "");
        this.lastStatus.ts = 0;
        return { ok: true, pinnedApp: pinnedAppId };
    }

    dispose() {}
}

class NoopMediaDaemon {
    async getStatus() { return { sessions: [] }; }
    async control() { return { ok: false, error: "unsupported_platform" }; }
    async setVolume() { return { ok: false, error: "unsupported_platform" }; }
    selectSession(appId) { pinnedAppId = String(appId || ""); return { ok: true, pinnedApp: pinnedAppId }; }
    dispose() {}
}

const daemon = process.platform === "win32"
    ? new MediaDaemon()
    : (process.platform === "linux" ? new LinuxMediaDaemon() : new NoopMediaDaemon());
if (appRef && typeof appRef.on === "function") {
    appRef.on("will-quit", () => daemon.dispose());
}

async function fetchLyrics(artist, title, durationSec = 0) {
    const rawArtist = String(artist || "").trim();
    const rawTitle = String(title || "").trim();
    const dur = Number(durationSec) > 0 ? Math.round(Number(durationSec)) : 0;
    const key = (rawArtist + "||" + rawTitle).toLowerCase();
    if (!rawTitle) return { synced: "", plain: "", found: false };
    const cachedLyrics = getLyricsCached(key);
    if (cachedLyrics) return cachedLyrics;
    if (lyricsInFlight.has(key)) return lyricsInFlight.get(key);

    const task = (async () => {
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
            setLyricsCached(key, res);
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
                    setLyricsCached(key, res);
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
            setLyricsCached(key, res);
            return res;
        }

        const empty = { synced: "", plain: "", found: false };
        setLyricsCached(key, empty);
        return empty;
    })().finally(() => {
        if (lyricsInFlight.get(key) === task) lyricsInFlight.delete(key);
    });

    lyricsInFlight.set(key, task);
    return task;
}

module.exports = {
    mediaDaemon: daemon,
    fetchLyrics,
    getCoverByHash,
    _test: {
        parseGdbusPlayerProps,
        getLinuxAppDisplayName,
        matchesLinuxAudioApp,
        scoreLinuxSession,
        strictDetectImageMime,
        isPrivateOrReservedIp,
        isSafePublicArtUrl,
        httpOrHttpsGetBuffer,
        httpsGetJson,
        httpsGetBuffer,
        isValidMprisTarget,
        isValidDbusObjectPath,
        getLyricsCached,
        setLyricsCached,
        lyricsCache,
        lyricsInFlight,
        MAX_LYRICS_CACHE,
        LYRICS_MISS_TTL_MS,
    },
};
