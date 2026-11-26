export interface RunningProcess {
  pid: number;
  name: string;
}

export interface PatcherStatus {
  antigravityPath: string;
  customizationFound: boolean;
  version: string;
  state: "patched" | "original" | "corrupted" | "not_found";
  hasBackup: boolean;
  asarSize: number;
  wallpaperPath: string;
  wallpaperCount: number;
  runningProcesses: RunningProcess[];
  installedAt: string | null;
}

export interface ModuleOptions {
  antigravityPath: string;
  wallpaper: boolean;
  wallpaperDir: string;
  media: boolean;
  context: boolean;
  i18n: boolean;
  accounts: boolean;
}

export interface DiagnosticsResult {
  writePermission: boolean;
  canElevate?: boolean;
  dryRunPassed: boolean;
  errors: string[];
  backupExists: boolean;
  runningProcesses: RunningProcess[];
}

export interface ProgressEvent {
  stage: string;
  percent: number;
  level: "info" | "success" | "warn" | "error";
}

export interface LogLine {
  id: number;
  time: string;
  text: string;
  level: "info" | "success" | "warn" | "error";
}

export interface ThemeHint {
  backdropDataUrl: string | null;
  accentRgb: string | null;
}
