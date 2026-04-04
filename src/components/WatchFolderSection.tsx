import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { FolderOpen, Plus, Trash2 } from "lucide-react";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import {
  SectionHeader,
  SettingsPanel,
  SettingsPanelRow,
} from "./ui/SettingsSection";

interface WatchFolder {
  path: string;
  status: "watching" | "error";
}

export default function WatchFolderSection() {
  const { t } = useTranslation();
  const [folders, setFolders] = useState<WatchFolder[]>([]);

  const loadFolders = async () => {
    try {
      const result = await window.electronAPI.listWatchFolders();
      setFolders(Array.isArray(result) ? result : []);
    } catch {}
  };

  useEffect(() => {
    loadFolders();

    const cleanup = window.electronAPI.onWatchFolderUpdated((data: { folders: WatchFolder[] }) => {
      if (data?.folders) setFolders(data.folders);
    });
    return cleanup;
  }, []);

  const handleAdd = async () => {
    try {
      const result = await window.electronAPI.selectWatchFolderDir();
      if (result?.canceled || !result?.folderPath) return;
      await window.electronAPI.addWatchFolder(result.folderPath);
      await loadFolders();
    } catch {}
  };

  const handleRemove = async (folderPath: string) => {
    try {
      await window.electronAPI.removeWatchFolder(folderPath);
      await loadFolders();
    } catch {}
  };

  return (
    <div className="space-y-4">
      <SectionHeader
        title={t("watchFolder.sectionTitle")}
        description={t("watchFolder.sectionDescription")}
      />

      <SettingsPanel>
        {folders.length === 0 ? (
          <SettingsPanelRow>
            <p className="text-xs text-foreground">{t("watchFolder.emptyState")}</p>
            <p className="text-xs text-muted-foreground/80 mt-1 leading-relaxed">
              {t("watchFolder.emptyHint")}
            </p>
          </SettingsPanelRow>
        ) : (
          folders.map((folder) => (
            <SettingsPanelRow
              key={folder.path}
              className="flex items-center justify-between gap-3"
            >
              <div className="flex items-center gap-2 min-w-0">
                <FolderOpen className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="text-xs font-mono truncate text-foreground" title={folder.path}>
                  {folder.path}
                </span>
                <Badge
                  variant={folder.status === "watching" ? "default" : "destructive"}
                  className="shrink-0 text-[10px] px-1.5 py-0"
                >
                  {folder.status === "watching"
                    ? t("watchFolder.statusWatching")
                    : t("watchFolder.statusError")}
                </Badge>
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 shrink-0 text-muted-foreground hover:text-destructive"
                onClick={() => handleRemove(folder.path)}
                title={t("watchFolder.remove")}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </SettingsPanelRow>
          ))
        )}

        <SettingsPanelRow>
          <Button variant="outline" size="sm" onClick={handleAdd} className="text-xs h-7">
            <Plus className="h-3.5 w-3.5 mr-1" />
            {t("watchFolder.addFolder")}
          </Button>
        </SettingsPanelRow>
      </SettingsPanel>

      <p className="text-xs text-muted-foreground/70 leading-relaxed">
        {t("watchFolder.footerHint")}
      </p>
    </div>
  );
}
