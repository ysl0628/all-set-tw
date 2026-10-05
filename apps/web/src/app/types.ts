export type PrimaryView = "overview" | "assets" | "activity" | "settings";

export type DetailView = "investments" | "manual-assets";

export type MobileSettingsView =
  | "data-sources"
  | "sync-notifications"
  | "exchange-rates"
  | "classification-rules";

export type View = PrimaryView | DetailView | MobileSettingsView | "more";

export interface RuntimeInfo {
  demoMode: boolean;
}

/** 從資產頁的金融機構前往活動頁時，只顯示該機構帳戶與信用卡的活動。 */
export interface ActivityInstitutionFilter {
  label: string;
  accountIds: string[];
}
